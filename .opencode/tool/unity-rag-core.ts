import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"
import { loadProjectConfig, resolveDumpCsPath, resolveScriptJsonPath } from "./unity-project-config"
import {
  compressBatch, compressChunk, decompressChunk, migrateV1toV2, isV2, paginate,
  type RAGIndexV2, type HotChunks,
} from "./unity-rag-cache"
import { buildXrefsIndex, type ClassInfoLike } from "./unity-rag-xrefs"

/**
 * Unity RAG Core - 渐进式知识库系统
 *
 * 核心功能：
 * 1. 静态知识索引（dump.cs + script.json）
 * 2. 增量 IDA 集成（按需获取）
 * 3. 已验证代码学习（成功案例积累）
 * 4. 智能检索引擎（多层次混合检索）
 */

export default tool({
  description: `Unity RAG 核心引擎 - 构建和管理 Unity IL2CPP 逆向工程知识库。

支持操作：
- index: 索引静态知识（dump.cs + script.json）
- retrieve: 智能检索相关上下文
- add-ida: 添加 IDA 分析结果
- add-verified: 添加已验证的生成代码
- stats: 查看知识库统计
- list-classes: 分页列出所有类`,

  args: {
    action: tool.schema
      .enum(["index", "retrieve", "add-ida", "add-verified", "stats", "search", "list-classes"])
      .describe("操作类型"),

    projectDir: tool.schema.string().describe("Unity 项目根目录"),

    // index 参数
    dumpCsPath: tool.schema.string().optional().describe("dump.cs 文件路径"),
    scriptJsonPath: tool.schema.string().optional().describe("script.json 文件路径"),

    // retrieve 参数
    className: tool.schema.string().optional().describe("要检索的类名"),
    layers: tool.schema
      .array(tool.schema.enum(["static", "ida", "verified", "assets"]))
      .optional()
      .describe("检索的知识层级"),

    // add-ida 参数
    idaData: tool.schema.string().optional().describe("IDA 分析结果 JSON"),

    // add-verified 参数
    verifiedCode: tool.schema.string().optional().describe("已验证的代码"),

    // search 参数
    query: tool.schema.string().optional().describe("搜索查询"),
    topK: tool.schema.number().optional().describe("返回前 K 个结果（默认 10）"),

    // 通用参数
    force: tool.schema.boolean().optional().describe("强制重建索引"),

    // 分页参数
    offset: tool.schema.number().optional().describe("分页起始位置（默认 0）"),
    limit: tool.schema.number().optional().describe("每页数量（默认 100，最大 1000）"),
  },

  async execute(args, ctx) {
    const ragDir = path.join(args.projectDir, ".opencode", "rag")
    await fs.mkdir(ragDir, { recursive: true })

    switch (args.action) {
      case "index":
        return await indexStatic(args, ctx, ragDir)

      case "retrieve":
        return await retrieveContext(args, ctx, ragDir)

      case "add-ida":
        return await addIdaAnalysis(args, ctx, ragDir)

      case "add-verified":
        return await addVerifiedCode(args, ctx, ragDir)

      case "stats":
        return await showStats(args, ctx, ragDir)

      case "search":
        return await semanticSearch(args, ctx, ragDir)

      case "list-classes":
        return await listClasses(args, ragDir)

      default:
        return { error: `Unknown action: ${args.action}` }
    }
  },
})

// ==================== 核心数据结构 ====================

interface KnowledgeChunk {
  id: string
  type: "class" | "method" | "module" | "pattern" | "ida" | "verified"
  content: string
  metadata: {
    className?: string
    namespace?: string
    methodName?: string
    dependencies?: string[]
    complexity?: number
    verified?: boolean
    fetchedAt?: string
    [key: string]: any
  }
  embedding?: number[] // 向量嵌入（后续集成）
}

// ==================== 1. 静态知识索引 ====================

async function indexStatic(args: any, ctx: any, ragDir: string) {
  const indexPath = path.join(ragDir, "index.json")

  // 检查是否已存在索引
  if (!args.force) {
    try {
      await fs.readFile(indexPath, "utf-8")
      return {
        output: "索引已存在。使用 --force 强制重建。",
        indexPath,
      }
    } catch {
      // 不存在，继续创建
    }
  }

  const config = await loadProjectConfig(args.projectDir)
  const dumpCsPath = resolveDumpCsPath(args.projectDir, config, args.dumpCsPath)
  const scriptJsonPath = resolveScriptJsonPath(args.projectDir, config, args.scriptJsonPath)

  // 读取文件
  let dumpContent: string
  let scriptJson: any

  try {
    dumpContent = await fs.readFile(dumpCsPath, "utf-8")
  } catch (error) {
    return { error: `无法读取 dump.cs: ${dumpCsPath}` }
  }

  try {
    const scriptContent = await fs.readFile(scriptJsonPath, "utf-8")
    scriptJson = JSON.parse(scriptContent)
  } catch (error) {
    return { error: `无法读取 script.json: ${scriptJsonPath}` }
  }

  // 解析类定义
  const classes = parseClasses(dumpContent)

  // 构建依赖图
  const dependencyGraph = buildDependencyGraph(classes)

  // 创建 chunks
  const chunks: KnowledgeChunk[] = []

  for (const cls of classes) {
    // 类级 chunk
    chunks.push({
      id: `class:${cls.fullName}`,
      type: "class",
      content: generateClassSummary(cls),
      metadata: {
        className: cls.name,
        namespace: cls.namespace,
        fullName: cls.fullName,
        baseClass: cls.baseClass,
        interfaces: cls.interfaces,
        fieldCount: cls.fields.length,
        methodCount: cls.methods.length,
        dependencies: dependencyGraph.get(cls.fullName) || [],
        complexity: calculateComplexity(cls),
      },
    })

    // 方法级 chunks
    for (const method of cls.methods) {
      chunks.push({
        id: `method:${cls.fullName}.${method.name}`,
        type: "method",
        content: `${method.signature}\n// ${method.name} in ${cls.fullName}`,
        metadata: {
          className: cls.fullName,
          methodName: method.name,
          signature: method.signature,
          returnType: method.returnType,
          parameters: method.parameters,
        },
      })
    }
  }

  // 检测模块（按命名空间分组）
  const modules = detectModules(classes)
  for (const [moduleName, moduleClasses] of modules.entries()) {
    chunks.push({
      id: `module:${moduleName}`,
      type: "module",
      content: `模块: ${moduleName}\n包含类: ${moduleClasses.map((c) => c.name).join(", ")}`,
      metadata: {
        moduleName,
        classes: moduleClasses.map((c) => c.fullName),
        classCount: moduleClasses.length,
      },
    })
  }

  // ── 构建 v2 分层压缩索引 ────────────────────────────────────────
  const hotChunks: HotChunks = {
    classes:  chunks.filter(c => c.type === "class"),
    modules:  chunks.filter(c => c.type === "module"),
    verified: chunks.filter(c => c.type === "verified"),
  }
  const methodChunks = chunks.filter(c => c.type === "method")

  const compressedMethods = compressBatch(methodChunks)
  const originalBytes = methodChunks.reduce(
    (sum, c) => sum + Buffer.byteLength(JSON.stringify(c), "utf-8"), 0,
  )
  const compressedBytes = compressedMethods.reduce(
    (sum, c) => sum + Buffer.byteLength(c.compressed, "utf-8"), 0,
  )
  const compressionRatio =
    compressedBytes > 0 ? Math.round((originalBytes / compressedBytes) * 10) / 10 : 0

  const index: RAGIndexV2 = {
    version: "2.0.0",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hotChunks,
    coldChunks: { methods: compressedMethods, ida: [] },
    stats: {
      totalClasses: classes.length,
      totalMethods: methodChunks.length,
      idaAnalyzed: 0,
      verifiedImplementations: 0,
      compressionRatio,
    },
  }

  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf-8")

  // ── 构建交叉引用索引 ─────────────────────────────────────────────
  const xrefs = buildXrefsIndex(classes as ClassInfoLike[])
  const xrefsPath = path.join(ragDir, "xrefs.json")
  await fs.writeFile(xrefsPath, JSON.stringify(xrefs, null, 2), "utf-8")

  // ── 尝试运行社区检测（可选，需要 Python 3 + networkx）─────────────
  const commPath = path.join(ragDir, "communities.json")
  const detectScript = path.join(args.projectDir, ".opencode", "scripts", "detect_communities.py")
  const scriptExists = await fs.access(detectScript).then(() => true).catch(() => false)
  if (scriptExists) {
    try {
      await ctx.bash(`python3 "${detectScript}" "${xrefsPath}" "${commPath}" 2>/dev/null`)
    } catch {
      // 社区检测失败不影响主流程，静默处理
    }
  }

  return {
    output: `✅ 静态知识索引完成！

总类数: ${index.stats.totalClasses}
总方法数: ${index.stats.totalMethods}
总 chunks: ${chunks.length}
模块数: ${modules.size}
压缩率: ${compressionRatio}x (method chunks)

交叉引用: ${xrefs.stats.totalXrefs} 条
Top 被引用: ${xrefs.stats.topReferenced.slice(0, 3).map(t => t.className).join(", ")}

索引保存至: ${indexPath}`,
    stats: index.stats,
    indexPath,
    xrefsStats: xrefs.stats,
  }
}

// ==================== 2. 智能检索 ====================

async function retrieveContext(args: any, ctx: any, ragDir: string) {
  const indexPath = path.join(ragDir, "index.json")

  let index: RAGIndexV2
  try {
    const raw = JSON.parse(await Bun.file(indexPath).text())
    index = isV2(raw) ? raw : migrateV1toV2(raw)
  } catch {
    return { error: "索引不存在，请先运行 index 操作" }
  }

  const className = args.className
  const layers = args.layers || ["static", "verified"]

  // 查找目标类
  const targetChunk = index.hotChunks.classes.find((c) => c.metadata.className === className)

  if (!targetChunk) {
    return { error: `未找到类: ${className}` }
  }

  const context: any = {
    targetClass: targetChunk,
    dependencies: [],
    methods: [],
    similar: [],
    ida: null,
    verified: null,
  }

  // Layer 1: 静态结构
  if (layers.includes("static")) {
    // 获取依赖类
    const deps = targetChunk.metadata.dependencies || []
    context.dependencies = index.hotChunks.classes.filter(
      (c) => deps.includes(c.metadata.fullName || c.metadata.className),
    )

    // method chunks 是冷数据，此处暂不展开（避免全量解压）
    context.methods = []
  }

  // Layer 2: IDA 分析
  if (layers.includes("ida")) {
    const compressed = index.coldChunks.ida.find(c => c.id === `ida:${className}`)
    const idaChunk = compressed ? decompressChunk(compressed) : undefined
    if (idaChunk) {
      context.ida = idaChunk
    }
  }

  // Layer 3: 已验证代码
  if (layers.includes("verified")) {
    const verifiedChunk = index.hotChunks.verified.find((c) => c.metadata.className === className)
    if (verifiedChunk) {
      context.verified = verifiedChunk
    }

    // 查找相似的已验证类（同命名空间或相似名称）
    context.similar = index.hotChunks.verified
      .filter(
        (c) =>
          c.metadata.namespace === targetChunk.metadata.namespace &&
          c.metadata.className !== className,
      )
      .slice(0, 3)
  }

  return {
    output: `✅ 检索到 ${className} 的上下文

依赖类: ${context.dependencies.length}
方法数: ${context.methods.length}
相似已验证类: ${context.similar.length}
IDA 分析: ${context.ida ? "✓" : "✗"}
已验证实现: ${context.verified ? "✓" : "✗"}`,
    context,
  }
}

// ==================== 3. 添加 IDA 分析 ====================

async function addIdaAnalysis(args: any, ctx: any, ragDir: string) {
  const indexPath = path.join(ragDir, "index.json")

  let index: RAGIndexV2
  try {
    const raw = JSON.parse(await Bun.file(indexPath).text())
    index = isV2(raw) ? raw : migrateV1toV2(raw)
  } catch {
    return { error: "索引不存在，请先运行 index 操作" }
  }

  const idaData = JSON.parse(args.idaData || "{}")
  const chunk = {
    id: `ida:${idaData.className}`,
    type: "ida" as const,
    content: idaData.pseudocode || "",
    metadata: {
      className: idaData.className,
      methodName: idaData.methodName,
      address: idaData.address,
      fetchedAt: new Date().toISOString(),
    },
  }
  const compressed = compressChunk(chunk)

  const existingIdx = index.coldChunks.ida.findIndex(c => c.id === compressed.id)
  if (existingIdx >= 0) {
    index.coldChunks.ida[existingIdx] = compressed
  } else {
    index.coldChunks.ida.push(compressed)
    index.stats.idaAnalyzed++
  }

  index.updatedAt = new Date().toISOString()
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf-8")

  return {
    output: `✅ 添加 IDA 分析: ${idaData.className}`,
    stats: index.stats,
  }
}

// ==================== 4. 添加已验证代码 ====================

async function addVerifiedCode(args: any, ctx: any, ragDir: string) {
  const indexPath = path.join(ragDir, "index.json")

  let index: RAGIndexV2
  try {
    const raw = JSON.parse(await Bun.file(indexPath).text())
    index = isV2(raw) ? raw : migrateV1toV2(raw)
  } catch {
    return { error: "索引不存在，请先运行 index 操作" }
  }

  const code = args.verifiedCode || ""
  const className = args.className
  const chunk = {
    id: `verified:${className}`,
    type: "verified" as const,
    content: code,
    metadata: {
      className,
      verified: true,
      verifiedAt: new Date().toISOString(),
    },
  }

  const existingIdx = index.hotChunks.verified.findIndex(c => c.id === chunk.id)
  if (existingIdx >= 0) {
    index.hotChunks.verified[existingIdx] = chunk
  } else {
    index.hotChunks.verified.push(chunk)
    index.stats.verifiedImplementations++
  }

  index.updatedAt = new Date().toISOString()
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf-8")

  return {
    output: `✅ 添加已验证代码: ${className}`,
    stats: index.stats,
  }
}

// ==================== 5. 统计信息 ====================

async function showStats(args: any, ctx: any, ragDir: string) {
  const indexPath = path.join(ragDir, "index.json")

  let index: RAGIndexV2
  try {
    const raw = JSON.parse(await Bun.file(indexPath).text())
    index = isV2(raw) ? raw : migrateV1toV2(raw)
  } catch {
    return { error: "索引不存在，请先运行 index 操作" }
  }

  const typeStats = {
    class:    index.hotChunks.classes.length,
    module:   index.hotChunks.modules.length,
    verified: index.hotChunks.verified.length,
    method:   index.coldChunks.methods.length,
    ida:      index.coldChunks.ida.length,
  }

  return {
    output: `📊 RAG 知识库统计

版本: ${index.version}
创建时间: ${index.createdAt}
更新时间: ${index.updatedAt}

📈 总体统计:
- 总类数: ${index.stats.totalClasses}
- 总方法数: ${index.stats.totalMethods}
- IDA 分析数: ${index.stats.idaAnalyzed}
- 已验证实现: ${index.stats.verifiedImplementations}
${index.stats.compressionRatio ? `\n💾 压缩率: ${index.stats.compressionRatio}x (method chunks)` : ""}
📦 Chunk 类型分布:
${Object.entries(typeStats)
  .map(([type, count]) => `- ${type}: ${count}`)
  .join("\n")}

💡 知识覆盖率:
- IDA 覆盖: ${((index.stats.idaAnalyzed / index.stats.totalClasses) * 100).toFixed(1)}%
- 已验证覆盖: ${((index.stats.verifiedImplementations / index.stats.totalClasses) * 100).toFixed(1)}%
`,
    stats: index.stats,
    typeStats,
  }
}

// ==================== 6. 语义搜索 ====================

async function semanticSearch(args: any, ctx: any, ragDir: string) {
  const indexPath = path.join(ragDir, "index.json")

  let index: RAGIndexV2
  try {
    const raw = JSON.parse(await Bun.file(indexPath).text())
    index = isV2(raw) ? raw : migrateV1toV2(raw)
  } catch {
    return { error: "索引不存在，请先运行 index 操作" }
  }

  const query = args.query || ""
  const topK = args.topK || 10

  // 只搜索热数据（class + module + verified），method 是冷数据不展开
  const searchable = [
    ...index.hotChunks.classes,
    ...index.hotChunks.modules,
    ...index.hotChunks.verified,
  ]

  const results = searchable
    .filter(c => {
      const searchText = (c.content + JSON.stringify(c.metadata)).toLowerCase()
      return query.toLowerCase().split(" ").some(kw => searchText.includes(kw))
    })
    .slice(0, topK)

  return {
    output: `🔍 搜索结果 (找到 ${results.length} 条)

${results.map((r: any, i: number) => `${i + 1}. [${r.type}] ${r.metadata.className || r.metadata.moduleName}`).join("\n")}`,
    results,
  }
}

// ==================== 7. 分页列出类 ====================

async function listClasses(args: any, ragDir: string) {
  const indexPath = path.join(ragDir, "index.json")
  let index: RAGIndexV2
  try {
    const raw = JSON.parse(await Bun.file(indexPath).text())
    index = isV2(raw) ? raw : migrateV1toV2(raw)
  } catch {
    return { error: "索引不存在，请先运行 index 操作" }
  }

  const result = paginate(index.hotChunks.classes, {
    offset: args.offset,
    limit: args.limit,
  })

  return {
    output: `📋 类列表 (第 ${result.pagination.currentPage}/${result.pagination.totalPages} 页，共 ${result.pagination.total} 个类)`,
    ...result,
  }
}

// ==================== 辅助函数 ====================

interface ClassInfo {
  name: string
  namespace: string
  fullName: string
  baseClass: string | null
  interfaces: string[]
  fields: Array<{ name: string; type: string }>
  methods: Array<{ name: string; signature: string; returnType: string; parameters: string[] }>
  isAbstract: boolean
  isSealed: boolean
}

function parseClasses(dumpContent: string): ClassInfo[] {
  const classes: ClassInfo[] = []
  const lines = dumpContent.split("\n")

  let currentClass: ClassInfo | null = null
  let braceDepth = 0
  // Track current namespace from "// Namespace: Foo" comments (IL2CPP dump.cs format)
  let currentNamespace = ""

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    // IL2CPP dump.cs uses "// Namespace: Foo" comments (not namespace {} blocks)
    const nsMatch = line.match(/^\/\/ Namespace:\s*(.*)$/)
    if (nsMatch) {
      currentNamespace = nsMatch[1].trim()
      continue
    }

    // Also support traditional "namespace Foo {" blocks for non-IL2CPP sources
    const nsBlockMatch = line.match(/^namespace\s+([\w.]+)/)
    if (nsBlockMatch) {
      currentNamespace = nsBlockMatch[1]
    }

    // 检测类定义（仅在顶层 braceDepth === 0 时）
    const classMatch = line.match(
      /^(?:\[.*?\]\s*)*(?:public |internal |private |protected )*(?:abstract |sealed |static )*(?:partial )*(class|struct|interface|enum)\s+(\w+)/,
    )
    if (classMatch && braceDepth === 0) {
      if (currentClass) classes.push(currentClass)

      const className = classMatch[2]
      const ns = currentNamespace
      currentClass = {
        name: className,
        namespace: ns,
        fullName: ns ? `${ns}.${className}` : className,
        baseClass: extractBaseClass(line),
        interfaces: extractInterfaces(line),
        fields: [],
        methods: [],
        isAbstract: line.includes("abstract"),
        isSealed: line.includes("sealed"),
      }
    }

    // 跟踪花括号深度
    for (const ch of line) {
      if (ch === "{") braceDepth++
      else if (ch === "}") braceDepth--
    }

    // 解析字段和方法（braceDepth === 1 表示在类体内顶层）
    if (currentClass && braceDepth === 1) {
      // 字段：匹配 "private/public/protected [readonly/static] Type name; // offset"
      // dump.cs 字段格式：访问修饰符 + 可选修饰符 + 类型 + 名称 + ; (后面可能有 // 注释)
      const fieldMatch = line.match(
        /^(?:public |private |protected |internal )+(?:static |readonly |const )*(\S+)\s+(\w+)\s*;/,
      )
      if (fieldMatch) {
        currentClass.fields.push({ name: fieldMatch[2], type: fieldMatch[1] })
      }

      // 方法：匹配访问修饰符 + 返回类型 + 方法名(...)
      // dump.cs 方法格式：不以 // 开头，含括号
      const methodMatch = line.match(
        /^(?:public |private |protected |internal |static |virtual |override |sealed |abstract |extern )+(?:\S+\s+)?(\w+)\s*\(/,
      )
      if (methodMatch && !line.startsWith("//") && !line.startsWith("[")) {
        // 提取返回类型和方法名
        const sigMatch = line.match(
          /(?:public |private |protected |internal |static |virtual |override |sealed |abstract |extern )*(\S+)\s+(\w+)\s*\((.*?)\)/,
        )
        if (sigMatch) {
          currentClass.methods.push({
            name: sigMatch[2],
            signature: line,
            returnType: sigMatch[1],
            parameters: sigMatch[3] ? sigMatch[3].split(",").map((p) => p.trim()).filter(Boolean) : [],
          })
        }
      }
    }
  }

  if (currentClass) classes.push(currentClass)

  return classes
}

function extractNamespace(_lines: string[], _classLineIndex: number): string {
  // Kept for backward compatibility; actual namespace extraction now happens
  // inline in parseClasses via "// Namespace:" comment tracking
  return ""
}

function extractBaseClass(line: string): string | null {
  // Strip trailing IL2CPP comment e.g. "// TypeDefIndex: 4366"
  const cleanLine = line.replace(/\/\/.*$/, "").trim()
  const colonIdx = cleanLine.indexOf(":")
  if (colonIdx === -1) return null
  const afterColon = cleanLine.slice(colonIdx + 1).trim()
  // First token before comma, strip generics, keep only valid identifier
  const first = afterColon.split(",")[0].trim().replace(/<[^>]*>/g, "").trim()
  // Only return if it looks like a valid C# identifier
  return /^\w+$/.test(first) ? first : null
}

function extractInterfaces(line: string): string[] {
  const cleanLine = line.replace(/\/\/.*$/, "").trim()
  const colonIdx = cleanLine.indexOf(":")
  if (colonIdx === -1) return []
  const afterColon = cleanLine.slice(colonIdx + 1).trim()
  const parts = afterColon.split(",").map((p) => p.trim().replace(/<[^>]*>/g, "").trim()).filter((p) => /^\w+$/.test(p))
  // Skip the first (it's the base class), rest are interfaces
  return parts.slice(1)
}

function buildDependencyGraph(classes: ClassInfo[]): Map<string, string[]> {
  const graph = new Map<string, string[]>()

  for (const cls of classes) {
    const deps: string[] = []

    if (cls.baseClass) deps.push(cls.baseClass)
    deps.push(...cls.interfaces)

    // 从字段类型提取依赖
    for (const field of cls.fields) {
      const type = field.type.replace(/[\[\]<>]/g, "")
      if (classes.some((c) => c.name === type)) {
        deps.push(type)
      }
    }

    graph.set(cls.fullName, [...new Set(deps)])
  }

  return graph
}

function generateClassSummary(cls: ClassInfo): string {
  return `class ${cls.name} ${cls.baseClass ? `: ${cls.baseClass}` : ""} {
  // Fields: ${cls.fields.length}
  // Methods: ${cls.methods.length}
  // Namespace: ${cls.namespace}
}`
}

function calculateComplexity(cls: ClassInfo): number {
  return cls.fields.length + cls.methods.length * 2 + cls.interfaces.length * 3
}

function detectModules(classes: ClassInfo[]): Map<string, ClassInfo[]> {
  const modules = new Map<string, ClassInfo[]>()

  for (const cls of classes) {
    const moduleName = cls.namespace.split(".")[0] || "Root"
    if (!modules.has(moduleName)) {
      modules.set(moduleName, [])
    }
    modules.get(moduleName)!.push(cls)
  }

  return modules
}

// ==================== 共享辅助：判断是否需要 IDA（导出供其他工具使用）====================

/**
 * 判断某个类是否需要 IDA 分析
 * 统一规则，供 unity-rag-ida 和 unity-rag-retriever 共用
 */
export function judgeNeedsIDA(classChunk: any, allVerified: any[] = []): boolean {
  const name = classChunk.metadata?.className || ""
  const fullName = classChunk.metadata?.fullName || ""
  const complexity = classChunk.metadata?.complexity || 0
  const methodCount = classChunk.metadata?.methodCount || 0

  const keywords = [
    /Encrypt/i, /Decrypt/i, /Hash/i, /Compress/i,
    /Network/i, /Protocol/i, /Serialize/i,
    /Calculate.*Damage/i, /AI/i, /Pathfind/i, /Sync/i,
  ]
  if (keywords.some(k => k.test(name) || k.test(fullName))) return true
  if (complexity > 80) return true
  if (methodCount > 20) return true
  // 规则4：同命名空间相似类已使用 IDA
  const ns = classChunk.metadata?.namespace
  return allVerified.some((v: any) => v.metadata?.namespace === ns && v.metadata?.usedIDA === true)
}

/**
 * 为 IDA 分析选择最重要的方法（按优先级排序）
 * - Priority 1: Unity 生命周期方法（Update/FixedUpdate等）
 * - Priority 2: 业务逻辑关键词（Calculate/Process/Execute等）
 * - Priority 3: 参数最多的方法（最复杂）
 * 返回所有 score > 0 的方法，上限 10 个
 */
export function selectMethodsForIDA(classMethods: any[]): any[] {
  const scored = classMethods.map(m => {
    // 从 "Namespace.ClassName::MethodName(params)" 提取方法名
    const shortName = (m.Name || "").split("::").pop()?.split("(")[0] || ""
    let score = 0
    if (/^(Update|FixedUpdate|LateUpdate|Awake|Start|OnEnable|OnDisable|OnDestroy|OnTrigger|OnCollision)$/.test(shortName))
      score += 100
    if (/Calculate|Process|Execute|Apply|Handle|Compute|Perform|Resolve|Init|Generate|Build/i.test(shortName))
      score += 50
    // 参数数量（粗略估算：通过逗号计数）
    const paramStr = (m.Name || "").split("(")[1] ?? ""
    const paramCount = paramStr.length > 2 ? (paramStr.split(",").length) : 0
    score += paramCount * 5
    return { method: m, score }
  })
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(s => s.method)
}
