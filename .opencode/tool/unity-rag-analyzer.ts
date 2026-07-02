import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"
import { loadProjectConfig, resolveAnalysisDir } from "./unity-project-config"
import { isV2, migrateV1toV2 } from "./unity-rag-cache"

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

    const raw = await Bun.file(indexPath).json()
    const index = isV2(raw) ? raw : migrateV1toV2(raw)

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
  const classChunks: ClassChunk[] = index.hotChunks?.classes ?? []
  const verifiedChunks: ClassChunk[] = index.hotChunks?.verified ?? []
  const modules = groupByModule(classChunks)
  const written: string[] = []

  if (verbose) console.log(`[analyzer] 全量分析: ${classChunks.length} 类 / ${modules.size} 模块`)

  for (const [modName, classes] of modules.entries()) {
    const filePath = path.join(analysisDir, `${modName}-class-diagram.md`)
    await fs.writeFile(filePath, buildClassDiagram(`${modName} 模块类图`, classes, verifiedChunks))
    written.push(filePath)
  }

  const archPath = path.join(analysisDir, "architecture.md")
  await fs.writeFile(archPath, buildArchDiagram(modules))
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
  const classChunks: ClassChunk[] = index.hotChunks?.classes ?? []
  const verifiedChunks: ClassChunk[] = index.hotChunks?.verified ?? []

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

function buildArchDiagram(modules: Map<string, ClassChunk[]>): string {
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

// ── 核心玩法学习文档骨架 ─────────────────────────────────────────────────
//
// 设计原则：真正的"玩法学习材料"（玩法怎么设计/详细逻辑/表现对应）需要 AI 基于
// IDA+代码+精确数值深度理解后撰写，工具无法自动生成深度内容。
// 因此本函数产出**结构化骨架 + 真实数据钩子 + 待 AI 填充的深度解析标记**，
// 由 code-generator/分析流程在阶段 B 填充每个 <!-- AI填充 --> 章节的真实玩法解析。

function buildGameplayDoc(classChunks: ClassChunk[], verifiedChunks: ClassChunk[]): string {
  const verifiedMap = new Map(verifiedChunks.map(c => [c.metadata.className, c]))
  const verified = classChunks.filter(c => verifiedMap.has(c.metadata.className))

  const lines: string[] = [
    "# 核心玩法解析",
    "",
    "> 学习材料：玩法机制 + 详细逻辑流程（含精确数值）+ 逻辑↔表现对应。",
    "> 代码佐证位于 `Assets/Scripts/Generated/`，文档与代码逐点交叉引用（`类名.cs:行号`）。",
    `> 更新: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "---",
    "",
    "## 1. 玩法机制总览",
    "",
    "<!-- AI填充：这个游戏怎么玩？核心循环是什么？一句话玩法定义 + 核心循环图。 -->",
    "",
    "```mermaid",
    "flowchart LR",
    "  A[生成砖块] --> B[玩家移动/旋转]",
    "  B --> C[下落]",
    "  C --> D{能否继续下落?}",
    "  D -->|能| C",
    "  D -->|落定| E[消行判定]",
    "  E --> F[计分/难度推进]",
    "  F --> A",
    "  E --> G{触顶?}",
    "  G -->|是| H[游戏结束]",
    "```",
    "> 上图为骨架，AI 需按实际核心类调用链校正。",
    "",
    "---",
    "",
    "## 2. 详细逻辑流程",
    "",
    "<!-- AI填充：按核心玩法闭环逐环节展开。每个环节包含：",
    "  - 触发条件与控制流（对应 IDA 方法 + 代码行号）",
    "  - 精确数值表（速度/延迟/门槛等，标注 A1 解码来源）",
    "  - Mermaid 时序图或状态图",
    "-->",
    "",
    "### 2.1 砖块生成",
    "<!-- AI填充：形状数据(BRICK_POS精确值)、生成位置、随机规则 -->",
    "",
    "### 2.2 移动与旋转",
    "<!-- AI填充：左右移动的首延迟/重复延迟(MOVE_DELAY精确值)、旋转轴心(CENTER_POINTS) -->",
    "",
    "### 2.3 下落与落定",
    "<!-- AI填充：下落速度曲线、dwell 落定判定、sentinel字段语义+证据 -->",
    "",
    "### 2.4 消行与计分",
    "<!-- AI填充：满行检测、连锁下落、计分公式(精确系数) -->",
    "",
    "### 2.5 难度与解锁",
    "<!-- AI填充：难度曲线(CalculateSpeed精确值)、星级门槛(UNLOCK_STARS精确值) -->",
    "",
    "---",
    "",
    "## 3. 逻辑 ↔ 表现对应表",
    "",
    "<!-- AI填充：每个逻辑事件对应的屏幕表现（动画/音效/UI/位移），可附截图位 -->",
    "",
    "| 逻辑事件 | 触发方法 (代码行) | 屏幕表现 | 音效 | 截图 |",
    "|---------|------------------|---------|------|------|",
    "| 砖块落定 | `Brick.cs:???` | 高亮闪烁 0.2s 后恢复 | BrickStop | _待补_ |",
    "| ... | ... | ... | ... | ... |",
    "",
    "---",
    "",
    "## 附录：已实现核心类索引",
    "",
    "| 类名 | 方法数 | 字段数 | 基类 | 代码文件 |",
    "|------|--------|--------|------|---------|",
  ]

  for (const c of verified.sort((a, b) => (b.metadata.methodCount ?? 0) - (a.metadata.methodCount ?? 0))) {
    const base = cleanIdentifier(c.metadata.baseClass) ?? "-"
    lines.push(
      `| \`${c.metadata.className}\` | ${c.metadata.methodCount ?? "-"} | ${c.metadata.fieldCount ?? "-"} | ${base} | \`Generated/${c.metadata.className}.cs\` |`,
    )
  }

  if (verified.length === 0) {
    lines.push("| _（尚无已验证实现，阶段 B 生成后填充）_ | | | | |")
  }

  lines.push("", "---", "", "> 注：本文档骨架由 unity-rag-analyzer 生成，`<!-- AI填充 -->` 标记处由分析流程")
  lines.push("> 基于 IDA 伪代码 + A1 精确数值 + 已验证代码深度撰写，确保逻辑与数值 100% 精确。")

  return lines.join("\n")
}
