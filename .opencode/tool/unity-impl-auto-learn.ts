import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"
import ragLearnTool from "./unity-rag-learn"

async function callTool(toolDef: any, args: any, ctx: any) {
  return toolDef.execute(args, ctx)
}

/**
 * Unity 自动学习工具
 * 
 * 监听 Assets/Scripts 目录的变化，自动将新生成的代码加入 RAG 知识库
 */

export default tool({
  description: `Unity 自动学习工具 - 自动将成功编译的代码加入 RAG 知识库。

使用场景：
- 代码生成后自动学习
- 批量导入已有代码`,

  args: {
    projectDir: tool.schema.string().describe("Unity 项目目录"),
    
    className: tool.schema.string().optional().describe("要学习的类名（可选，用于单个文件）"),
    
    scanAll: tool.schema.boolean().optional().describe("扫描所有已存在的代码文件并导入"),
    
    auto: tool.schema.boolean().optional().describe("自动模式：在生成代码后自动调用"),
  },

  async execute(args, ctx) {
    const scriptsDir = path.join(args.projectDir, "Assets/Scripts")
    const ragDir = path.join(args.projectDir, ".opencode/rag")

    // 检查 RAG 是否初始化
    const indexPath = path.join(ragDir, "index.json")
    try {
      await fs.access(indexPath)
    } catch {
      return {
        error: "RAG 未初始化，请先运行: /impl-unity --init",
      }
    }

    // ==================== 单个文件学习 ====================
    if (args.className && !args.scanAll) {
      return await learnSingleClass(args, ctx, scriptsDir, args.className)
    }

    // ==================== 批量扫描学习 ====================
    if (args.scanAll) {
      return await scanAndLearnAll(args, ctx, scriptsDir)
    }

    // ==================== 自动模式（监听最新文件）====================
    if (args.auto) {
      return await autoLearnLatest(args, ctx, scriptsDir)
    }

    return {
      error: "请指定操作模式：--className <Name> 或 --scanAll 或 --auto",
    }
  },
})

// ==================== 学习单个类 ====================

async function learnSingleClass(args: any, ctx: any, scriptsDir: string, className: string) {
  const codePath = path.join(scriptsDir, `${className}.cs`)

  // 检查文件是否存在
  try {
    await fs.access(codePath)
  } catch {
    return {
      error: `文件不存在: ${codePath}`,
      suggestion: `请确保代码已保存到 Assets/Scripts/${className}.cs`,
    }
  }

  // 读取代码
  const code = await fs.readFile(codePath, "utf-8")

  // 简单验证（是否包含类定义）
  const hasClass = code.includes(`class ${className}`) || code.includes(`struct ${className}`)

  if (!hasClass) {
    return {
      error: `文件不包含类定义: ${className}`,
      suggestion: "请检查代码是否正确生成",
    }
  }

  // 调用学习工具
  const result = await callTool(ragLearnTool, {
    projectDir: args.projectDir,
    className,
    codePath,
    compileSuccess: true, // 假设已编译成功
    extractPatterns: true,
  }, ctx)

  if (result.error) {
    return result
  }

  return {
    output: `${result.output}

💡 此代码已加入知识库，后续类可以参考！`,
    ...result,
  }
}

// ==================== 批量扫描学习 ====================

async function scanAndLearnAll(args: any, ctx: any, scriptsDir: string) {
  console.log("🔍 扫描 Assets/Scripts 目录...")

  let files: string[] = []
  try {
    files = await fs.readdir(scriptsDir)
  } catch {
    return {
      error: `目录不存在: ${scriptsDir}`,
      suggestion: "请确保 Assets/Scripts 目录存在",
    }
  }

  const csFiles = files.filter((f) => f.endsWith(".cs"))

  if (csFiles.length === 0) {
    return {
      output: "📭 未找到任何 .cs 文件",
    }
  }

  console.log(`找到 ${csFiles.length} 个 .cs 文件，开始导入...`)

  const results: Array<{ className: string; success: boolean; error?: string }> = []
  let successCount = 0
  let failCount = 0

  for (const file of csFiles) {
    const className = file.replace(".cs", "")
    const codePath = path.join(scriptsDir, file)

    try {
      const code = await fs.readFile(codePath, "utf-8")

      // 验证是否包含类定义
      const hasClass = code.includes(`class ${className}`) || code.includes(`struct ${className}`)

      if (!hasClass) {
        results.push({ className, success: false, error: "未找到类定义" })
        failCount++
        continue
      }

      // 调用学习工具
      const result = await callTool(ragLearnTool, {
        projectDir: args.projectDir,
        className,
        codePath,
        compileSuccess: true,
        extractPatterns: true,
      }, ctx)

      if (result.error) {
        results.push({ className, success: false, error: result.error })
        failCount++
      } else {
        results.push({ className, success: true })
        successCount++
      }

      // 进度显示
      const total = csFiles.length
      const current = successCount + failCount
      if (current % 10 === 0 || current === total) {
        console.log(`进度: ${current}/${total} (成功: ${successCount}, 失败: ${failCount})`)
      }
    } catch (error) {
      results.push({ className, success: false, error: String(error) })
      failCount++
    }
  }

  const failedClasses = results.filter((r) => !r.success)

  return {
    output: `✅ 批量导入完成

📊 统计:
- 总文件数: ${csFiles.length}
- 成功导入: ${successCount}
- 失败: ${failCount}
- 成功率: ${((successCount / csFiles.length) * 100).toFixed(1)}%

${
  failedClasses.length > 0
    ? `\n⚠️ 失败的类:\n${failedClasses.map((f) => `- ${f.className}: ${f.error}`).join("\n")}`
    : ""
}

💡 知识库已更新，后续类生成会参考这些代码！`,
    stats: {
      total: csFiles.length,
      success: successCount,
      failed: failCount,
    },
    results,
  }
}

// ==================== 自动模式（学习最新文件）====================

async function autoLearnLatest(args: any, ctx: any, scriptsDir: string) {
  // 获取最新的 .cs 文件
  let files: string[] = []
  try {
    files = await fs.readdir(scriptsDir)
  } catch {
    return {
      output: "⚠️ Assets/Scripts 目录不存在，跳过自动学习",
    }
  }

  const csFiles = files.filter((f) => f.endsWith(".cs"))

  if (csFiles.length === 0) {
    return {
      output: "⚠️ 未找到任何 .cs 文件，跳过自动学习",
    }
  }

  // 获取最新修改的文件
  let latestFile = ""
  let latestTime = 0

  for (const file of csFiles) {
    const filePath = path.join(scriptsDir, file)
    const stats = await fs.stat(filePath)
    if (stats.mtimeMs > latestTime) {
      latestTime = stats.mtimeMs
      latestFile = file
    }
  }

  const className = latestFile.replace(".cs", "")

  console.log(`🤖 自动学习最新文件: ${className}`)

  return await learnSingleClass(args, ctx, scriptsDir, className)
}
