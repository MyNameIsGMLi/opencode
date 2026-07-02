import { tool } from "@opencode-ai/plugin"
import * as path from "path"
import { migrateV1toV2, isV2, decompressArray } from "./unity-rag-cache"
import { judgeNeedsIDA as judgeNeedsIDAfromCore } from "./unity-rag-core"
import {
  getUsedBy, getPriorityLabel, detectPatternsFromXrefs, type XrefsIndex,
} from "./unity-rag-xrefs"

/**
 * Unity RAG 智能检索器
 *
 * 功能：
 * 1. 多层次混合检索（结构化 + 语义）
 * 2. 智能判断是否需要 IDA
 * 3. 融合 Xrefs 数据（使用示例 + 优先级 + 额外模式检测）
 * 4. 生成优化的 AI Prompt
 */

export default tool({
  description: `Unity RAG 智能检索器 - 为代码生成提供最优上下文。

自动检索并组装：
- 目标类的完整定义
- 基类和接口实现
- 相似的已验证代码
- IDA 伪代码（按需）
- Xrefs 使用示例和优先级（增强 AI Context）`,

  args: {
    projectDir: tool.schema.string().describe("Unity 项目根目录"),
    className: tool.schema.string().describe("要实现的类名"),
    forceIDA: tool.schema.boolean().optional().describe("强制获取 IDA 分析（默认智能判断）"),
    verbose: tool.schema.boolean().optional().describe("显示详细检索过程"),
  },

  async execute(args, ctx) {
    const ragDir = path.join(args.projectDir, ".opencode", "rag")
    const indexPath = path.join(ragDir, "index.json")

    // ── 加载索引（v1/v2 自动识别）────────────────────────────────────
    let index: any
    try {
      const raw = JSON.parse(await Bun.file(indexPath).text())
      index = isV2(raw) ? raw : migrateV1toV2(raw)
    } catch {
      return { error: "RAG 索引不存在，请先运行: /impl-unity --init" }
    }

    // ── 加载 Xrefs（可选，不存在时降级）─────────────────────────────
    let xrefs: XrefsIndex | null = null
    try {
      xrefs = JSON.parse(await Bun.file(path.join(ragDir, "xrefs.json")).text())
    } catch {
      // xrefs 不存在时降级，不影响基础功能
    }

    const retrievalLog: string[] = []
    const log = (msg: string) => {
      if (args.verbose) retrievalLog.push(msg)
    }

    // ── 热数据：classes / verified（直接访问，无需解压）──────────────
    const allClasses  = index.hotChunks?.classes  ?? index.chunks?.filter((c: any) => c.type === "class")  ?? []
    const allVerified = index.hotChunks?.verified ?? index.chunks?.filter((c: any) => c.type === "verified") ?? []

    // ==================== 阶段 1: 查找目标类 ====================
    log(`[1/6] 查找目标类: ${args.className}`)

    // 同名 chunk 可能有多个（主类 + 编译器生成的协程/闭包状态机如 <Method>d__N）。
    // 必须选"主类"chunk：排除嵌套/状态机（baseClass 为 IEnumerator/IEnumerable 或名字带 <>），
    // 在剩余中取方法数最多者（主类方法数远多于状态机）。
    const candidates = allClasses.filter(
      (c: any) =>
        c.metadata.className === args.className ||
        c.metadata.fullName?.endsWith(`.${args.className}`),
    )

    if (candidates.length === 0) {
      return {
        error: `未找到类: ${args.className}`,
        suggestion: "请检查类名是否正确，或使用 search 操作查找",
      }
    }

    const isStateMachine = (c: any) =>
      /^IEnumerator|^IEnumerable/.test(c.metadata?.baseClass || "") ||
      /[<>]|d__\d+|DisplayClass/.test(c.metadata?.fullName || "")
    const mainCandidates = candidates.filter((c: any) => !isStateMachine(c))
    const pool = mainCandidates.length > 0 ? mainCandidates : candidates
    const targetChunk = pool.sort(
      (a: any, b: any) => (b.metadata?.methodCount || 0) - (a.metadata?.methodCount || 0),
    )[0]

    log(`✓ 找到: ${targetChunk.metadata.fullName}`)

    // ==================== 阶段 2: 智能判断是否需要 IDA ====================
    log(`[2/6] 智能判断是否需要 IDA`)

    const needsIDA = args.forceIDA || judgeNeedsIDAfromCore(targetChunk, allVerified)
    log(`✓ 判断结果: ${needsIDA ? "需要 IDA" : "不需要 IDA"}`)

    // ==================== 阶段 3: 检索依赖类 ====================
    log(`[3/6] 检索依赖类（基类、接口）`)

    const dependencies: any[] = []
    const deps = targetChunk.metadata.dependencies || []

    for (const dep of deps) {
      const depChunk = allClasses.find(
        (c: any) => c.metadata.fullName === dep || c.metadata.className === dep,
      )
      if (depChunk) {
        dependencies.push(depChunk)
        const verifiedDep = allVerified.find((c: any) => c.metadata.className === dep)
        if (verifiedDep) dependencies.push(verifiedDep)
      }
    }

    log(`✓ 找到 ${dependencies.length} 个依赖`)

    // ==================== 阶段 4: 检索相似的已验证类 ====================
    log(`[4/6] 检索相似的已验证代码`)

    const similarVerified = allVerified
      .filter((c: any) => {
        if (c.metadata.className === args.className) return false
        if (c.metadata.namespace === targetChunk.metadata.namespace) return true
        const targetSuffix  = args.className.replace(/.*[A-Z]/, "")
        const candidateSuffix = c.metadata.className?.replace(/.*[A-Z]/, "")
        return targetSuffix.length > 3 && targetSuffix === candidateSuffix
      })
      .slice(0, 3)

    log(`✓ 找到 ${similarVerified.length} 个相似已验证类`)

    // ==================== 阶段 5: IDA 分析（冷数据，按需解压）====================
    let idaData: any = null

    if (needsIDA) {
      log(`[5/6] 检索 IDA 分析`)
      // IDA 是 blob，整体解压后按类名查找
      const idaChunks = decompressArray(index.coldChunks?.idaBlob ?? "")
      idaData = idaChunks.find((c: any) => c.metadata?.className === args.className) ?? null

      if (idaData) log(`✓ 找到已缓存的 IDA 分析`)
      else log(`⚠ 未找到 IDA 分析，需要按需获取`)
    } else {
      log(`[5/6] 跳过 IDA 分析（不需要）`)
    }

    // ==================== 阶段 6: 检测设计模式 ====================
    log(`[6/6] 检测设计模式`)

    const patterns = detectPatterns(targetChunk)
    log(`✓ 检测到 ${patterns.length} 个模式`)

    // ==================== 阶段 X: 融合 Xrefs ====================
    let xrefsContext: {
      priority: string
      usedBy: any[]
      xrefPatterns: Array<{ name: string; description: string; evidence: string }>
    } | null = null

    if (xrefs) {
      log(`[X] 融合交叉引用数据`)
      const fullName = targetChunk.metadata.fullName ?? args.className
      xrefsContext = {
        priority:     getPriorityLabel(xrefs, fullName),
        usedBy:       getUsedBy(xrefs, fullName, 5),
        xrefPatterns: detectPatternsFromXrefs(xrefs, fullName),
      }
      log(`✓ 优先级: ${xrefsContext.priority}，被引用 ${xrefsContext.usedBy.length} 处`)
    }

    // ==================== 生成优化的 Prompt ====================

    const context = {
      targetClass: targetChunk,
      dependencies,
      similarVerified,
      idaData,
      patterns,
      needsIDA,
      xrefsContext,
    }

    const prompt = generatePrompt(context)

    // ==================== 返回结果 ====================

    const summary = [
      `✅ 智能检索完成: ${args.className}`,
      "",
      "📊 检索统计:",
      `- 目标类: ${targetChunk.metadata.fullName}`,
      `- 依赖类: ${dependencies.length}`,
      `- 相似已验证: ${similarVerified.length}`,
      `- IDA 分析: ${idaData ? "✓ 已缓存" : needsIDA ? "⚠ 需要获取" : "✗ 不需要"}`,
      `- 设计模式: ${patterns.length + (xrefsContext?.xrefPatterns.length ?? 0)}`,
      xrefsContext ? `- 优先级: ${xrefsContext.priority}` : "",
      xrefsContext?.usedBy.length ? `- Xrefs 使用示例: ${xrefsContext.usedBy.length} 处` : "",
      "",
      "🎯 推荐策略:",
      needsIDA && !idaData ? "⚠ 建议先获取 IDA 分析以提高准确率" : "✓ 可直接生成代码",
      args.verbose ? `\n📝 检索日志:\n${retrievalLog.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n")

    return {
      output: summary,
      context,
      prompt,
      needsIDAFetch: needsIDA && !idaData,
    }
  },
})

// ==================== 模式检测（基于类结构）====================

function detectPatterns(
  targetChunk: any,
): Array<{ name: string; description: string; evidence: string }> {
  const patterns: Array<{ name: string; description: string; evidence: string }> = []
  const className = targetChunk.metadata.className || ""
  const baseClass  = targetChunk.metadata.baseClass

  // 单例
  if (className.includes("Manager") || className.includes("Service") || className.includes("System")) {
    const hasInstance = targetChunk.metadata.fields?.some(
      (f: any) => f.name === "Instance" || f.name === "_instance",
    )
    if (hasInstance)
      patterns.push({
        name: "Singleton",
        description: "单例模式 - 全局唯一实例",
        evidence: "检测到 Instance 字段和 Manager/Service 命名",
      })
  }

  // 对象池
  if (className.includes("Pool"))
    patterns.push({ name: "ObjectPool", description: "对象池模式 - 复用对象避免 GC", evidence: "类名包含 Pool" })

  // 观察者
  if (className.includes("Event") || className.includes("Listener"))
    patterns.push({ name: "Observer", description: "观察者模式 - 事件订阅/发布", evidence: "类名包含 Event/Listener" })

  // 工厂
  if (className.includes("Factory") || className.includes("Builder"))
    patterns.push({ name: "Factory", description: "工厂模式 - 对象创建封装", evidence: "类名包含 Factory/Builder" })

  // Unity 组件
  if (baseClass === "MonoBehaviour" || baseClass === "ScriptableObject")
    patterns.push({
      name: "UnityComponent",
      description: `Unity ${baseClass} 组件`,
      evidence: `继承自 ${baseClass}`,
    })

  return patterns
}

// ==================== Token 预算管理 ====================

const CHAR_BUDGET = 400_000 // ≈ 100K tokens (1 token ≈ 4 chars)

function estimateChars(s: string): number {
  return s.length
}

// ==================== Prompt 生成（带 Token 预算） ====================

function generatePrompt(context: any): string {
  const { targetClass, dependencies, similarVerified, idaData, patterns, xrefsContext } = context
  const allPatterns = [...patterns, ...(xrefsContext?.xrefPatterns ?? [])]

  let used = 0
  const sections: string[] = []

  const push = (s: string) => {
    used += estimateChars(s)
    sections.push(s)
  }

  // ── 必须保留：目标类 + 基本信息 ─────────────────────────────────
  const header = [
    `# 任务：重建 Unity C# 类`,
    ``,
    `## 目标类`,
    `\`\`\`csharp`,
    targetClass.content,
    `\`\`\``,
    ``,
    `**完整路径**: ${targetClass.metadata.fullName}`,
    `**命名空间**: ${targetClass.metadata.namespace}`,
    `**字段数**: ${targetClass.metadata.fieldCount}`,
    `**方法数**: ${targetClass.metadata.methodCount}`,
    `**复杂度**: ${targetClass.metadata.complexity}`,
    xrefsContext ? `**优先级**: ${xrefsContext.priority}` : "",
    ``,
  ].filter(Boolean).join("\n")
  push(header)

  // ── IDA 伪代码（完整保留，最重要）──────────────────────────────
  if (idaData) {
    const idaSection = [
      `## IDA Pro 伪代码（真实逻辑）`,
      ``,
      `**重要**: 以下是从二进制反编译的真实代码逻辑，请严格参考实现。`,
      ``,
      `\`\`\`c`,
      idaData.content.slice(0, 8000),  // IDA 伪代码上限 8000 字符
      `\`\`\``,
      ``,
    ].join("\n")
    push(idaSection)
  }

  // ── Xrefs 使用示例（最多 5 条，帮助 AI 推断方法契约）───────────
  if (xrefsContext?.usedBy?.length && used < CHAR_BUDGET) {
    const xrefsSection = [
      `## 引用关系（其他类如何使用本类）`,
      ``,
      `> 以下信息揭示了本类的实际使用场景，帮助推断方法的预期行为。`,
      ``,
      ...xrefsContext.usedBy.slice(0, 5).map((u: any) => {
        const callerShort = (u.fromClass || "").split(".").pop() || u.fromClass || "?"
        const rel = u.type === "inheritance" ? `继承了本类`
          : u.type === "interface" ? `实现了本类接口`
          : u.type === "fieldType" ? `持有本类作为字段 (${u.detail ?? ""})`
          : u.type === "methodParam" ? `将本类作为方法参数 (${u.detail ?? ""})`
          : `方法返回本类 (${u.detail ?? ""})`
        return `- \`${callerShort}\` ${rel}`
      }),
      ``,
    ].join("\n")
    if (used + estimateChars(xrefsSection) < CHAR_BUDGET) push(xrefsSection)
  }

  // ── 相似已验证代码（每个 2000 字符上限，最多 3 个）─────────────
  if (similarVerified?.length && used < CHAR_BUDGET) {
    const verifiedHeader = `## 相似的已验证实现（参考）\n\n`
    push(verifiedHeader)
    for (const similar of similarVerified.slice(0, 3)) {
      const s = [
        `### ${similar.metadata.className}`,
        `命名空间: ${similar.metadata.namespace}`,
        `\`\`\`csharp`,
        similar.content.slice(0, 2000),
        similar.content.length > 2000 ? `// ...（已截断）` : "",
        `\`\`\``,
        ``,
      ].filter(Boolean).join("\n")
      if (used + estimateChars(s) < CHAR_BUDGET) push(s)
    }
  }

  // ── 依赖类参考（每个 800 字符上限，最多 3 个）──────────────────
  if (dependencies?.length && used < CHAR_BUDGET) {
    const depsHeader = `## 依赖类参考\n\n`
    push(depsHeader)
    for (const dep of dependencies.slice(0, 3)) {
      const content = dep.type === "verified"
        ? dep.content.slice(0, 800)
        : dep.content
      const s = [
        `### ${dep.metadata.className || dep.metadata.fullName}${dep.type === "verified" ? " (已验证实现)" : ""}`,
        `\`\`\`csharp`,
        content,
        content.length === 800 ? `// ...` : "",
        `\`\`\``,
        ``,
      ].filter(Boolean).join("\n")
      if (used + estimateChars(s) < CHAR_BUDGET) push(s)
    }
  }

  // ── 设计模式（结构检测 + Xrefs 推断合并）───────────────────────
  if (allPatterns.length > 0 && used < CHAR_BUDGET) {
    const patternSection = [
      `## 检测到的设计模式`,
      ``,
      ...allPatterns.map(p => `### ${p.name}\n${p.description}\n证据: ${p.evidence}`),
      ``,
    ].join("\n")
    if (used + estimateChars(patternSection) < CHAR_BUDGET) push(patternSection)
  }

  // ── 实现要求（必须保留）────────────────────────────────────────
  const requirements = [
    `## 实现要求`,
    ``,
    `1. **零 TODO/Stub**: 所有方法必须有完整实现，不允许空方法或 TODO 注释`,
    `2. **命名一致**: 字段名、方法名必须与 dump.cs 完全一致`,
    `3. **Unity 生命周期**: 如果继承 MonoBehaviour，正确实现 Awake/Start/Update 等`,
    `4. **设计模式**: 遵循检测到的设计模式实现`,
    idaData ? `5. **IDA 逻辑优先**: 有 IDA 伪代码的方法，必须按伪代码逻辑实现` : "",
    xrefsContext?.usedBy?.length
      ? `6. **引用契约**: 参考[引用关系]中的使用示例，确保公共方法的签名和行为符合调用方预期`
      : "",
    ``,
    `## 输出格式`,
    ``,
    `直接输出完整的 C# 代码，包含：`,
    `- 正确的命名空间`,
    `- 所有 using 引用`,
    `- 完整的类实现`,
    `- 所有字段初始化`,
    `- 所有方法的完整逻辑`,
    ``,
    `开始生成：`,
  ].filter(Boolean).join("\n")
  sections.push(requirements)

  return sections.join("\n")
}
