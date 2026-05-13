import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"

/**
 * Unity Batch Processor - Ultra-simple batch processing tool
 *
 * This tool ONLY does I/O:
 * 1. Reads batch JSON file
 * 2. Formats instructions for OpenCode Agent
 * 3. Returns instructions as string
 *
 * OpenCode Agent does the actual work (code generation)
 */
export default tool({
  description:
    "Process a batch of Unity IL2CPP classes - reads batch file and formats instructions for code generation",

  args: {
    batchFile: tool.schema.string().describe("Path to batch JSON file"),
    startIndex: tool.schema.number().optional().describe("Start index (default: 0)"),
    count: tool.schema.number().optional().describe("Number of classes to process (default: 10)"),
  },

  async execute(args, context) {
    const start = args.startIndex || 0
    const count = args.count || 10

    try {
      // Step 1: Read batch file
      const batchContent = await fs.readFile(args.batchFile, "utf-8")
      const batch = JSON.parse(batchContent)

      if (!batch.classes || !Array.isArray(batch.classes)) {
        return "Error: Invalid batch file format. Expected { classes: Array }"
      }

      // Step 2: Select classes to process
      const end = Math.min(start + count, batch.classes.length)
      const selected = batch.classes.slice(start, end)

      // Step 3: Format output directory
      const batchDir = path.dirname(args.batchFile)
      const outputDir = path.join(path.dirname(batchDir), "reconstructed")

      // Step 4: Build instructions
      let instructions = `# Unity Reverse Engineering Batch

Batch File: ${path.basename(args.batchFile)}
Processing: ${selected.length} classes (${start + 1} to ${end} of ${batch.classes.length})
Output: ${outputDir}

## Instructions

For each class below, generate complete C# code and save it.

---

`

      // Step 5: Add each class
      for (let i = 0; i < selected.length; i++) {
        const cls = selected[i]
        const idx = start + i + 1

        instructions += `\n### ${idx}. ${cls.class_name}\n\n`

        if (cls.stub) {
          instructions += `**Stub:**\n\`\`\`csharp\n${cls.stub}\n\`\`\`\n\n`
          instructions += `**Task:** Generate complete C# implementation for this class.\n`
          instructions += `**Output:** Save to \`${outputDir}/${cls.clean_name}.cs\`\n\n`
        } else {
          instructions += `**Error:** ${cls.error || "Stub not found"}\n`
          instructions += `**Action:** Skip this class.\n\n`
        }

        instructions += `---\n`
      }

      instructions += `\n## Summary\n\n`
      instructions += `Total classes to generate: ${selected.filter((c) => c.stub).length}\n`
      instructions += `Classes to skip: ${selected.filter((c) => !c.stub).length}\n\n`
      instructions += `After generating all classes, report completion status.`

      return instructions
    } catch (error) {
      return `Error processing batch file: ${error}`
    }
  },
})
