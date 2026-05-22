import { tool } from "@opencode-ai/plugin"
import * as path from "path"

// ── 数据结构 ────────────────────────────────────────────────────────────────
//
// Xrefs 是 GraphRAG 思想的轻量实现：
//   - 从 dump.cs 静态分析提取（100% 准确，零 LLM 成本）
//   - 支持 5 种关系类型（inheritance / interface / fieldType / methodParam / methodReturn）
//   - 双向索引（forward + backward）
//   - backward 是 AI 生成的核心价值：知道"谁在用这个类"，帮助 AI 推断方法契约

export type XrefType =
  | "inheritance"   // A : B（继承）
  | "interface"     // A : I（接口实现）
  | "fieldType"     // class A { B field; }
  | "methodParam"   // void Method(B param)
  | "methodReturn"  // B Method()

export interface XrefEntry {
  fromClass: string   // 完整类名（含命名空间）
  toClass: string     // 完整类名（含命名空间）
  type: XrefType
  detail?: string     // 例如 "field playerData"、"method TakeDamage"
}

export interface XrefsIndex {
  version: string
  createdAt: string
  updatedAt: string
  // 正向：某类 → 它依赖了哪些类
  forward: Record<string, XrefEntry[]>
  // 反向：某类 → 哪些类依赖了它（AI Context 核心）
  backward: Record<string, XrefEntry[]>
  stats: {
    totalXrefs: number
    byType: Record<XrefType, number>
    // 被引用最多的 Top 100（含引用计数）
    topReferenced: Array<{ className: string; refCount: number }>
  }
}

// ClassInfo 的最小接口（与 unity-rag-core 解耦，避免循环依赖）
export interface ClassInfoLike {
  name: string
  namespace: string
  fullName: string
  baseClass: string | null
  interfaces: string[]
  fields: Array<{ name: string; type: string }>
  methods: Array<{ name: string; returnType: string; parameters: string[] }>
}

// ── 构建函数 ────────────────────────────────────────────────────────────────

/**
 * 从 dump.cs 解析结果构建交叉引用索引
 *
 * 时间复杂度：O(C * (F + M * P))
 *   C = 类数，F = 平均字段数，M = 平均方法数，P = 平均参数数
 * 对于 arrows_unity_project（16K 类，97K 方法）约 1-3 秒
 */
export function buildXrefsIndex(classes: ClassInfoLike[]): XrefsIndex {
  // ── 名称解析表 ──────────────────────────────────────────────────
  // 短名 → fullName 列表（同名类取第一个，IL2CPP 极少同名）
  const nameMap = new Map<string, string[]>()
  for (const cls of classes) {
    ;(nameMap.get(cls.name) ?? nameMap.set(cls.name, []).get(cls.name)!).push(cls.fullName)
    // fullName 也作为 key（精确匹配）
    nameMap.set(cls.fullName, [cls.fullName])
  }

  // ── 双向索引 ────────────────────────────────────────────────────
  const forward: Record<string, XrefEntry[]> = {}
  const backward: Record<string, XrefEntry[]> = {}

  const addXref = (entry: XrefEntry) => {
    ;(forward[entry.fromClass]  ??= []).push(entry)
    ;(backward[entry.toClass]   ??= []).push(entry)
  }

  // 清理类型名：去除泛型 <T>、数组 []，返回基础类型名
  const cleanType = (t: string) =>
    t.replace(/[\[\]]/g, "").replace(/<[^>]*>/g, "").trim()

  // 解析类型名 → fullName（查 nameMap）
  const resolve = (typeName: string): string | null => {
    const cleaned = cleanType(typeName)
    if (!cleaned || cleaned.length < 2) return null
    const hits = nameMap.get(cleaned)
    return hits?.[0] ?? null
  }

  for (const cls of classes) {
    const from = cls.fullName

    // 1. 继承
    if (cls.baseClass) {
      const to = resolve(cls.baseClass)
      if (to && to !== from) addXref({ fromClass: from, toClass: to, type: "inheritance" })
    }

    // 2. 接口实现
    for (const iface of cls.interfaces) {
      const to = resolve(iface)
      if (to && to !== from) addXref({ fromClass: from, toClass: to, type: "interface" })
    }

    // 3. 字段类型
    for (const field of cls.fields) {
      const to = resolve(field.type)
      if (to && to !== from)
        addXref({ fromClass: from, toClass: to, type: "fieldType", detail: `field ${field.name}` })
    }

    // 4. 方法参数 + 5. 返回类型
    for (const method of cls.methods) {
      // 参数：格式为 "Type name" 或 "Type"
      for (const param of method.parameters) {
        const paramType = param.trim().split(/\s+/)[0] ?? ""
        const to = resolve(paramType)
        if (to && to !== from)
          addXref({ fromClass: from, toClass: to, type: "methodParam", detail: `method ${method.name}` })
      }
      // 返回类型
      if (method.returnType && method.returnType !== "void") {
        const to = resolve(method.returnType)
        if (to && to !== from)
          addXref({ fromClass: from, toClass: to, type: "methodReturn", detail: `method ${method.name}` })
      }
    }
  }

  // ── 统计 ────────────────────────────────────────────────────────
  const byType: Record<XrefType, number> = {
    inheritance: 0, interface: 0, fieldType: 0, methodParam: 0, methodReturn: 0,
  }
  let totalXrefs = 0
  for (const entries of Object.values(forward)) {
    for (const e of entries) {
      byType[e.type]++
      totalXrefs++
    }
  }

  const topReferenced = Object.entries(backward)
    .map(([className, refs]) => ({ className, refCount: refs.length }))
    .sort((a, b) => b.refCount - a.refCount)
    .slice(0, 100)

  return {
    version: "1.0.0",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    forward,
    backward,
    stats: { totalXrefs, byType, topReferenced },
  }
}

// ── 查询 API（供 unity-rag-retriever 使用）──────────────────────────────────

/** 获取某类的使用者列表（反向引用，最多 limit 条） */
export function getUsedBy(
  xrefs: XrefsIndex,
  fullName: string,
  limit = 10,
): XrefEntry[] {
  return (xrefs.backward[fullName] ?? []).slice(0, limit)
}

/** 获取某类依赖的类列表（正向引用） */
export function getUses(xrefs: XrefsIndex, fullName: string): XrefEntry[] {
  return xrefs.forward[fullName] ?? []
}

/**
 * 多跳传递依赖（BFS）
 * types 限定关系类型，默认只跟踪数据依赖（fieldType + methodParam）
 */
export function getTransitiveDeps(
  xrefs: XrefsIndex,
  fullName: string,
  maxDepth = 3,
  types: XrefType[] = ["fieldType", "methodParam"],
): string[] {
  const visited = new Set<string>()
  const queue: Array<{ name: string; depth: number }> = [{ name: fullName, depth: 0 }]
  while (queue.length > 0) {
    const { name, depth } = queue.shift()!
    if (visited.has(name) || depth > maxDepth) continue
    visited.add(name)
    for (const entry of (xrefs.forward[name] ?? []).filter(e => types.includes(e.type)))
      queue.push({ name: entry.toClass, depth: depth + 1 })
  }
  visited.delete(fullName)
  return Array.from(visited)
}

/**
 * 优先级标签
 * 被引用次数越多 = 越核心 = 越应该优先实现
 */
export function getPriorityLabel(xrefs: XrefsIndex, fullName: string): string {
  const count = (xrefs.backward[fullName] ?? []).length
  if (count > 50) return `🔥 核心类 (被 ${count} 个类引用)`
  if (count > 10) return `⭐ 常用类 (被 ${count} 个类引用)`
  if (count > 0)  return `📌 普通类 (被 ${count} 个类引用)`
  return "⚪ 叶子类 (无引用)"
}

/**
 * 基于 Xrefs 推断额外设计模式
 * 配合 unity-rag-retriever 中已有的模式检测使用
 */
export function detectPatternsFromXrefs(
  xrefs: XrefsIndex,
  fullName: string,
): Array<{ name: string; description: string; evidence: string }> {
  const patterns: Array<{ name: string; description: string; evidence: string }> = []
  const usages = xrefs.backward[fullName] ?? []

  // 被 20+ 个类的字段引用 → 共享数据类 / 可能是 Singleton 持有对象
  if (usages.length > 20) {
    const fieldRefs = usages.filter(u => u.type === "fieldType")
    if (fieldRefs.length > usages.length * 0.7)
      patterns.push({
        name: "SharedData",
        description: "共享数据类 - 被大量类持有为字段",
        evidence: `被 ${fieldRefs.length} 个类的字段引用`,
      })
  }

  // 被 5+ 个方法返回 → 工厂产出物
  const returnRefs = usages.filter(u => u.type === "methodReturn")
  if (returnRefs.length > 5)
    patterns.push({
      name: "FactoryProduct",
      description: "工厂产出类 - 多个方法返回此类型",
      evidence: `被 ${returnRefs.length} 个方法返回`,
    })

  // 被 10+ 个类继承或实现 → 抽象基类/接口
  const inheritRefs = usages.filter(u => u.type === "inheritance" || u.type === "interface")
  if (inheritRefs.length > 10)
    patterns.push({
      name: "BaseClass",
      description: "基类/接口 - 被大量类继承或实现",
      evidence: `被 ${inheritRefs.length} 个类继承/实现`,
    })

  return patterns
}

// ── MCP Tool（独立查询工具）────────────────────────────────────────────────

export default tool({
  description: `Unity RAG 交叉引用查询 - 查询类的引用关系，为 AI 生成提供更丰富上下文。

支持操作：
- query: 查询某类的使用者/依赖（正向+反向）
- stats: 查看 Top 被引用类 + 各类型引用数
- transitive: 获取传递依赖链（BFS 多跳）`,

  args: {
    action: tool.schema
      .enum(["query", "stats", "transitive"])
      .describe("操作类型"),
    projectDir: tool.schema.string().describe("Unity 项目根目录"),
    className: tool.schema.string().optional().describe("类名（query/transitive 必填）"),
    limit: tool.schema.number().optional().describe("最大返回数量（默认 10）"),
    maxDepth: tool.schema.number().optional().describe("传递依赖最大深度（默认 3）"),
  },

  async execute(args) {
    const xrefsPath = path.join(args.projectDir, ".opencode", "rag", "xrefs.json")

    let xrefs: XrefsIndex
    try {
      xrefs = JSON.parse(await Bun.file(xrefsPath).text())
    } catch {
      return { error: "xrefs.json 不存在，请先运行 /impl-unity --init 重建索引" }
    }

    if (args.action === "stats") {
      return {
        output: [
          "📊 交叉引用统计",
          "",
          `总引用数: ${xrefs.stats.totalXrefs}`,
          "",
          "按类型:",
          ...Object.entries(xrefs.stats.byType).map(([k, v]) => `  ${k}: ${v}`),
          "",
          "🔥 Top 10 被引用类:",
          ...xrefs.stats.topReferenced
            .slice(0, 10)
            .map((t, i) => `  ${i + 1}. ${t.className} (${t.refCount} 引用)`),
        ].join("\n"),
        stats: xrefs.stats,
      }
    }

    if (!args.className)
      return { error: "query/transitive 模式需要提供 className" }

    // 支持短名（自动从 topReferenced 解析完整名）
    const fullName = args.className.includes(".")
      ? args.className
      : xrefs.stats.topReferenced.find(t =>
          t.className.endsWith(`.${args.className}`)
        )?.className
          ?? Object.keys(xrefs.forward).find(k => k.endsWith(`.${args.className}`))
          ?? args.className

    if (args.action === "transitive") {
      const deps = getTransitiveDeps(xrefs, fullName, args.maxDepth ?? 3)
      return {
        output: `🔗 ${args.className} 的传递依赖 (深度 ${args.maxDepth ?? 3}):\n${deps.slice(0, 20).join("\n")}`,
        dependencies: deps,
        total: deps.length,
      }
    }

    // query
    const usedBy  = getUsedBy(xrefs, fullName, args.limit ?? 10)
    const uses     = getUses(xrefs, fullName)
    const priority = getPriorityLabel(xrefs, fullName)
    const xrefPatterns = detectPatternsFromXrefs(xrefs, fullName)

    return {
      output: [
        `🔍 ${args.className} 的引用关系`,
        "",
        priority,
        "",
        `被使用 (${(xrefs.backward[fullName] ?? []).length} 处，显示前 ${usedBy.length}):`,
        ...usedBy.map(u => `  ← ${u.fromClass} [${u.type}]${u.detail ? ` (${u.detail})` : ""}`),
        "",
        `依赖 (${uses.length} 处，显示前 10):`,
        ...uses.slice(0, 10).map(u => `  → ${u.toClass} [${u.type}]`),
        xrefPatterns.length > 0 ? "\n推断模式: " + xrefPatterns.map(p => p.name).join(", ") : "",
      ].join("\n"),
      priority,
      usedBy,
      uses: uses.slice(0, 10),
      xrefPatterns,
      fullName,
    }
  },
})
