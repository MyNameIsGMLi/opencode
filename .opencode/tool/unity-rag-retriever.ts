import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"

/**
 * Unity RAG 智能检索器
 * 
 * 功能：
 * 1. 多层次混合检索（结构化 + 语义）
 * 2. 智能判断是否需要 IDA
 * 3. 生成优化的 AI Prompt
 */

export default tool({
  description: `Unity RAG 智能检索器 - 为代码生成提供最优上下文。

自动检索并组装：
- 目标类的完整定义
- 基类和接口实现
- 相似的已验证代码
- IDA 伪代码（按需）
- 使用示例和模式`,

  args: {
    projectDir: tool.schema.string().describe("Unity 项目根目录"),
    className: tool.schema.string().describe("要实现的类名"),
    forceIDA: tool.schema.boolean().optional().describe("强制获取 IDA 分析（默认智能判断）"),
    verbose: tool.schema.boolean().optional().describe("显示详细检索过程"),
  },

  async execute(args, ctx) {
    const ragDir = path.join(args.projectDir, ".opencode", "rag")
    const indexPath = path.join(ragDir, "index.json")

    // 加载索引
    let index: any
    try {
      const content = await fs.readFile(indexPath, "utf-8")
      index = JSON.parse(content)
    } catch {
      return {
        error: "RAG 索引不存在，请先运行: unity-rag-core --action=index",
      }
    }

    const retrievalLog: string[] = []
    const log = (msg: string) => {
      if (args.verbose) retrievalLog.push(msg)
    }

    // ==================== 阶段 1: 查找目标类 ====================
    log(`[1/6] 查找目标类: ${args.className}`)

    const targetChunk = index.chunks.find(
      (c: any) => c.type === "class" && (c.metadata.className === args.className || c.metadata.fullName?.endsWith(`.${args.className}`)),
    )

    if (!targetChunk) {
      return {
        error: `未找到类: ${args.className}`,
        suggestion: "请检查类名是否正确，或使用 search 操作查找",
      }
    }

    log(`✓ 找到: ${targetChunk.metadata.fullName}`)

    // ==================== 阶段 2: 智能判断是否需要 IDA ====================
    log(`[2/6] 智能判断是否需要 IDA`)

    const needsIDA = args.forceIDA || judgeNeedsIDA(targetChunk, index)
    log(`✓ 判断结果: ${needsIDA ? "需要 IDA" : "不需要 IDA"}`)

    // ==================== 阶段 3: 检索依赖类 ====================
    log(`[3/6] 检索依赖类（基类、接口）`)

    const dependencies: any[] = []
    const deps = targetChunk.metadata.dependencies || []

    for (const dep of deps) {
      const depChunk = index.chunks.find(
        (c: any) => c.type === "class" && (c.metadata.fullName === dep || c.metadata.className === dep),
      )
      if (depChunk) {
        dependencies.push(depChunk)

        // 如果依赖类已有验证实现，也获取
        const verifiedDep = index.chunks.find((c: any) => c.type === "verified" && c.metadata.className === dep)
        if (verifiedDep) {
          dependencies.push(verifiedDep)
        }
      }
    }

    log(`✓ 找到 ${dependencies.length} 个依赖`)

    // ==================== 阶段 4: 检索相似的已验证类 ====================
    log(`[4/6] 检索相似的已验证代码`)

    const similarVerified = index.chunks
      .filter((c: any) => {
        if (c.type !== "verified") return false
        if (c.metadata.className === args.className) return false

        // 同命名空间
        if (c.metadata.namespace === targetChunk.metadata.namespace) return true

        // 相似名称（后缀相同）
        const targetSuffix = args.className.replace(/.*[A-Z]/, "")
        const candidateSuffix = c.metadata.className?.replace(/.*[A-Z]/, "")
        if (targetSuffix.length > 3 && targetSuffix === candidateSuffix) return true

        return false
      })
      .slice(0, 3)

    log(`✓ 找到 ${similarVerified.length} 个相似已验证类`)

    // ==================== 阶段 5: 检索 IDA 分析（如果需要）====================
    let idaData = null

    if (needsIDA) {
      log(`[5/6] 检索 IDA 分析`)

      idaData = index.chunks.find((c: any) => c.type === "ida" && c.metadata.className === args.className)

      if (idaData) {
        log(`✓ 找到已缓存的 IDA 分析`)
      } else {
        log(`⚠ 未找到 IDA 分析，需要按需获取`)
      }
    } else {
      log(`[5/6] 跳过 IDA 分析（不需要）`)
    }

    // ==================== 阶段 6: 检测设计模式 ====================
    log(`[6/6] 检测设计模式`)

    const patterns = detectPatterns(targetChunk, index)
    log(`✓ 检测到 ${patterns.length} 个模式`)

    // ==================== 生成优化的 Prompt ====================

    const context = {
      targetClass: targetChunk,
      dependencies,
      similarVerified,
      idaData,
      patterns,
      needsIDA,
    }

    const prompt = generatePrompt(context)

    // ==================== 返回结果 ====================

    const summary = `✅ 智能检索完成: ${args.className}

📊 检索统计:
- 目标类: ${targetChunk.metadata.fullName}
- 依赖类: ${dependencies.length}
- 相似已验证: ${similarVerified.length}
- IDA 分析: ${idaData ? "✓ 已缓存" : needsIDA ? "⚠ 需要获取" : "✗ 不需要"}
- 设计模式: ${patterns.length}

🎯 推荐策略:
${needsIDA && !idaData ? "⚠ 建议先获取 IDA 分析以提高准确率" : "✓ 可直接生成代码"}

${args.verbose ? `\n📝 检索日志:\n${retrievalLog.join("\n")}` : ""}`

    return {
      output: summary,
      context,
      prompt,
      needsIDAFetch: needsIDA && !idaData,
    }
  },
})

// ==================== 智能判断逻辑 ====================

function judgeNeedsIDA(targetChunk: any, index: any): boolean {
  const className = targetChunk.metadata.className || ""
  const fullName = targetChunk.metadata.fullName || ""
  const complexity = targetChunk.metadata.complexity || 0

  // 规则 1: 关键词匹配（加密、网络、算法等）
  const highRiskKeywords = [
    /Encrypt/i,
    /Decrypt/i,
    /Hash/i,
    /Compress/i,
    /Network/i,
    /Protocol/i,
    /Serialize/i,
    /Calculate.*Damage/i,
    /AI.*Decision/i,
    /Pathfind/i,
    /Sync/i,
  ]

  for (const pattern of highRiskKeywords) {
    if (pattern.test(className) || pattern.test(fullName)) {
      return true
    }
  }

  // 规则 2: 复杂度判断
  if (complexity > 80) {
    return true
  }

  // 规则 3: 方法数量
  const methodCount = targetChunk.metadata.methodCount || 0
  if (methodCount > 20) {
    return true
  }

  // 规则 4: 检查相似类是否用了 IDA
  const namespace = targetChunk.metadata.namespace
  const similarClasses = index.chunks.filter(
    (c: any) => c.type === "verified" && c.metadata.namespace === namespace && c.metadata.usedIDA === true,
  )

  if (similarClasses.length > 0) {
    return true
  }

  return false
}

// ==================== 模式检测 ====================

function detectPatterns(targetChunk: any, index: any): Array<{ name: string; description: string; evidence: string }> {
  const patterns: Array<{ name: string; description: string; evidence: string }> = []
  const className = targetChunk.metadata.className || ""

  // 模式 1: 单例
  if (className.includes("Manager") || className.includes("Service") || className.includes("System")) {
    const hasInstance = targetChunk.metadata.fields?.some((f: any) => f.name === "Instance" || f.name === "_instance")
    if (hasInstance) {
      patterns.push({
        name: "Singleton",
        description: "单例模式 - 全局唯一实例",
        evidence: "检测到 Instance 字段和 Manager/Service 命名",
      })
    }
  }

  // 模式 2: 对象池
  if (className.includes("Pool")) {
    patterns.push({
      name: "ObjectPool",
      description: "对象池模式 - 复用对象避免 GC",
      evidence: "类名包含 Pool",
    })
  }

  // 模式 3: 观察者
  if (className.includes("Event") || className.includes("Listener")) {
    patterns.push({
      name: "Observer",
      description: "观察者模式 - 事件订阅/发布",
      evidence: "类名包含 Event/Listener",
    })
  }

  // 模式 4: 工厂
  if (className.includes("Factory") || className.includes("Builder")) {
    patterns.push({
      name: "Factory",
      description: "工厂模式 - 对象创建封装",
      evidence: "类名包含 Factory/Builder",
    })
  }

  // 模式 5: Unity 组件
  const baseClass = targetChunk.metadata.baseClass
  if (baseClass === "MonoBehaviour" || baseClass === "ScriptableObject") {
    patterns.push({
      name: "UnityComponent",
      description: `Unity ${baseClass} 组件`,
      evidence: `继承自 ${baseClass}`,
    })
  }

  return patterns
}

// ==================== Prompt 生成 ====================

function generatePrompt(context: any): string {
  const { targetClass, dependencies, similarVerified, idaData, patterns } = context

  let prompt = `# 任务：重建 Unity C# 类

## 目标类
\`\`\`csharp
${targetClass.content}
\`\`\`

**完整路径**: ${targetClass.metadata.fullName}
**命名空间**: ${targetClass.metadata.namespace}
**字段数**: ${targetClass.metadata.fieldCount}
**方法数**: ${targetClass.metadata.methodCount}
**复杂度**: ${targetClass.metadata.complexity}

`

  // 添加基类参考
  if (dependencies.length > 0) {
    prompt += `## 依赖类参考\n\n`
    for (const dep of dependencies.slice(0, 3)) {
      if (dep.type === "verified") {
        prompt += `### ${dep.metadata.className} (已验证实现)\n\`\`\`csharp\n${dep.content.slice(0, 500)}\n...\n\`\`\`\n\n`
      } else {
        prompt += `### ${dep.metadata.className || dep.metadata.fullName}\n\`\`\`csharp\n${dep.content}\n\`\`\`\n\n`
      }
    }
  }

  // 添加相似已验证类
  if (similarVerified.length > 0) {
    prompt += `## 相似的已验证实现（参考）\n\n`
    for (const similar of similarVerified) {
      prompt += `### ${similar.metadata.className}\n`
      prompt += `命名空间: ${similar.metadata.namespace}\n`
      prompt += `\`\`\`csharp\n${similar.content.slice(0, 800)}\n...\n\`\`\`\n\n`
    }
  }

  // 添加 IDA 伪代码
  if (idaData) {
    prompt += `## IDA Pro 伪代码（真实逻辑）\n\n`
    prompt += `**重要**: 以下是从二进制反编译的真实代码逻辑，请严格参考实现。\n\n`
    prompt += `\`\`\`c\n${idaData.content.slice(0, 2000)}\n\`\`\`\n\n`
  }

  // 添加设计模式
  if (patterns.length > 0) {
    prompt += `## 检测到的设计模式\n\n`
    for (const pattern of patterns) {
      prompt += `### ${pattern.name}\n`
      prompt += `${pattern.description}\n`
      prompt += `证据: ${pattern.evidence}\n\n`
    }
  }

  // 添加约束
  prompt += `## 实现要求

1. **零 TODO/Stub**: 所有方法必须有完整实现，不允许空方法或 TODO 注释
2. **命名一致**: 字段名、方法名必须与 dump.cs 完全一致
3. **Unity 生命周期**: 如果继承 MonoBehaviour，正确实现 Awake/Start/Update 等
4. **设计模式**: 遵循检测到的设计模式实现
${idaData ? "5. **IDA 逻辑优先**: 有 IDA 伪代码的方法，必须按伪代码逻辑实现\n" : ""}

## 输出格式

直接输出完整的 C# 代码，包含：
- 正确的命名空间
- 所有 using 引用
- 完整的类实现
- 所有字段初始化
- 所有方法的完整逻辑

开始生成：
`

  return prompt
}
