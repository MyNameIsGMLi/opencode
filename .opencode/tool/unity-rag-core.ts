import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"

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
- stats: 查看知识库统计`,

  args: {
    action: tool.schema
      .enum(["index", "retrieve", "add-ida", "add-verified", "stats", "search"])
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

// ==================== 1. 静态知识索引 ====================

async function indexStatic(args: any, ctx: any, ragDir: string) {
  const indexPath = path.join(ragDir, "index.json")

  // 检查是否已存在索引
  if (!args.force) {
    try {
      const existing = await fs.readFile(indexPath, "utf-8")
      return {
        output: "索引已存在。使用 --force 强制重建。",
        indexPath,
      }
    } catch {
      // 不存在，继续创建
    }
  }

  const dumpCsPath = args.dumpCsPath || path.join(args.projectDir, "Assets/Il2CppDump/dump.cs")
  const scriptJsonPath = args.scriptJsonPath || path.join(args.projectDir, "Assets/Il2CppDump/script.json")

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

  // 保存索引
  const index: RAGIndex = {
    version: "1.0.0",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    chunks,
    stats: {
      totalClasses: classes.length,
      totalMethods: chunks.filter((c) => c.type === "method").length,
      idaAnalyzed: 0,
      verifiedImplementations: 0,
    },
  }

  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf-8")

  return {
    output: `✅ 静态知识索引完成！

总类数: ${index.stats.totalClasses}
总方法数: ${index.stats.totalMethods}
总 chunks: ${chunks.length}
模块数: ${modules.size}

索引保存至: ${indexPath}`,
    stats: index.stats,
    indexPath,
  }
}

// ==================== 2. 智能检索 ====================

async function retrieveContext(args: any, ctx: any, ragDir: string) {
  const indexPath = path.join(ragDir, "index.json")

  let index: RAGIndex
  try {
    const content = await fs.readFile(indexPath, "utf-8")
    index = JSON.parse(content)
  } catch {
    return { error: "索引不存在，请先运行 index 操作" }
  }

  const className = args.className
  const layers = args.layers || ["static", "verified"]

  // 查找目标类
  const targetChunk = index.chunks.find((c) => c.type === "class" && c.metadata.className === className)

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
    context.dependencies = index.chunks.filter(
      (c) => c.type === "class" && deps.includes(c.metadata.fullName || c.metadata.className),
    )

    // 获取方法
    context.methods = index.chunks.filter(
      (c) => c.type === "method" && c.metadata.className === targetChunk.metadata.fullName,
    )
  }

  // Layer 2: IDA 分析
  if (layers.includes("ida")) {
    const idaChunk = index.chunks.find((c) => c.type === "ida" && c.metadata.className === className)
    if (idaChunk) {
      context.ida = idaChunk
    }
  }

  // Layer 3: 已验证代码
  if (layers.includes("verified")) {
    const verifiedChunk = index.chunks.find((c) => c.type === "verified" && c.metadata.className === className)
    if (verifiedChunk) {
      context.verified = verifiedChunk
    }

    // 查找相似的已验证类（同命名空间或相似名称）
    context.similar = index.chunks
      .filter(
        (c) =>
          c.type === "verified" &&
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

  let index: RAGIndex
  try {
    const content = await fs.readFile(indexPath, "utf-8")
    index = JSON.parse(content)
  } catch {
    return { error: "索引不存在，请先运行 index 操作" }
  }

  const idaData = JSON.parse(args.idaData || "{}")

  const chunk: KnowledgeChunk = {
    id: `ida:${idaData.className}`,
    type: "ida",
    content: idaData.pseudocode || "",
    metadata: {
      className: idaData.className,
      methodName: idaData.methodName,
      address: idaData.address,
      fetchedAt: new Date().toISOString(),
    },
  }

  // 检查是否已存在
  const existingIndex = index.chunks.findIndex((c) => c.id === chunk.id)
  if (existingIndex >= 0) {
    index.chunks[existingIndex] = chunk
  } else {
    index.chunks.push(chunk)
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

  let index: RAGIndex
  try {
    const content = await fs.readFile(indexPath, "utf-8")
    index = JSON.parse(content)
  } catch {
    return { error: "索引不存在，请先运行 index 操作" }
  }

  const code = args.verifiedCode || ""
  const className = args.className

  const chunk: KnowledgeChunk = {
    id: `verified:${className}`,
    type: "verified",
    content: code,
    metadata: {
      className,
      verified: true,
      verifiedAt: new Date().toISOString(),
    },
  }

  const existingIndex = index.chunks.findIndex((c) => c.id === chunk.id)
  if (existingIndex >= 0) {
    index.chunks[existingIndex] = chunk
  } else {
    index.chunks.push(chunk)
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

  let index: RAGIndex
  try {
    const content = await fs.readFile(indexPath, "utf-8")
    index = JSON.parse(content)
  } catch {
    return { error: "索引不存在，请先运行 index 操作" }
  }

  const typeStats = index.chunks.reduce(
    (acc, c) => {
      acc[c.type] = (acc[c.type] || 0) + 1
      return acc
    },
    {} as Record<string, number>,
  )

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

  let index: RAGIndex
  try {
    const content = await fs.readFile(indexPath, "utf-8")
    index = JSON.parse(content)
  } catch {
    return { error: "索引不存在，请先运行 index 操作" }
  }

  const query = args.query || ""
  const topK = args.topK || 10

  // 简单的关键词匹配（后续可升级为向量搜索）
  const results = index.chunks
    .filter((c) => {
      const searchText = (c.content + JSON.stringify(c.metadata)).toLowerCase()
      return query.toLowerCase().split(" ").some((keyword) => searchText.includes(keyword))
    })
    .slice(0, topK)

  return {
    output: `🔍 搜索结果 (找到 ${results.length} 条)

${results.map((r, i) => `${i + 1}. [${r.type}] ${r.metadata.className || r.metadata.moduleName}`).join("\n")}`,
    results,
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
  const classRegex = /(?:public |internal |private |protected )*(?:abstract |sealed )?(?:class|struct|interface) (\w+)/g
  const lines = dumpContent.split("\n")

  let currentClass: ClassInfo | null = null
  let braceDepth = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    // 检测类定义
    const classMatch = line.match(
      /(?:public |internal |private |protected )*(?:abstract |sealed )?(class|struct|interface) (\w+)/,
    )
    if (classMatch && braceDepth === 0) {
      if (currentClass) {
        classes.push(currentClass)
      }

      const className = classMatch[2]
      const namespace = extractNamespace(lines, i)

      currentClass = {
        name: className,
        namespace,
        fullName: namespace ? `${namespace}.${className}` : className,
        baseClass: extractBaseClass(line),
        interfaces: extractInterfaces(line),
        fields: [],
        methods: [],
        isAbstract: line.includes("abstract"),
        isSealed: line.includes("sealed"),
      }
    }

    // 跟踪花括号深度
    if (line.includes("{")) braceDepth++
    if (line.includes("}")) braceDepth--

    // 解析字段和方法
    if (currentClass && braceDepth === 1) {
      if (line.match(/^\w+\s+\w+;/)) {
        // 字段
        const parts = line.split(/\s+/)
        if (parts.length >= 2) {
          currentClass.fields.push({ name: parts[1].replace(";", ""), type: parts[0] })
        }
      } else if (line.match(/^\w+\s+\w+\(/)) {
        // 方法
        const methodMatch = line.match(/(\w+)\s+(\w+)\((.*?)\)/)
        if (methodMatch) {
          currentClass.methods.push({
            name: methodMatch[2],
            signature: line,
            returnType: methodMatch[1],
            parameters: methodMatch[3].split(",").map((p) => p.trim()),
          })
        }
      }
    }
  }

  if (currentClass) {
    classes.push(currentClass)
  }

  return classes
}

function extractNamespace(lines: string[], classLineIndex: number): string {
  for (let i = classLineIndex; i >= 0; i--) {
    const match = lines[i].match(/namespace\s+([\w.]+)/)
    if (match) return match[1]
  }
  return ""
}

function extractBaseClass(line: string): string | null {
  const match = line.match(/:\s*(\w+)/)
  return match ? match[1] : null
}

function extractInterfaces(line: string): string[] {
  const match = line.match(/:\s*\w+,\s*(.+)/)
  return match ? match[1].split(",").map((i) => i.trim()) : []
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
