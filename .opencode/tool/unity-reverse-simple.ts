import { tool } from "@opencode-ai/plugin"
import * as path from "path"
import * as fs from "fs/promises"

export default tool({
  description:
    "Simple Unity IL2CPP reverse engineering tool - processes a batch of classes and generates C# code using OpenCode's LLM capabilities.",

  args: {
    batchFile: tool.schema.string().describe("Path to batch JSON file containing class stubs"),
    outputDir: tool.schema.string().describe("Output directory for reversed C# files"),
    startIndex: tool.schema.number().optional().describe("Start index in batch (default: 0)"),
    count: tool.schema.number().optional().describe("Number of classes to process (default: all)"),
  },

  async execute(args, context) {
    const startIndex = args.startIndex || 0
    const outputDir = path.resolve(context.directory, args.outputDir)

    // 读取批次文件
    const batchContent = await fs.readFile(args.batchFile, "utf-8")
    const batch = JSON.parse(batchContent)

    if (!batch.classes || !Array.isArray(batch.classes)) {
      return `Error: Invalid batch file format. Expected {classes: Array}`
    }

    const totalClasses = batch.classes.length
    const endIndex = args.count ? Math.min(startIndex + args.count, totalClasses) : totalClasses
    const classesToProcess = batch.classes.slice(startIndex, endIndex)

    // 创建输出目录
    await fs.mkdir(outputDir, { recursive: true })

    // 生成处理指令
    const instructions = `
# Unity Reverse Engineering Batch Processing

Processing batch: ${path.basename(args.batchFile)}
Classes to process: ${classesToProcess.length} (${startIndex + 1} to ${endIndex} of ${totalClasses})
Output directory: ${outputDir}

## Instructions for OpenCode Agent

For each class below, generate complete C# code based on the stub signature:

1. Read the class stub
2. Generate a complete, compilable C# implementation
3. Save to ${outputDir}/<ClassName>.cs

## Classes to Process

${classesToProcess
  .map(
    (cls, idx) => `
### ${startIndex + idx + 1}. ${cls.class_name}

**Namespace:** ${cls.namespace || "(none)"}
**Stub Length:** ${cls.stub_length || 0} characters

${cls.stub ? "**Stub Available:** Yes" : "**Error:** " + (cls.error || "Stub not found")}

**Output File:** ${outputDir}/${cls.clean_name || cls.class_name}.cs

---
`,
  )
  .join("\n")}

## Next Steps

告诉OpenCode: "处理上述${classesToProcess.length}个类，为每个类生成完整的C#代码并保存"
`

    return instructions
  },
})
