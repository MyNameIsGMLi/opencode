import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"

export default tool({
  description: `Unity RAG 社区检测 - 基于 Louvain 算法对类依赖图聚类，发现隐含模块边界。

支持操作：
- detect: 运行社区检测（需要 Python 3 + networkx）
- get: 查询某个类所属的社区
- stats: 查看社区统计`,

  args: {
    action: tool.schema.enum(["detect", "get", "stats"]).describe("操作类型"),
    projectDir: tool.schema.string().describe("Unity 项目根目录"),
    className: tool.schema.string().optional().describe("类名（get 模式）"),
  },

  async execute(args, ctx) {
    const ragDir = path.join(args.projectDir, ".opencode", "rag")
    const xrefsPath = path.join(ragDir, "xrefs.json")
    const commPath = path.join(ragDir, "communities.json")
    const scriptPath = path.join((import.meta as any).dir, "..", "scripts", "detect_communities.py")

    if (args.action === "detect") {
      const scriptExists = await fs.access(scriptPath).then(() => true).catch(() => false)
      if (!scriptExists) {
        return { error: `检测脚本不存在: ${scriptPath}` }
      }

      // 检查 Python 和 networkx
      const pyCheck = await ctx.bash(`python3 -c "import networkx; print(networkx.__version__)" 2>&1`)
      if (!pyCheck.includes(".")) {
        return {
          error: "需要 Python 3 + networkx",
          suggestion: "运行: pip3 install networkx",
        }
      }

      // 运行社区检测
      const result = await ctx.bash(`python3 "${scriptPath}" "${xrefsPath}" "${commPath}" 2>&1`)

      if (result.includes("ERROR:")) {
        return { error: `社区检测失败: ${result}` }
      }

      const communities: any[] = JSON.parse(await Bun.file(commPath).text())

      return {
        output: [
          `✅ 社区检测完成`,
          ``,
          `📊 结果:`,
          `- 总社区数: ${communities.length}`,
          `- 总类数: ${communities.reduce((s: number, c: any) => s + c.size, 0)}`,
          `- 最大社区: ${communities[0]?.size ?? 0} 个类`,
          ``,
          `Top 5 社区:`,
          ...communities.slice(0, 5).map((c: any) => {
            const sample = c.classes.slice(0, 3).map((n: string) => n.split(".").pop()).join(", ")
            return `  #${c.communityId}: ${c.size} 类 (${sample}...)`
          }),
          ``,
          result,
        ].join("\n"),
        communityCount: communities.length,
        communities: communities.slice(0, 10),
      }
    }

    if (args.action === "get") {
      if (!args.className) return { error: "get 模式需要 className" }

      const commExists = await fs.access(commPath).then(() => true).catch(() => false)
      if (!commExists) {
        return { error: "communities.json 不存在，请先运行 detect 操作" }
      }

      const communities: any[] = JSON.parse(await Bun.file(commPath).text())
      const found = communities.find((c: any) =>
        c.classes.includes(args.className) ||
        c.classes.some((cls: string) => cls.endsWith(`.${args.className}`))
      )

      if (!found) {
        return { error: `类 ${args.className} 不在任何社区（可能是孤立节点）` }
      }

      return {
        output: `✅ ${args.className} 所属社区 #${found.communityId} (${found.size} 个类)`,
        communityId: found.communityId,
        size: found.size,
        classes: found.classes,
        sampleClasses: found.classes.slice(0, 10),
      }
    }

    // stats
    const commExists = await fs.access(commPath).then(() => true).catch(() => false)
    if (!commExists) {
      return { error: "communities.json 不存在，请先运行 detect 操作" }
    }

    const communities: any[] = JSON.parse(await Bun.file(commPath).text())
    const totalClasses = communities.reduce((s: number, c: any) => s + c.size, 0)
    const avgSize = communities.length > 0 ? (totalClasses / communities.length).toFixed(1) : "0"

    return {
      output: [
        `📊 社区统计`,
        ``,
        `总社区数: ${communities.length}`,
        `总类数: ${totalClasses}`,
        `平均社区大小: ${avgSize} 个类`,
        ``,
        `Top 10 社区:`,
        ...communities.slice(0, 10).map((c: any) => {
          const sample = c.classes.slice(0, 3).map((n: string) => n.split(".").pop()).join(", ")
          return `  #${c.communityId}: ${c.size} 类 (${sample}...)`
        }),
      ].join("\n"),
      communities: communities.slice(0, 10).map((c: any) => ({
        id: c.communityId,
        size: c.size,
        sample: c.classes.slice(0, 3).map((n: string) => n.split(".").pop()),
      })),
    }
  },
})
