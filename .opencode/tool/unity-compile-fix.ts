import { tool } from "@opencode-ai/plugin"
import * as path from "path"
import editorCompileTool from "./unity-editor-compile"

async function callTool(toolDef: any, args: any, ctx: any) {
  return toolDef.execute(args, ctx)
}

/**
 * Unity 编译错误自动修复循环（Auto-Fix Loop）
 *
 * 工作方式（工具+AI协作模式）：
 * 1. 触发 Unity 编译（调用 unity-editor-compile）
 * 2. 分析错误，过滤第三方插件/缺失DLL错误（标记为需手动处理）
 * 3. 防死循环检测（同一错误集合连续出现2次则停止）
 * 4. 返回结构化的修复任务（fixPrompts）
 * 5. opencode AI 在当前会话中处理修复，写入文件后再次调用本工具
 * 6. 循环直到成功或达到迭代上限
 *
 * 状态通过 errorHistory 参数在调用间传递（工具本身无状态）
 */

// ── 第三方插件/缺失依赖的错误模式（跳过，不尝试自动修复）────────────

const THIRD_PARTY_PATTERNS = [
  // 命名空间找不到（可能是插件）
  /The type or namespace name '(DOTween|Zenject|Photon|Mirror|Spine|Odin|UniRx|UniTask|Entitas|DG\.|PrimeTween).*could not be found/i,
  /The type or namespace name '(TextMeshPro|TMPro|TMP_).*could not be found/i,
  // 常见 Unity 包（版本不匹配时）
  /The type or namespace name 'com\.unity\./i,
  // 缺少 DLL 引用
  /Are you missing a using directive or an assembly reference.*\(CS0246\)/i,
  // Entitas 代码生成相关
  /Entitas\.CodeGeneration/i,
]

function isThirdPartyError(message: string): boolean {
  return THIRD_PARTY_PATTERNS.some(p => p.test(message))
}

// ── 提取代码上下文（错误行前后各 N 行）──────────────────────────────

function extractCodeContext(
  code: string,
  errorLines: number[],
  contextLines = 25,
): { context: string; startLine: number; endLine: number } {
  const lines = code.split("\n")
  const minLine = Math.max(1, Math.min(...errorLines) - contextLines)
  const maxLine = Math.min(lines.length, Math.max(...errorLines) + contextLines)

  // 带行号的上下文
  const context = lines
    .slice(minLine - 1, maxLine)
    .map((l, i) => {
      const lineNum = minLine + i
      const isError = errorLines.includes(lineNum)
      return `${String(lineNum).padStart(4)} ${isError ? ">>>" : "   "} ${l}`
    })
    .join("\n")

  return { context, startLine: minLine, endLine: maxLine }
}

export default tool({
  description: `Unity 编译错误自动修复循环（Auto-Fix Loop）。

工作方式（工具+AI协作）：
1. 工具触发编译，收集错误
2. 返回结构化修复任务（fixTasks）给 AI
3. AI 在当前会话中修复代码并写入文件
4. AI 再次调用本工具进行下一轮编译
5. 循环直到成功或达到上限

注意：第三方插件/缺失DLL错误会被跳过，标记为需手动处理。`,

  args: {
    projectPath: tool.schema.string().describe("Unity 项目路径"),
    className: tool.schema.string().optional().describe("正在修复的目标类名（用于定向分析）"),
    iteration: tool.schema.number().optional().describe("当前迭代次数（由工具自动追踪，初次调用不填）"),
    maxIterations: tool.schema.number().optional().describe("最大迭代次数（默认 5）"),
    errorHistory: tool.schema.string().optional().describe("历史错误签名 JSON（工具内部传递，防死循环）"),
    unityVersion: tool.schema.string().optional().describe("Unity 版本（可选，不填则自动检测）"),
  },

  async execute(args, ctx) {
    const iteration = args.iteration ?? 0
    const maxIterations = args.maxIterations ?? 5

    // ── Step 1: 触发编译 ─────────────────────────────────────────────
    const compileArgs: any = { projectPath: args.projectPath }
    if (args.unityVersion) compileArgs.unityVersion = args.unityVersion

    const compileResult = await callTool(editorCompileTool, compileArgs, ctx)

    // 编译工具自身出错（如找不到 Unity）
    if (compileResult.error && !compileResult.errors) {
      return {
        status: "compile_error",
        output: `❌ 编译工具错误: ${compileResult.error}`,
        error: compileResult.error,
      }
    }

    // ── Step 2: 成功 → 触发学习，返回成功 ──────────────────────────
    if (compileResult.success) {
      return {
        status: "success",
        iteration,
        output: [
          `✅ Unity 编译成功！`,
          iteration > 0 ? `经过 ${iteration} 轮自动修复后通过。` : `首次编译即通过。`,
          compileResult.warnings?.length > 0
            ? `警告: ${compileResult.warnings.length} 条（不影响运行）`
            : "",
          ``,
          args.className
            ? `💡 下一步：调用 unity-rag-learn 将代码加入知识库\n  className: ${args.className}\n  codePath: <生成的文件路径>`
            : "",
        ].filter(Boolean).join("\n"),
        needsLearn: !!args.className,
        className: args.className,
        compileResult,
      }
    }

    // ── Step 3: 超出迭代上限 ─────────────────────────────────────────
    if (iteration >= maxIterations) {
      return {
        status: "gave_up",
        iteration,
        output: [
          `⚠️ 达到最大迭代次数 (${maxIterations})，仍有 ${compileResult.errors?.length ?? 0} 个错误。`,
          ``,
          `剩余错误（需人工处理）:`,
          ...(compileResult.errors ?? []).slice(0, 10).map((e: any) =>
            `  ${e.file}(${e.line}): ${e.code}: ${e.message}`
          ),
        ].join("\n"),
        remainingErrors: compileResult.errors ?? [],
      }
    }

    // ── Step 4: 分类错误（可修复 vs 第三方/缺失依赖）────────────────
    const allErrors = compileResult.errors ?? []

    const skippedErrors = allErrors.filter((e: any) => isThirdPartyError(e.message))
    const fixableErrors = allErrors.filter((e: any) => !isThirdPartyError(e.message))

    // 全部是第三方错误，无法自动修复
    if (fixableErrors.length === 0 && skippedErrors.length > 0) {
      return {
        status: "needs_manual",
        iteration,
        output: [
          `⚠️ 所有错误均为第三方插件/缺失依赖，需手动处理:`,
          ``,
          ...skippedErrors.slice(0, 10).map((e: any) =>
            `  ${e.file}(${e.line}): ${e.code}: ${e.message}`
          ),
          ``,
          `建议: 确认相关插件已正确安装，或在代码中添加条件编译 #if 指令。`,
        ].join("\n"),
        skippedErrors,
      }
    }

    // ── Step 5: 防死循环检测 ─────────────────────────────────────────
    const history: string[] = args.errorHistory ? JSON.parse(args.errorHistory) : []
    const currentSignature = fixableErrors
      .map((e: any) => `${e.file}:${e.line}:${e.code}`)
      .sort()
      .join("|")

    if (history.includes(currentSignature)) {
      return {
        status: "stuck",
        iteration,
        output: [
          `🔄 检测到死循环：同一组错误连续出现 2 次，自动修复策略失效，需要人工介入。`,
          ``,
          `卡住的错误:`,
          ...fixableErrors.slice(0, 5).map((e: any) =>
            `  ${e.file}(${e.line}): ${e.code}: ${e.message}`
          ),
        ].join("\n"),
        stuckErrors: fixableErrors,
        errorHistory: history,
      }
    }
    history.push(currentSignature)

    // ── Step 6: 生成修复任务（按文件分组）──────────────────────────
    // 按文件分组错误
    const errorsByFile = new Map<string, any[]>()
    for (const e of fixableErrors) {
      if (!errorsByFile.has(e.file)) errorsByFile.set(e.file, [])
      errorsByFile.get(e.file)!.push(e)
    }

    const fixTasks: any[] = []
    const fixPromptParts: string[] = []

    for (const [relFile, fileErrors] of errorsByFile.entries()) {
      const absFile = path.join(args.projectPath, relFile)

      let code = ""
      try {
        code = await Bun.file(absFile).text()
      } catch {
        // 文件可能不存在，跳过
        continue
      }

      const errorLines = fileErrors.map((e: any) => e.line)
      const { context, startLine, endLine } = extractCodeContext(code, errorLines, 25)

      const taskPrompt = [
        `### 修复任务：\`${relFile}\``,
        ``,
        `**编译错误** (${fileErrors.length} 个):`,
        ...fileErrors.map((e: any) =>
          `- 行 ${e.line}, 列 ${e.column}: \`${e.code}\` - ${e.message}`
        ),
        ``,
        `**相关代码上下文** (行 ${startLine}-${endLine}，\`>>>\` 标记错误行):`,
        `\`\`\`csharp`,
        context,
        `\`\`\``,
        ``,
        `请输出修复后的**完整文件内容**（完整 C# 代码），解决以上所有编译错误。`,
        `写入文件路径：\`${absFile}\``,
      ].join("\n")

      fixTasks.push({
        file: relFile,
        absFile,
        errors: fileErrors,
        prompt: taskPrompt,
      })
      fixPromptParts.push(taskPrompt)
    }

    // ── Step 7: 返回修复指令给 AI ───────────────────────────────────
    const nextIteration = iteration + 1

    return {
      status: "needs_fix",
      iteration: nextIteration,
      totalErrors: allErrors.length,
      fixableErrors: fixableErrors.length,
      skippedErrors: skippedErrors.length,
      errorHistory: JSON.stringify(history),
      fixTasks,

      output: [
        `❌ 编译失败 (第 ${nextIteration} 轮，上限 ${maxIterations} 轮)`,
        ``,
        `📊 错误统计：`,
        `- 可自动修复: ${fixableErrors.length} 个`,
        `- 需手动处理 (第三方): ${skippedErrors.length} 个`,
        skippedErrors.length > 0 ? `- 跳过的错误: ${skippedErrors.slice(0, 3).map((e: any) => e.code).join(", ")}...` : "",
        ``,
        `🔧 **AI 修复指令**:`,
        `请按以下步骤操作：`,
        `1. 修复下面每个文件中的编译错误`,
        `2. 使用 Edit 工具将修复后的完整代码写入对应文件`,
        `3. 所有文件修复完成后，再次调用 unity-compile-fix 工具进行下一轮编译`,
        `   传入参数: projectPath="${args.projectPath}", iteration=${nextIteration}, errorHistory=<此次返回的errorHistory值>`,
        args.className ? `   className="${args.className}"` : "",
        ``,
        `---`,
        ``,
        ...fixPromptParts,
        skippedErrors.length > 0 ? [
          `---`,
          ``,
          `⚠️ 以下错误已跳过（第三方插件/缺失依赖，需手动处理）:`,
          ...skippedErrors.slice(0, 5).map((e: any) =>
            `- ${e.file}(${e.line}): ${e.code}: ${e.message}`
          ),
        ].join("\n") : "",
      ].filter(Boolean).join("\n"),
    }
  },
})
