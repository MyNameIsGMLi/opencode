import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"

/**
 * Unity RAG Analyzer - 从 RAG 索引生成 Mermaid 类图、架构图和玩法设计文档
 *
 * 支持操作：
 * - full: 全量分析，生成所有模块的类图 + 架构图 + 玩法文档
 * - incremental: 增量分析，仅更新指定类所属模块
 */

export default tool({
  description: `Unity RAG 分析器 - 从 RAG 索引生成 Mermaid 图表和玩法文档。

支持模式：
- full: 全量分析（类图/架构图/玩法方案）
- incremental: 增量分析（仅重建指定类所属模块）`,

  args: {
    projectDir: tool.schema.string().describe("Unity 项目根目录"),
    mode: tool.schema.enum(["full", "incremental"]).describe("分析模式"),
    className: tool.schema.string().optional().describe("增量模式：指定要更新的类名"),
    verbose: tool.schema.boolean().optional().describe("显示详细日志"),
  },

  async execute(args) {
    const ragDir = path.join(args.projectDir, ".opencode", "rag")
    const analysisDir = path.join(args.projectDir, ".opencode", "docs", "analysis")

    await fs.mkdir(analysisDir, { recursive: true })

    const indexPath = path.join(ragDir, "index.json")
    let index: RAGIndex
    try {
      const content = await fs.readFile(indexPath, "utf-8")
      index = JSON.parse(content)
    } catch {
      return { error: `RAG 索引不存在: ${indexPath}。请先运行 unity-rag-core index 操作。` }
    }

    if (args.mode === "full") {
      return runFullAnalysis(index, analysisDir, args.verbose ?? false)
    }
    return runIncrementalAnalysis(index, analysisDir, args.className ?? "", args.verbose ?? false)
  },
})

// ==================== 类型定义 ====================

interface KnowledgeChunk {
  id: string
  type: "class" | "method" | "module" | "pattern" | "ida" | "verified"
  content: string
  metadata: {
    className?: string
    namespace?: string
    fullName?: string
    baseClass?: string | null
    interfaces?: string[]
    fieldCount?: number
    methodCount?: number
    dependencies?: string[]
    complexity?: number
    [key: string]: unknown
  }
}

interface RAGIndex {
  version: string
  createdAt: string
  updatedAt: string
  chunks: KnowledgeChunk[]
  stats: {
    totalClasses: number
    totalMethods: number
    idaAnalyzed: number
    verifiedImplementations: number
  }
}

// ==================== 全量分析 ====================

async function runFullAnalysis(index: RAGIndex, analysisDir: string, verbose: boolean) {
  const classChunks = index.chunks.filter((c) => c.type === "class")
  const verifiedChunks = index.chunks.filter((c) => c.type === "verified")

  // 按顶层命名空间分组
  const moduleMap = new Map<string, KnowledgeChunk[]>()
  for (const c of classChunks) {
    const moduleName = (c.metadata.namespace || "Root").split(".")[0]
    if (!moduleMap.has(moduleName)) moduleMap.set(moduleName, [])
    moduleMap.get(moduleName)!.push(c)
  }

  const files: string[] = []

  // 为每个模块生成类图
  for (const [moduleName, classes] of moduleMap.entries()) {
    if (verbose) process.stdout.write(`[analyzer] 生成模块类图: ${moduleName}\n`)
    const diagram = buildClassDiagram(classes, verifiedChunks)
    const filePath = path.join(analysisDir, `${moduleName}-class-diagram.md`)
    await fs.writeFile(filePath, diagram, "utf-8")
    files.push(`${moduleName}-class-diagram.md`)
  }

  // 生成架构图
  const archDiagram = buildArchDiagram(moduleMap, classChunks)
  await fs.writeFile(path.join(analysisDir, "architecture.md"), archDiagram, "utf-8")
  files.push("architecture.md")

  // 生成玩法文档
  const gameplayDoc = buildGameplayDoc(classChunks, verifiedChunks)
  await fs.writeFile(path.join(analysisDir, "gameplay-design.md"), gameplayDoc, "utf-8")
  files.push("gameplay-design.md")

  return {
    output: `✅ 全量分析完成\n\n生成文件:\n${files.map((f) => `- ${f}`).join("\n")}`,
    files,
    moduleCount: moduleMap.size,
    classCount: classChunks.length,
    verifiedCount: verifiedChunks.length,
  }
}

// ==================== 增量分析 ====================

async function runIncrementalAnalysis(
  index: RAGIndex,
  analysisDir: string,
  className: string,
  verbose: boolean,
) {
  const classChunks = index.chunks.filter((c) => c.type === "class")
  const verifiedChunks = index.chunks.filter((c) => c.type === "verified")

  const targetChunk = classChunks.find(
    (c) =>
      c.metadata.className === className ||
      (c.metadata.fullName && c.metadata.fullName.endsWith(`.${className}`)),
  )

  const moduleName = targetChunk
    ? (targetChunk.metadata.namespace || "Root").split(".")[0]
    : "Root"

  if (verbose) process.stdout.write(`[analyzer] 增量更新模块: ${moduleName}\n`)

  const moduleClasses = classChunks.filter(
    (c) => (c.metadata.namespace || "Root").split(".")[0] === moduleName,
  )

  const moduleMap = new Map<string, KnowledgeChunk[]>()
  for (const c of classChunks) {
    const mod = (c.metadata.namespace || "Root").split(".")[0]
    if (!moduleMap.has(mod)) moduleMap.set(mod, [])
    moduleMap.get(mod)!.push(c)
  }

  const files: string[] = []

  // 重建本模块类图
  const diagram = buildClassDiagram(moduleClasses, verifiedChunks)
  const diagramFile = `${moduleName}-class-diagram.md`
  await fs.writeFile(path.join(analysisDir, diagramFile), diagram, "utf-8")
  files.push(diagramFile)

  // 重建玩法文档（保持跨模块引用正确）
  const gameplayDoc = buildGameplayDoc(classChunks, verifiedChunks)
  await fs.writeFile(path.join(analysisDir, "gameplay-design.md"), gameplayDoc, "utf-8")
  files.push("gameplay-design.md")

  // 重建架构图（从全部 classChunks 重新构建模块映射）
  const archDiagram = buildArchDiagram(moduleMap, classChunks)
  await fs.writeFile(path.join(analysisDir, "architecture.md"), archDiagram, "utf-8")
  files.push("architecture.md")

  return {
    output: `✅ 增量分析完成 (${className} → 模块 ${moduleName})\n${files.map((f) => `- ${f}`).join("\n")}`,
    updatedModule: moduleName,
    files,
  }
}

// ==================== buildClassDiagram ====================

function buildClassDiagram(classes: KnowledgeChunk[], verifiedChunks: KnowledgeChunk[]): string {
  const verifiedNames = new Set(verifiedChunks.map((c) => c.metadata.className).filter(Boolean))
  const now = new Date().toISOString()

  const lines: string[] = ["classDiagram"]

  for (const c of classes) {
    const name = c.metadata.className || "Unknown"
    const isVerified = verifiedNames.has(name)
    if (isVerified) {
      lines.push(`  class ${name} {`)
      lines.push(`    <<verified>>`)
      lines.push(`  }`)
    } else {
      lines.push(`  class ${name}`)
    }

    const base = c.metadata.baseClass
    if (base && base !== "Object" && base !== "ValueType") {
      lines.push(`  ${base} <|-- ${name}`)
    }

    for (const iface of c.metadata.interfaces ?? []) {
      if (iface) lines.push(`  ${iface} <|.. ${name}`)
    }
  }

  return `# 类图\n\n\`\`\`mermaid\n${lines.join("\n")}\n\`\`\`\n\n> 更新时间: ${now}\n`
}

// ==================== buildArchDiagram ====================

function buildArchDiagram(
  modules: Map<string, KnowledgeChunk[]>,
  classChunks: KnowledgeChunk[],
): string {
  const now = new Date().toISOString()

  // className → moduleName lookup
  const classToModule = new Map<string, string>()
  for (const c of classChunks) {
    const mod = (c.metadata.namespace || "Root").split(".")[0]
    if (c.metadata.className) classToModule.set(c.metadata.className, mod)
    if (c.metadata.fullName) classToModule.set(c.metadata.fullName, mod)
  }

  const lines: string[] = ["graph TD"]

  // Module nodes
  for (const [moduleName, classes] of modules.entries()) {
    lines.push(`  ${moduleName}["${moduleName}\\n(${classes.length} 类)"]`)
  }

  // Cross-module edges (deduplicated)
  const edges = new Set<string>()
  for (const c of classChunks) {
    const srcModule = (c.metadata.namespace || "Root").split(".")[0]
    for (const dep of c.metadata.dependencies ?? []) {
      const dstModule = classToModule.get(dep)
      if (dstModule && dstModule !== srcModule) {
        const edge = `${srcModule} --> ${dstModule}`
        if (!edges.has(edge)) {
          edges.add(edge)
          lines.push(`  ${edge}`)
        }
      }
    }
  }

  return `# 架构图\n\n\`\`\`mermaid\n${lines.join("\n")}\n\`\`\`\n\n> 更新时间: ${now}\n`
}

// ==================== buildGameplayDoc ====================

function buildGameplayDoc(classChunks: KnowledgeChunk[], verifiedChunks: KnowledgeChunk[]): string {
  const now = new Date().toISOString()
  const verifiedNames = new Set(verifiedChunks.map((c) => c.metadata.className).filter(Boolean))

  // Identify core gameplay classes
  const gameplayPattern =
    /Controller|Manager|System|Game|Player|Battle|Combat|Skill|Level|Stage|Wave|Enemy|Spawn|UI|HUD/i

  const coreClasses = classChunks.filter(
    (c) =>
      (c.metadata.baseClass === "MonoBehaviour" || c.metadata.baseClass === "ScriptableObject") &&
      gameplayPattern.test(c.metadata.className ?? ""),
  )

  // Group definitions
  const groups: Array<{ name: string; pattern: RegExp; classes: KnowledgeChunk[] }> = [
    { name: "GameFlow（游戏主流程）", pattern: /Game|Level|Stage|Wave|Spawn/i, classes: [] },
    { name: "Player（玩家）", pattern: /Player|Character/i, classes: [] },
    { name: "Combat（战斗）", pattern: /Battle|Combat|Skill|Enemy|Attack|Damage/i, classes: [] },
    { name: "UI（界面）", pattern: /UI|HUD|Panel|Menu|Screen/i, classes: [] },
    { name: "其他系统", pattern: /.*/, classes: [] },
  ]

  // Assign each core class to first matching group (last group is catch-all)
  for (const c of coreClasses) {
    const name = c.metadata.className ?? ""
    let assigned = false
    for (let i = 0; i < groups.length - 1; i++) {
      if (groups[i].pattern.test(name)) {
        groups[i].classes.push(c)
        assigned = true
        break
      }
    }
    if (!assigned) groups[groups.length - 1].classes.push(c)
  }

  const sections: string[] = []

  const header = `# 核心玩法方案

> 自动分析自 IL2CPP dump.cs，共识别 ${coreClasses.length} 个核心玩法类
> 更新时间: ${now}

---`
  sections.push(header)

  for (const group of groups) {
    if (group.classes.length === 0) continue

    sections.push(`\n## ${group.name}`)

    // 交互时序图
    const participants = group.classes.slice(0, 5).map((c) => c.metadata.className ?? "Unknown")
    const seqLines: string[] = ["sequenceDiagram"]
    for (const p of participants) {
      seqLines.push(`  participant ${p}`)
    }
    // Edges from dependency relationships within the group
    const groupNames = new Set(group.classes.map((c) => c.metadata.className))
    const seqEdges = new Set<string>()
    for (const c of group.classes) {
      for (const dep of c.metadata.dependencies ?? []) {
        if (groupNames.has(dep) && dep !== c.metadata.className) {
          const edge = `  ${c.metadata.className}->>+${dep}: call`
          if (!seqEdges.has(edge)) {
            seqEdges.add(edge)
            seqLines.push(edge)
          }
        }
      }
    }

    sections.push(`### 交互时序图\n\n\`\`\`mermaid\n${seqLines.join("\n")}\n\`\`\``)

    // 类清单
    const tableRows = group.classes
      .map((c) => {
        const name = c.metadata.className ?? "Unknown"
        const fields = c.metadata.fieldCount ?? 0
        const methods = c.metadata.methodCount ?? 0
        const complexity = c.metadata.complexity ?? 0
        const verified = verifiedNames.has(name) ? "✅" : "⬜"
        const base = c.metadata.baseClass ?? ""
        return `| ${name} | ${fields} | ${methods} | ${complexity} | ${verified} | ${base} |`
      })
      .join("\n")

    sections.push(
      `### 类清单\n\n| 类名 | 字段数 | 方法数 | 复杂度 | 已验证 | 基类 |\n|------|--------|--------|--------|--------|------|\n${tableRows}`,
    )

    // 状态机推断（仅当内容含 State/Phase 时）
    const hasStateful = group.classes.some((c) => /State|Phase/i.test(c.content))
    if (hasStateful) {
      sections.push(`### 状态机推断

\`\`\`mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Active : 开始
  Active --> Paused : 暂停
  Paused --> Active : 恢复
  Active --> [*] : 结束
\`\`\`

> ⚠️ 以上状态机为自动推断，需人工验证`)
    }

    // 已验证实现摘要
    const verifiedInGroup = group.classes
      .map((c) => verifiedChunks.find((v) => v.metadata.className === c.metadata.className))
      .filter((v): v is KnowledgeChunk => v !== undefined)

    if (verifiedInGroup.length > 0) {
      const summaryLines = verifiedInGroup.map((v) => {
        const preview = v.content.slice(0, 300).replace(/\n/g, "\n  ")
        return `**${v.metadata.className}**:\n\`\`\`csharp\n  ${preview}${v.content.length > 300 ? "\n  ..." : ""}\n\`\`\``
      })
      sections.push(`### 已验证实现摘要\n\n${summaryLines.join("\n\n")}`)
    }
  }

  return sections.join("\n")
}
