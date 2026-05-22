import { tool } from "@opencode-ai/plugin"
import * as path from "path"
import { isV2, migrateV1toV2 } from "./unity-rag-cache"

/**
 * Unity RAG 学习工具
 * 
 * 功能：
 * 1. 从生成的代码中学习
 * 2. 编译验证后加入知识库
 * 3. 自动提取设计模式
 */

export default tool({
  description: `Unity RAG 学习工具 - 将成功生成的代码加入知识库，实现增量学习。

功能：
- 验证代码编译成功后加入 RAG
- 自动提取代码模式和风格
- 为后续类提供参考`,

  args: {
    projectDir: tool.schema.string().describe("Unity 项目根目录"),

    className: tool.schema.string().describe("类名"),

    codePath: tool.schema.string().describe("生成的代码文件路径"),

    compileSuccess: tool.schema.boolean().optional().describe("是否编译成功（默认需验证）"),

    extractPatterns: tool.schema.boolean().optional().describe("是否提取设计模式（默认 true）"),
  },

  async execute(args, ctx) {
    const ragDir = path.join(args.projectDir, ".opencode", "rag")
    const indexPath = path.join(ragDir, "index.json")

    // 加载 RAG 索引
    let index: any
    try {
      const raw = JSON.parse(await Bun.file(indexPath).text())
      index = isV2(raw) ? raw : migrateV1toV2(raw)
    } catch {
      return {
        error: "RAG 索引不存在，请先运行: unity-rag-core --action=index",
      }
    }

    // 读取代码
    let code: string
    try {
      code = await Bun.file(args.codePath).text()
    } catch (error) {
      return {
        error: `无法读取代码文件: ${args.codePath}`,
        details: String(error),
      }
    }

    // 验证编译（如果未提供）
    let compileSuccess = args.compileSuccess

    if (compileSuccess === undefined) {
      // 简单验证：检查是否有完整的类定义
      const hasClass = code.includes(`class ${args.className}`) || code.includes(`struct ${args.className}`)
      const hasNamespace = code.includes("namespace ")
      const hasClosingBrace = code.trim().endsWith("}")

      compileSuccess = hasClass && hasNamespace && hasClosingBrace

      if (!compileSuccess) {
        return {
          error: "代码格式不完整，无法加入知识库",
          suggestion: "请确保代码编译通过后再添加",
        }
      }
    }

    // 提取元数据
    const metadata = extractMetadata(code, args.className)

    // 提取模式
    let patterns: Array<{ name: string; evidence: string }> = []
    if (args.extractPatterns !== false) {
      patterns = extractPatterns(code)
    }

    // 创建 verified chunk
    const verifiedChunk = {
      id: `verified:${args.className}`,
      type: "verified",
      content: code,
      metadata: {
        className: args.className,
        ...metadata,
        verified: compileSuccess,
        verifiedAt: new Date().toISOString(),
        patterns: patterns.map((p) => p.name),
        usedIDA: metadata.hasIDAComment,
      },
    }

    // 更新热数据 hotChunks.verified（v2 格式）
    const existingIdx = index.hotChunks.verified.findIndex((c: any) => c.id === verifiedChunk.id)
    if (existingIdx >= 0) {
      index.hotChunks.verified[existingIdx] = verifiedChunk
    } else {
      index.hotChunks.verified.push(verifiedChunk)
    }
    index.stats.verifiedImplementations = index.hotChunks.verified.length

    // 保存
    index.updatedAt = new Date().toISOString()
    await Bun.write(indexPath, JSON.stringify(index, null, 2))

    return {
      output: `✅ 已加入知识库: ${args.className}

📊 代码分析:
- 命名空间: ${metadata.namespace}
- 基类: ${metadata.baseClass || "无"}
- 字段数: ${metadata.fieldCount}
- 方法数: ${metadata.methodCount}
- 代码行数: ${metadata.lineCount}

${patterns.length > 0 ? `🎯 检测到的模式:\n${patterns.map((p) => `- ${p.name}: ${p.evidence}`).join("\n")}` : ""}

💡 此代码将用于后续类的参考。`,
      metadata,
      patterns,
    }
  },
})

// ==================== 元数据提取 ====================

function extractMetadata(code: string, className: string): any {
  const lines = code.split("\n")

  // 提取命名空间
  const namespaceMatch = code.match(/namespace\s+([\w.]+)/)
  const namespace = namespaceMatch ? namespaceMatch[1] : ""

  // 提取基类
  const baseClassMatch = code.match(new RegExp(`class\\s+${className}\\s*:\\s*(\\w+)`))
  const baseClass = baseClassMatch ? baseClassMatch[1] : null

  // 统计字段
  const fieldMatches = code.match(/(?:public|private|protected)\s+\w+\s+\w+;/g)
  const fieldCount = fieldMatches ? fieldMatches.length : 0

  // 统计方法
  const methodMatches = code.match(/(?:public|private|protected)\s+\w+\s+\w+\([^)]*\)/g)
  const methodCount = methodMatches ? methodMatches.length : 0

  // 检查是否有 IDA 注释
  const hasIDAComment = code.includes("// IDA") || code.includes("// 基于 IDA")

  return {
    namespace,
    baseClass,
    fieldCount,
    methodCount,
    lineCount: lines.length,
    hasIDAComment,
  }
}

// ==================== 模式提取 ====================

function extractPatterns(code: string): Array<{ name: string; evidence: string }> {
  const patterns: Array<{ name: string; evidence: string }> = []

  // 单例模式
  if (code.includes("static") && (code.includes("Instance") || code.includes("_instance"))) {
    patterns.push({
      name: "Singleton",
      evidence: "包含 static Instance 字段",
    })
  }

  // 对象池
  if (code.includes("Stack<") || code.includes("Queue<")) {
    patterns.push({
      name: "ObjectPool",
      evidence: "使用 Stack/Queue 数据结构",
    })
  }

  // MonoBehaviour
  if (code.includes("MonoBehaviour")) {
    const hasAwake = code.includes("void Awake(")
    const hasStart = code.includes("void Start(")
    const hasUpdate = code.includes("void Update(")

    patterns.push({
      name: "MonoBehaviour",
      evidence: `Unity 组件 (${[hasAwake && "Awake", hasStart && "Start", hasUpdate && "Update"].filter(Boolean).join(", ")})`,
    })
  }

  // 事件系统
  if (code.includes("event ") || code.includes("Action<") || code.includes("UnityEvent")) {
    patterns.push({
      name: "Observer",
      evidence: "使用事件/委托",
    })
  }

  // 协程
  if (code.includes("IEnumerator") || code.includes("yield return")) {
    patterns.push({
      name: "Coroutine",
      evidence: "使用协程",
    })
  }

  return patterns
}
