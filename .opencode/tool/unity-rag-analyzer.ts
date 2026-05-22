import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"
import { loadProjectConfig, resolveAnalysisDir } from "./unity-project-config"

export default tool({
  description: `Unity RAG 分析器 - 从 RAG 索引生成 UML 类图、架构图和核心玩法方案文档。

支持模式：
- full: 全量分析所有类，生成完整文档套件
- incremental: 仅更新指定类所在模块的类图（轻量，不重建全局文档）`,

  args: {
    projectDir: tool.schema.string().describe("Unity 项目根目录"),
    mode: tool.schema.enum(["full", "incremental"]).describe("分析模式"),
    className: tool.schema.string().optional().describe("增量模式：触发分析的类名"),
    verbose: tool.schema.boolean().optional().describe("显示详细日志"),
  },

  async execute(args, _ctx) {
    const config = await loadProjectConfig(args.projectDir)
    const analysisDir = resolveAnalysisDir(args.projectDir, config)
    await fs.mkdir(analysisDir, { recursive: true })

    const indexPath = path.join(args.projectDir, ".opencode", "rag", "index.json")
    const exists = await fs.access(indexPath).then(() => true).catch(() => false)
    if (!exists) return { error: "RAG 索引不存在，请先运行: /impl-unity --init" }

    const index = await Bun.file(indexPath).json()

    if (args.mode === "full")
      return await runFullAnalysis(index, analysisDir, args.verbose ?? false)

    return await runIncrementalAnalysis(index, analysisDir, args.className ?? "", args.verbose ?? false)
  },
})

// ── 数据类型 ────────────────────────────────────────────────────────

interface ClassChunk {
  metadata: {
    className: string
    namespace?: string
    fullName?: string
    baseClass?: string
    interfaces?: string[]
    fieldCount?: number
    methodCount?: number
    complexity?: number
    dependencies?: string[]
  }
  content?: string
}

// ── 辅助：清理 baseClass 的 IL2CPP 注释残留 ────────────────────────
// dump.cs 里类定义末尾带 "// TypeDefIndex: N"，解析后 baseClass 可能含这段
function cleanIdentifier(raw: string | null | undefined): string | null {
  if (!raw) return null
  const clean = raw.replace(/\/\/.*$/, "").replace(/<[^>]*>/g, "").trim()
  return /^\w+$/.test(clean) ? clean : null
}

// ── 辅助：判断是否是游戏业务类（通用，不限于 arrows） ──────────────
// 支持 Unity MonoBehaviour、ScriptableObject 以及 Entitas ECS 框架基类
const GAME_BASE_CLASSES = new Set([
  "MonoBehaviour", "ScriptableObject",
  "ReactiveSystem", "IExecuteSystem", "IInitializeSystem",
  "ICleanupSystem", "ITearDownSystem", "IReactiveSystem",
  "Feature", "Systems",
  "UiUnityView", "UnityView", "UnityViewProxy",
])

function isGameClass(c: ClassChunk): boolean {
  const base = cleanIdentifier(c.metadata.baseClass)
  return base !== null && GAME_BASE_CLASSES.has(base)
}

// ── 辅助：按顶层命名空间分组 ────────────────────────────────────────
function groupByModule(chunks: ClassChunk[]): Map<string, ClassChunk[]> {
  const modules = new Map<string, ClassChunk[]>()
  for (const c of chunks) {
    const mod = (c.metadata.namespace || "Root").split(".")[0] || "Root"
    if (!modules.has(mod)) modules.set(mod, [])
    modules.get(mod)!.push(c)
  }
  return modules
}

// ── 全量分析 ────────────────────────────────────────────────────────

async function runFullAnalysis(index: any, analysisDir: string, verbose: boolean) {
  const classChunks: ClassChunk[] = index.chunks.filter((c: any) => c.type === "class")
  const verifiedChunks: ClassChunk[] = index.chunks.filter((c: any) => c.type === "verified")
  const modules = groupByModule(classChunks)
  const written: string[] = []

  if (verbose) console.log(`[analyzer] 全量分析: ${classChunks.length} 类 / ${modules.size} 模块`)

  for (const [modName, classes] of modules.entries()) {
    const filePath = path.join(analysisDir, `${modName}-class-diagram.md`)
    await fs.writeFile(filePath, buildClassDiagram(`${modName} 模块类图`, classes, verifiedChunks))
    written.push(filePath)
  }

  const archPath = path.join(analysisDir, "architecture.md")
  await fs.writeFile(archPath, buildArchDiagram(modules, classChunks))
  written.push(archPath)

  const gameplayPath = path.join(analysisDir, "gameplay-design.md")
  await fs.writeFile(gameplayPath, buildGameplayDoc(classChunks, verifiedChunks))
  written.push(gameplayPath)

  return {
    output: `✅ 全量分析完成\n\n生成文件 (${written.length}):\n${written.map(f => `- ${path.basename(f)}`).join("\n")}`,
    files: written,
  }
}

// ── 增量分析（仅更新目标模块类图，不重建全局文档）────────────────────

async function runIncrementalAnalysis(index: any, analysisDir: string, className: string, verbose: boolean) {
  const classChunks: ClassChunk[] = index.chunks.filter((c: any) => c.type === "class")
  const verifiedChunks: ClassChunk[] = index.chunks.filter((c: any) => c.type === "verified")

  const target = classChunks.find(
    c => c.metadata.className === className || c.metadata.fullName?.endsWith(`.${className}`)
  )
  const moduleName = target
    ? (target.metadata.namespace || "Root").split(".")[0] || "Root"
    : "Root"

  if (verbose) console.log(`[analyzer] 增量更新模块: ${moduleName}`)

  const moduleClasses = classChunks.filter(
    c => (c.metadata.namespace || "Root").split(".")[0] === moduleName
  )

  const filePath = path.join(analysisDir, `${moduleName}-class-diagram.md`)
  await fs.writeFile(filePath, buildClassDiagram(`${moduleName} 模块类图`, moduleClasses, verifiedChunks))

  return {
    output: `✅ 增量分析完成 (${className} → 模块 ${moduleName})\n- ${path.basename(filePath)}`,
    updatedModule: moduleName,
    files: [filePath],
  }
}

// ── 类图（Mermaid classDiagram） ─────────────────────────────────────

function buildClassDiagram(title: string, classes: ClassChunk[], verifiedChunks: ClassChunk[]): string {
  const verifiedNames = new Set(verifiedChunks.map(c => c.metadata.className))
  const names = new Set(classes.map(c => c.metadata.className))
  const lines = [`# ${title}`, "", "```mermaid", "classDiagram"]

  for (const c of classes) {
    const name = c.metadata.className
    const base = cleanIdentifier(c.metadata.baseClass)
    const ifaces = (c.metadata.interfaces ?? [])
      .map(i => cleanIdentifier(i))
      .filter((i): i is string => i !== null && names.has(i))
    const isVerified = verifiedNames.has(name)

    lines.push(`  class ${name} {`)
    if (isVerified) lines.push(`    <<verified>>`)
    const fc = c.metadata.fieldCount ?? 0
    const mc = c.metadata.methodCount ?? 0
    if (fc > 0) lines.push(`    +${fc} fields`)
    if (mc > 0) lines.push(`    +${mc} methods()`)
    lines.push(`  }`)

    if (base && base !== "Object" && base !== "ValueType" && names.has(base))
      lines.push(`  ${base} <|-- ${name}`)
    for (const iface of ifaces)
      lines.push(`  ${iface} <|.. ${name} : implements`)
  }

  lines.push("```", "", `> ${classes.length} 个类 | 更新: ${new Date().toISOString().slice(0, 10)}`)
  return lines.join("\n")
}

// ── 架构图（Mermaid graph TD）────────────────────────────────────────

function buildArchDiagram(modules: Map<string, ClassChunk[]>, classChunks: ClassChunk[]): string {
  const classToMod = new Map<string, string>()
  for (const [mod, classes] of modules.entries())
    for (const c of classes) {
      classToMod.set(c.metadata.className, mod)
      if (c.metadata.fullName) classToMod.set(c.metadata.fullName, mod)
    }

  const edges = new Set<string>()
  for (const [mod, classes] of modules.entries())
    for (const c of classes)
      for (const dep of (c.metadata.dependencies ?? [])) {
        const dm = classToMod.get(dep)
        if (dm && dm !== mod) edges.add(`  ${mod} --> ${dm}`)
      }

  const lines = ["# 架构图", "", "> 模块间依赖关系（箭头：依赖方 → 被依赖方）", "", "```mermaid", "graph TD"]
  for (const [mod, classes] of modules.entries())
    lines.push(`  ${mod}["${mod}\\n(${classes.length} 类)"]`)
  for (const edge of edges) lines.push(edge)
  lines.push("```", "", `> 更新: ${new Date().toISOString().slice(0, 10)}`)
  return lines.join("\n")
}

// ── 核心玩法方案文档 ─────────────────────────────────────────────────

function buildGameplayDoc(classChunks: ClassChunk[], verifiedChunks: ClassChunk[]): string {
  const verifiedMap = new Map(verifiedChunks.map(c => [c.metadata.className, c]))

  // 游戏类：继承自 GAME_BASE_CLASSES 且类名有业务含义
  const kw = /Controller|Manager|System|Game|Player|Battle|Combat|Skill|Level|Stage|Wave|Enemy|Spawn|UI|HUD|View|Feature|Arrow/i
  const coreClasses = classChunks.filter(c => isGameClass(c) && kw.test(c.metadata.className ?? ""))

  const groups: Array<{ name: string; pattern: RegExp | null; classes: ClassChunk[] }> = [
    { name: "GameFlow（主流程）", pattern: /Game|Level|Stage|Wave|Spawn/i, classes: [] },
    { name: "核心玩法", pattern: /Arrow|Combat|Battle|Skill|Attack|Damage/i, classes: [] },
    { name: "Player（玩家）", pattern: /Player|Character/i, classes: [] },
    { name: "UI（界面）", pattern: /UI|HUD|Panel|Menu|Screen|View|Display/i, classes: [] },
    { name: "其他系统", pattern: null, classes: [] },
  ]

  for (const c of coreClasses) {
    const mi = groups.slice(0, -1).findIndex(g => g.pattern!.test(c.metadata.className ?? ""))
    groups[mi === -1 ? groups.length - 1 : mi].classes.push(c)
  }

  const lines = [
    "# 核心玩法方案",
    "",
    `> 自动分析自 IL2CPP dump.cs，共识别 ${coreClasses.length} 个核心玩法类`,
    `> 更新: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "---",
    "",
  ]

  for (const g of groups) {
    if (!g.classes.length) continue
    lines.push(`## ${g.name}（${g.classes.length} 个类）`, "")

    // 时序图
    const names = g.classes.slice(0, 5).map(c => c.metadata.className)
    lines.push("### 交互时序图", "", "```mermaid", "sequenceDiagram")
    for (const n of names) lines.push(`  participant ${n}`)
    for (const c of g.classes.slice(0, 5))
      for (const dep of (c.metadata.dependencies ?? []))
        if (names.includes(dep)) {
          lines.push(`  ${c.metadata.className}->>+${dep}: 调用`)
          lines.push(`  ${dep}-->>-${c.metadata.className}: 返回`)
        }
    lines.push("```", "")

    // 类清单
    lines.push("### 类清单", "", "| 类名 | 字段 | 方法 | 复杂度 | 已验证 | 基类 |", "|------|------|------|--------|--------|------|")
    for (const c of g.classes) {
      const base = cleanIdentifier(c.metadata.baseClass) ?? "-"
      const isV = verifiedMap.has(c.metadata.className) ? "✅" : "⬜"
      lines.push(`| \`${c.metadata.className}\` | ${c.metadata.fieldCount ?? "-"} | ${c.metadata.methodCount ?? "-"} | ${c.metadata.complexity ?? "-"} | ${isV} | ${base} |`)
    }
    lines.push("")

    // 状态机：从类名推断（类名含 State/Phase/Stage/Status 词才生成）
    const stateClasses = g.classes.filter(c => /State|Phase|Stage|Status/i.test(c.metadata.className ?? ""))
    if (stateClasses.length > 0) {
      lines.push("### 状态机推断", "")
      lines.push("```mermaid", "stateDiagram-v2")
      lines.push("  [*] --> Idle", "  Idle --> Active : 开始", "  Active --> Paused : 暂停", "  Paused --> Active : 恢复", "  Active --> [*] : 结束")
      lines.push("```", "", `> 注：基于类名关键词推断（${stateClasses.map(c => c.metadata.className).join(", ")}），需人工验证`, "")
    }

    // 已验证摘要
    const vi = g.classes.filter(c => verifiedMap.has(c.metadata.className))
    if (vi.length) {
      lines.push("### 已验证实现摘要", "")
      for (const c of vi) {
        const code = (verifiedMap.get(c.metadata.className) as any).content as string
        lines.push(`#### \`${c.metadata.className}\``, "", "```csharp", code.slice(0, 500), "// ...", "```", "")
      }
    }

    lines.push("---", "")
  }

  return lines.join("\n")
}
