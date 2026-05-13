import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"

export default tool({
  description: "Simple test tool to verify file reading works",

  args: {
    filePath: tool.schema.string().describe("Path to file to read"),
  },

  async execute(args, context) {
    try {
      const content = await fs.readFile(args.filePath, "utf-8")
      const lines = content.split("\n")
      return `Successfully read file: ${args.filePath}
Total lines: ${lines.length}
First 5 lines:
${lines.slice(0, 5).join("\n")}`
    } catch (error) {
      return `Error reading file: ${error}`
    }
  },
})
