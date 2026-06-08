import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"
import { isV2, migrateV1toV2 } from "./unity-rag-cache"
import { loadProjectConfig, resolveScriptsDir } from "./unity-project-config"
import ragCoreTool from "./unity-rag-core"
import ragIdaTool from "./unity-rag-ida"
import ragRetrieverTool from "./unity-rag-retriever"

async function callTool(toolDef: any, args: any, ctx: any) {
  return toolDef.execute(args, ctx)
}

/**
 * Unity RAG 完整工作流
 * 
 * 一键式执行完整的 RAG 增强逆向流程：
 * 1. 初始化 RAG 索引
 * 2. 智能判断需要 IDA 的类
 * 3. 批量获取 IDA 分析
 * 4. 实现类（集成 RAG）
 * 5. 学习成功案例
 */

export default tool({
  description: `Unity RAG 完整工作流 - 渐进式 RAG 增强的逆向工程。

使用场景：
- init: 初始化新项目的 RAG 索引
- implement: 实现单个类（RAG 增强）
- batch: 批量实现模块
- smart-ida: 智能批量获取 IDA`,

  args: {
    workflow: tool.schema.enum(["init", "implement", "batch", "smart-ida", "status", "auto-implement"]).describe("工作流类型"),

    projectDir: tool.schema.string().describe("Unity 项目根目录"),

    className: tool.schema.string().optional().describe("类名（implement 模式）"),

    moduleName: tool.schema.string().optional().describe("模块名（batch 模式）"),

    idaRpcUrl: tool.schema.string().optional().describe("IDA RPC URL"),

    autoLearn: tool.schema.boolean().optional().describe("自动学习成功的实现（默认 true）"),

    verbose: tool.schema.boolean().optional().describe("显示详细日志"),

    dumpCsPath: tool.schema.string().optional().describe("dump.cs 路径"),
    scriptJsonPath: tool.schema.string().optional().describe("script.json 路径"),
  },

  async execute(args, ctx) {
    const ragDir = path.join(args.projectDir, ".opencode", "rag")

    switch (args.workflow) {
      case "init":
        return await initWorkflow(args, ctx, ragDir)

      case "implement":
        return await implementWorkflow(args, ctx, ragDir)

      case "batch":
        return await batchWorkflow(args, ctx, ragDir)

      case "smart-ida":
        return await smartIdaWorkflow(args, ctx, ragDir)

      case "status":
        return await statusWorkflow(args, ctx, ragDir)

      case "auto-implement":
        return await autoImplementWorkflow(args, ctx, ragDir)

      default:
        return { error: `Unknown workflow: ${args.workflow}` }
    }
  },
})

// ==================== 初始化工作流 ====================

async function initWorkflow(args: any, ctx: any, ragDir: string) {
  const log = (msg: string) => {
    if (args.verbose) console.log(msg)
  }

  log("🚀 开始初始化 RAG 工作流...")

  // Step 1: 创建 RAG 目录
  await fs.mkdir(ragDir, { recursive: true })

  // Step 2: 调用 unity-rag-core 索引
  log("[1/3] 索引静态知识（dump.cs + script.json）...")

  const indexResult = await callTool(ragCoreTool, {
    action: "index",
    projectDir: args.projectDir,
    force: true,
    dumpCsPath: args.dumpCsPath,
    scriptJsonPath: args.scriptJsonPath,
  }, ctx)

  if (indexResult.error) {
    return { error: `索引失败: ${indexResult.error}` }
  }

  log(`✓ 索引完成: ${indexResult.stats.totalClasses} 个类`)

  // Step 3: 智能判断需要 IDA 的类
  log("[2/3] 智能判断需要 IDA 分析的类...")

  const idaPlanResult = await callTool(ragIdaTool, {
    mode: "smart",
    projectDir: args.projectDir,
    dryRun: true,
  }, ctx)

  const needsIdaCount = idaPlanResult.targetClasses?.length || 0

  log(`✓ 检测到 ${needsIdaCount} 个类需要 IDA 分析`)

  // Step 4: 生成报告
  const report = `✅ RAG 初始化完成！

📊 知识库统计:
- 总类数: ${indexResult.stats.totalClasses}
- 总方法数: ${indexResult.stats.totalMethods}
- 需要 IDA 分析: ${needsIdaCount} 个类 (${((needsIdaCount / indexResult.stats.totalClasses) * 100).toFixed(1)}%)

💡 下一步:
${
  needsIdaCount > 0
    ? `1. 启动 IDA Pro 并加载二进制文件
2. 运行: unity-rag-workflow --workflow=smart-ida
3. 开始实现类: unity-rag-workflow --workflow=implement --className=YourClass`
    : `直接开始实现: unity-rag-workflow --workflow=implement --className=YourClass`
}

📁 RAG 索引位置: ${ragDir}/index.json`

  return {
    output: report,
    stats: indexResult.stats,
    needsIdaCount,
  }
}

// ==================== 单类实现工作流 ====================

async function implementWorkflow(args: any, ctx: any, ragDir: string) {
  if (!args.className) {
    return { error: "implement 工作流需要 --className 参数" }
  }

  const log = (msg: string) => {
    if (args.verbose) console.log(msg)
  }

  log(`🎯 开始实现类: ${args.className}`)

  // Step 1: 智能检索上下文
  log("[1/4] 智能检索相关上下文...")

  const retrieveResult = await callTool(ragRetrieverTool, {
    projectDir: args.projectDir,
    className: args.className,
    verbose: args.verbose,
  }, ctx)

  if (retrieveResult.error) {
    return { error: retrieveResult.error }
  }

  log(`✓ 检索完成`)

  // Step 2: 检查是否需要获取 IDA
  if (retrieveResult.needsIDAFetch) {
    log("[2/4] 需要 IDA 分析，正在获取...")

    const idaResult = await callTool(ragIdaTool, {
      mode: "single",
      projectDir: args.projectDir,
      className: args.className,
      idaRpcUrl: args.idaRpcUrl,
    }, ctx)

    if (idaResult.error) {
      log(`⚠ IDA 获取失败: ${idaResult.error}`)
      log(`将继续使用现有上下文生成代码`)
    } else {
      log(`✓ IDA 分析已获取并缓存`)

      // 重新检索（包含新的 IDA 数据）
      const newRetrieveResult = await callTool(ragRetrieverTool, {
        projectDir: args.projectDir,
        className: args.className,
      }, ctx)

      if (!newRetrieveResult.error) {
        retrieveResult.context = newRetrieveResult.context
        retrieveResult.prompt = newRetrieveResult.prompt
      }
    }
  } else {
    log("[2/4] 跳过 IDA（不需要）")
  }

  // Step 3: 返回优化的 Prompt
  log("[3/4] 生成 AI Prompt...")

  const config = await loadProjectConfig(args.projectDir)
  const scriptsDir = resolveScriptsDir(args.projectDir, config)
  const outputPath = path.join(scriptsDir, `${args.className}.cs`)

  return {
    output: `✅ RAG 检索完成: ${args.className}

${retrieveResult.output}

📝 优化的 AI Prompt 已生成

💡 下一步:
1. 使用以下 Prompt 让 AI 生成代码
2. 保存到: ${outputPath}
3. 编译验证
4. ${args.autoLearn !== false ? "成功后自动加入知识库" : ""}

---

${retrieveResult.prompt}`,
    context: retrieveResult.context,
    prompt: retrieveResult.prompt,
    outputPath,
  }
}

// ==================== 批量实现工作流 ====================

async function batchWorkflow(args: any, ctx: any, ragDir: string) {
  if (!args.moduleName) {
    return { error: "batch 工作流需要 --moduleName 参数" }
  }

  const log = (msg: string) => {
    if (args.verbose) console.log(msg)
  }

  log(`📦 开始批量实现模块: ${args.moduleName}`)

  // Step 1: 查找模块下的类
  const indexPath = path.join(ragDir, "index.json")
  let index: any
  try {
    const raw = JSON.parse(await Bun.file(indexPath).text())
    index = isV2(raw) ? raw : migrateV1toV2(raw)
  } catch {
    return { error: "RAG 索引不存在，请先运行 init 工作流" }
  }

  const moduleChunk = index.hotChunks.modules.find((c: any) => c.metadata.moduleName === args.moduleName)

  if (!moduleChunk) {
    return { error: `未找到模块: ${args.moduleName}` }
  }

  const classNames = moduleChunk.metadata.classes || []

  log(`找到 ${classNames.length} 个类`)

  // Step 2: 批量获取 IDA（如果需要）
  log("[1/2] 批量获取 IDA 分析...")

  const idaResult = await callTool(ragIdaTool, {
    mode: "batch",
    projectDir: args.projectDir,
    moduleName: args.moduleName,
    idaRpcUrl: args.idaRpcUrl,
  }, ctx)

  if (idaResult.error) {
    log(`⚠ IDA 批量获取失败: ${idaResult.error}`)
  } else {
    log(`✓ IDA 批量分析完成: ${idaResult.stats.success}/${idaResult.stats.total}`)
  }

  // Step 3: 返回实现计划
  return {
    output: `✅ 批量工作流准备完成: ${args.moduleName}

📊 模块统计:
- 总类数: ${classNames.length}
- IDA 分析: ${idaResult.stats?.success || 0} 个

📋 类列表:
${classNames.map((c: string, i: number) => `${i + 1}. ${c}`).join("\n")}

💡 下一步:
逐个实现类，使用:
unity-rag-workflow --workflow=implement --className=<ClassName>`,
    classNames,
    moduleStats: {
      total: classNames.length,
      idaAnalyzed: idaResult.stats?.success || 0,
    },
  }
}

// ==================== 智能 IDA 工作流 ====================

async function smartIdaWorkflow(args: any, ctx: any, ragDir: string) {
  const log = (msg: string) => {
    if (args.verbose) console.log(msg)
  }

  log("🤖 开始智能 IDA 批量分析...")

  const idaResult = await callTool(ragIdaTool, {
    mode: "smart",
    projectDir: args.projectDir,
    idaRpcUrl: args.idaRpcUrl,
  }, ctx)

  if (idaResult.error) {
    return { error: idaResult.error }
  }

  return {
    output: idaResult.output,
    stats: idaResult.stats,
  }
}

// ==================== 状态工作流 ====================

async function statusWorkflow(args: any, ctx: any, ragDir: string) {
  const statsResult = await callTool(ragCoreTool, {
    action: "stats",
    projectDir: args.projectDir,
  }, ctx)

  if (statsResult.error) {
    return { error: statsResult.error }
  }

  // 额外分析
  const indexPath = path.join(ragDir, "index.json")
  let index: any
  try {
    const raw = JSON.parse(await Bun.file(indexPath).text())
    index = isV2(raw) ? raw : migrateV1toV2(raw)
  } catch {
    return { error: "RAG 索引不存在" }
  }

  // 计算进度（防除零）
  const totalClasses = index.stats?.totalClasses ?? 0
  const verifiedClasses = index.stats?.verifiedImplementations ?? 0
  const progress = totalClasses === 0 ? "0.0" : ((verifiedClasses / totalClasses) * 100).toFixed(1)

  // 估算剩余时间
  const remainingClasses = totalClasses - verifiedClasses
  const avgTimePerClass = 5 // 分钟（估计）
  const estimatedHours = (remainingClasses * avgTimePerClass) / 60

  return {
    output: `${statsResult.output}

📈 实现进度:
- 已完成: ${verifiedClasses}/${totalClasses} (${progress}%)
- 剩余: ${remainingClasses}
- 预计耗时: ${estimatedHours.toFixed(1)} 小时

💡 建议:
${
  (index.stats?.idaAnalyzed ?? 0) < totalClasses * 0.1
    ? "- 考虑运行 smart-ida 工作流获取关键类的 IDA 分析"
    : "- IDA 覆盖率良好"
}
${verifiedClasses > 100 ? "- 知识库已积累足够案例，后续生成准确率会更高" : "- 继续实现更多类以积累经验"}`,
    stats: {
      ...statsResult.stats,
      progress: parseFloat(progress),
      remaining: remainingClasses,
      estimatedHours,
    },
  }
}

// ==================== 全自动实现工作流 ====================

async function autoImplementWorkflow(args: any, ctx: any, ragDir: string) {
  if (!args.className) {
    return { error: "auto-implement 工作流需要 --className 参数" }
  }

  const log = (msg: string) => {
    if (args.verbose) console.log(msg)
  }

  log(`🤖 全自动实现: ${args.className}`)

  // Step 1: Context 构建（智能检索）
  log("[1/3] 检索 Context...")
  let retrieveResult = await callTool(ragRetrieverTool, {
    projectDir: args.projectDir,
    className: args.className,
    verbose: args.verbose,
  }, ctx)

  if (retrieveResult.error) {
    return { error: retrieveResult.error }
  }

  // Step 2: IDA 获取（如需要）
  if (retrieveResult.needsIDAFetch) {
    log("[2/3] 需要 IDA，正在获取...")
    const idaResult = await callTool(ragIdaTool, {
      mode: "single",
      projectDir: args.projectDir,
      className: args.className,
      idaRpcUrl: args.idaRpcUrl,
    }, ctx)

    if (!idaResult.error) {
      log("✓ IDA 已获取，重新检索 Context...")
      const refreshed = await callTool(ragRetrieverTool, {
        projectDir: args.projectDir,
        className: args.className,
      }, ctx)
      if (!refreshed.error) retrieveResult = refreshed
    } else {
      log(`⚠ IDA 获取失败: ${idaResult.error}，继续使用现有 Context`)
    }
  } else {
    log("[2/3] IDA 判断：不需要")
  }

  // Step 3: 确定输出路径
  const config = await loadProjectConfig(args.projectDir)
  const scriptsDir = resolveScriptsDir(args.projectDir, config)
  const outputPath = path.join(scriptsDir, `${args.className}.cs`)

  log(`[3/3] Context 准备完成，输出路径: ${outputPath}`)

  // 构建完整指令（供 opencode AI 在当前会话中执行）
  const compileInstruction = args.projectPath
    ? [
        ``,
        `## 全自动模式指令（AI 请执行）`,
        ``,
        `代码生成完成后，请按以下步骤操作：`,
        ``,
        `**步骤 1**：将上面生成的代码写入文件：`,
        `\`\`\``,
        `文件路径: ${outputPath}`,
        `\`\`\``,
        `使用 Edit 工具写入完整代码。`,
        ``,
        `**步骤 2**：调用 unity-compile-fix 工具启动自动编译修复循环：`,
        `\`\`\`json`,
        JSON.stringify({
          projectPath: args.projectPath,
          className: args.className,
          iteration: 0,
          maxIterations: args.maxIterations ?? 5,
        }, null, 2),
        `\`\`\``,
        ``,
        `**步骤 3**：根据 unity-compile-fix 的返回结果：`,
        `- status: "success" → 调用 unity-rag-learn 保存到知识库`,
        `- status: "needs_fix" → 按返回的修复指令修复代码，再次调用 unity-compile-fix`,
        `- status: "needs_manual" / "stuck" / "gave_up" → 人工处理`,
      ].join("\n")
    : `\n💡 提示：提供 --projectPath 参数可启用自动编译功能。`

  return {
    output: `✅ Context 准备完成: ${args.className}

${retrieveResult.output}
${compileInstruction}

---

${retrieveResult.prompt}`,
    prompt: retrieveResult.prompt,
    outputPath,
    projectDir: args.projectDir,
    projectPath: args.projectPath,
    className: args.className,
  }
}
