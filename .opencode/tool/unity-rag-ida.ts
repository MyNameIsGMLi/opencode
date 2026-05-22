import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"
import { loadProjectConfig, resolveScriptJsonPath } from "./unity-project-config"
import {
  isV2, migrateV1toV2, decompressArray, compressArray,
} from "./unity-rag-cache"

/**
 * Unity RAG IDA 集成
 * 
 * 功能：
 * 1. 按需获取 IDA 分析（而非全量）
 * 2. 智能批量获取（对同模块的类一起分析）
 * 3. 自动缓存到 RAG
 */

export default tool({
  description: `Unity RAG IDA 集成 - 按需获取和缓存 IDA 伪代码。

支持模式：
- single: 分析单个类
- batch: 批量分析模块
- smart: 智能判断需要分析的类`,

  args: {
    mode: tool.schema.enum(["single", "batch", "smart"]).describe("分析模式"),

    projectDir: tool.schema.string().describe("Unity 项目根目录"),

    className: tool.schema.string().optional().describe("类名（single 模式）"),

    moduleName: tool.schema.string().optional().describe("模块名（batch 模式）"),

    idaRpcUrl: tool.schema.string().optional().describe("IDA RPC 服务器 URL（默认 http://localhost:7734）"),

    maxClasses: tool.schema.number().optional().describe("最多分析多少个类（默认 50）"),

    dryRun: tool.schema.boolean().optional().describe("仅显示计划，不实际调用 IDA"),
  },

  async execute(args, ctx) {
    const ragDir = path.join(args.projectDir, ".opencode", "rag")
    const indexPath = path.join(ragDir, "index.json")
    const idaRpcUrl = args.idaRpcUrl || "http://localhost:7734"

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

    let targetClasses: string[] = []

    // ==================== 确定要分析的类 ====================

    if (args.mode === "single") {
      if (!args.className) {
        return { error: "single 模式需要 --className 参数" }
      }
      targetClasses = [args.className]
    } else if (args.mode === "batch") {
      if (!args.moduleName) {
        return { error: "batch 模式需要 --moduleName 参数" }
      }

      // 查找模块下的所有类
      const moduleChunk = index.hotChunks.modules.find((c: any) => c.metadata.moduleName === args.moduleName)

      if (!moduleChunk) {
        return { error: `未找到模块: ${args.moduleName}` }
      }

      targetClasses = moduleChunk.metadata.classes || []
    } else if (args.mode === "smart") {
      // 智能模式：分析所有需要但未缓存 IDA 的类
      const allClasses = index.hotChunks.classes

      for (const cls of allClasses) {
        const className = cls.metadata.className

        // 检查是否已有 IDA 缓存（从冷数据 blob 中查找）
        const cachedIdaChunks = decompressArray(index.coldChunks.idaBlob)
        const hasIDA = cachedIdaChunks.some((c: any) => c.metadata?.className === className)

        if (!hasIDA) {
          // 判断是否需要 IDA（传入已验证代码供规则4使用）
          const needsIDA = judgeNeedsIDA(cls, index.hotChunks.verified)
          if (needsIDA) {
            targetClasses.push(className)
          }
        }
      }

      // 限制数量
      const maxClasses = args.maxClasses || 50
      if (targetClasses.length > maxClasses) {
        targetClasses = targetClasses.slice(0, maxClasses)
      }
    }

    if (targetClasses.length === 0) {
      return {
        output: "✅ 没有需要分析的类（都已缓存或不需要 IDA）",
      }
    }

    // ==================== Dry Run ====================

    if (args.dryRun) {
      return {
        output: `📋 分析计划（Dry Run）

模式: ${args.mode}
目标类数: ${targetClasses.length}
IDA 服务器: ${idaRpcUrl}

将分析的类:
${targetClasses.map((c, i) => `${i + 1}. ${c}`).join("\n")}

预计耗时: ~${(targetClasses.length * 2) / 60} 分钟（假设 2 秒/类）

运行命令（移除 --dryRun）开始分析。`,
        targetClasses,
      }
    }

    // ==================== 检查 IDA 连接 ====================

    let serverStatus
    try {
      const result = await ctx.bash(`curl -s -X POST ${idaRpcUrl}/ping -m 5`)
      serverStatus = JSON.parse(result)

      if (serverStatus.status !== "ok") {
        return {
          error: `IDA RPC 服务器未就绪: ${idaRpcUrl}`,
          suggestion: "请确保 IDA Pro 正在运行且 RPC 插件已加载",
        }
      }
    } catch (error) {
      return {
        error: `无法连接到 IDA RPC: ${idaRpcUrl}`,
        details: String(error),
        suggestion: "请检查 IDA Pro 是否启动，RPC 服务器是否运行",
      }
    }

    // ==================== 批量获取 IDA 分析 ====================

    // 读取 script.json（在循环外，只读一次）
    const config = await loadProjectConfig(args.projectDir)
    const scriptJsonPath = resolveScriptJsonPath(args.projectDir, config)
    let scriptJson: any
    try {
      const scriptContent = await Bun.file(scriptJsonPath).text()
      scriptJson = JSON.parse(scriptContent)
    } catch {
      return { error: "无法读取 script.json" }
    }

    const results: Array<{ className: string; success: boolean; error?: string }> = []
    let successCount = 0
    let failCount = 0

    for (let i = 0; i < targetClasses.length; i++) {
      const className = targetClasses[i]

      try {
        // 查找类信息
        const classChunk = index.hotChunks.classes.find(
          (c: any) => c.metadata.className === className || c.metadata.fullName?.endsWith(`.${className}`),
        )

        if (!classChunk) {
          results.push({ className, success: false, error: "类不存在" })
          failCount++
          continue
        }

        const methods = scriptJson.ScriptMethod || []
        const classMethods = methods.filter((m: any) => m.Name?.startsWith(classChunk.metadata.fullName + "::"))

        if (classMethods.length === 0) {
          results.push({ className, success: false, error: "未找到方法地址" })
          failCount++
          continue
        }

        // 分析前 3 个方法（避免过长）
        const methodsToAnalyze = classMethods.slice(0, 3)
        const pseudocodeList: string[] = []

        for (const method of methodsToAnalyze) {
          const address = method.Address
          if (!address || address === "0x0") continue

          try {
            const decompileResult = await ctx.bash(
              `curl -s -X POST ${idaRpcUrl}/decompile -H "Content-Type: application/json" -d '{"address": "${address}"}' -m 30`,
            )

            const result = JSON.parse(decompileResult)

            if (result.pseudocode || result.code) {
              pseudocodeList.push(`// ${method.Name}\n${result.pseudocode || result.code}`)
            }
          } catch (error) {
            // 单个方法失败不影响整体
            pseudocodeList.push(`// ${method.Name}\n// IDA 分析失败`)
          }

          // 延迟避免过载
          await new Promise((resolve) => setTimeout(resolve, 200))
        }

        // 保存到 RAG
        const idaChunk = {
          id: `ida:${className}`,
          type: "ida",
          content: pseudocodeList.join("\n\n"),
          metadata: {
            className,
            fullName: classChunk.metadata.fullName,
            methodCount: methodsToAnalyze.length,
            fetchedAt: new Date().toISOString(),
          },
        }

        // 更新冷数据 idaBlob（解压 → 更新/追加 → 重压）
        const idaChunks = decompressArray(index.coldChunks.idaBlob)
        const existingIdx = idaChunks.findIndex((c: any) => c.id === idaChunk.id)
        if (existingIdx >= 0) {
          idaChunks[existingIdx] = idaChunk
        } else {
          idaChunks.push(idaChunk)
        }
        index.coldChunks.idaBlob = compressArray(idaChunks)
        index.coldChunks.idaCount = idaChunks.length
        index.stats.idaAnalyzed = idaChunks.length

        results.push({ className, success: true })
        successCount++

        // 进度显示
        if ((i + 1) % 10 === 0 || i + 1 === targetClasses.length) {
          console.log(`进度: ${i + 1}/${targetClasses.length} (成功: ${successCount}, 失败: ${failCount})`)
        }
      } catch (error) {
        results.push({ className, success: false, error: String(error) })
        failCount++
      }
    }

    // 保存更新后的索引
    index.updatedAt = new Date().toISOString()
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf-8")

    // ==================== 返回结果 ====================

    const failedClasses = results.filter((r) => !r.success)

    return {
      output: `✅ IDA 批量分析完成

📊 统计:
- 总数: ${targetClasses.length}
- 成功: ${successCount}
- 失败: ${failCount}
- 成功率: ${((successCount / targetClasses.length) * 100).toFixed(1)}%

${
  failedClasses.length > 0
    ? `\n⚠️ 失败的类:\n${failedClasses.map((f) => `- ${f.className}: ${f.error}`).join("\n")}`
    : ""
}

💾 已更新 RAG 索引: ${indexPath}`,
      stats: {
        total: targetClasses.length,
        success: successCount,
        failed: failCount,
        successRate: (successCount / targetClasses.length) * 100,
      },
      results,
    }
  },
})

// ==================== 辅助函数 ====================

// 注意：P1 阶段会将此函数提取为共享函数，目前先在此文件内对齐规则
function judgeNeedsIDA(classChunk: any, allVerified: any[] = []): boolean {
  const className = classChunk.metadata.className || ""
  const fullName = classChunk.metadata.fullName || ""
  const complexity = classChunk.metadata.complexity || 0
  const methodCount = classChunk.metadata.methodCount || 0

  const keywords = [
    /Encrypt/i, /Decrypt/i, /Hash/i, /Compress/i,
    /Network/i, /Protocol/i, /Serialize/i,
    /Calculate.*Damage/i, /AI/i, /Pathfind/i, /Sync/i,
  ]
  if (keywords.some(k => k.test(className) || k.test(fullName))) return true
  if (complexity > 80) return true
  if (methodCount > 20) return true
  // 规则4：同命名空间相似类已使用 IDA
  const ns = classChunk.metadata.namespace
  return allVerified.some((v: any) => v.metadata?.namespace === ns && v.metadata?.usedIDA === true)
}
