import { tool } from "@opencode-ai/plugin"
import * as path from "path"
import * as fs from "fs/promises"

export default tool({
  description:
    "Identify game code classes from Unity IL2CPP dump, filtering out Unity engine, system libraries, and third-party SDKs. Returns prioritized list of classes for reverse engineering.",

  args: {
    dumpCsPath: tool.schema.string().describe("Path to dump.cs file from Il2CppDumper"),
    outputPath: tool.schema.string().optional().describe("Output path for target list JSON (optional)"),
    includeNamespaces: tool.schema.array(tool.schema.string()).optional().describe("Additional namespaces to include"),
    excludeNamespaces: tool.schema.array(tool.schema.string()).optional().describe("Additional namespaces to exclude"),
  },

  async execute(args, ctx) {
    // 读取dump.cs
    let dumpContent: string
    try {
      dumpContent = await fs.readFile(args.dumpCsPath, "utf-8")
    } catch (error) {
      return `Error: Cannot read dump.cs at ${args.dumpCsPath}\n${error}`
    }

    // Debug: 检查dumpContent类型
    if (typeof dumpContent !== "string") {
      return `Error: dumpContent is not a string, it's ${typeof dumpContent}`
    }

    // 解析所有类
    const allClasses = parseAllClasses(dumpContent)

    // 过滤游戏代码
    const gameClasses = filterGameClasses(allClasses, args.includeNamespaces || [], args.excludeNamespaces || [])

    // 按依赖关系排序
    const sortedClasses = topologicalSort(gameClasses, allClasses)

    // 按优先级排序（简单类优先）
    const prioritizedClasses = prioritizeClasses(sortedClasses)

    // 生成统计信息
    const stats = generateStatistics(allClasses, gameClasses, prioritizedClasses)

    // 保存结果
    if (args.outputPath) {
      const output = {
        targets: prioritizedClasses,
        statistics: stats,
        timestamp: new Date().toISOString(),
      }
      await fs.writeFile(args.outputPath, JSON.stringify(output, null, 2), "utf-8")
    }

    return `Target identification completed!

Total classes in dump: ${allClasses.length}
Third-party/system classes: ${allClasses.length - gameClasses.length} (filtered out)
Game code classes: ${gameClasses.length}

Breakdown by category:
${Object.entries(stats.byCategory)
  .map(([cat, count]) => `- ${cat}: ${count}`)
  .join("\n")}

Top namespaces:
${Object.entries(stats.topNamespaces)
  .slice(0, 10)
  .map(([ns, count]) => `- ${ns}: ${count}`)
  .join("\n")}

Classes prioritized by:
1. Dependency order (base classes first)
2. Complexity (simple classes first)
3. Size (smaller classes first)

${args.outputPath ? `\nTarget list saved to: ${args.outputPath}` : ""}

Ready for reverse engineering with unity-reverse tool.`
  },
})

interface ClassInfo {
  fullName: string
  namespace: string
  name: string
  type: "class" | "struct" | "enum" | "interface"
  baseClass: string | null
  interfaces: string[]
  methodCount: number
  fieldCount: number
  isAbstract: boolean
  isSealed: boolean
  isStatic: boolean
  dependencies: string[]
  complexity: number
  startLine: number
}

function parseAllClasses(dumpContent: string): ClassInfo[] {
  const classes: ClassInfo[] = []
  const lines = dumpContent.split("\n")

  let currentNamespace = ""
  let lineNumber = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    lineNumber++

    // 检测命名空间
    const nsMatch = line.match(/^namespace\s+([\w.]+)/)
    if (nsMatch) {
      currentNamespace = nsMatch[1]
      continue
    }

    // 检测类定义
    const classMatch = line.match(
      /^\s*(public|internal|private|protected)?\s*(abstract|sealed|static)?\s*(class|struct|enum|interface)\s+(\w+)(?:\s*:\s*([^{]+))?/,
    )
    if (classMatch) {
      const modifiers = line.substring(0, classMatch.index! + classMatch[0].length)
      const isAbstract = modifiers.includes("abstract")
      const isSealed = modifiers.includes("sealed")
      const isStatic = modifiers.includes("static")
      const type = classMatch[3] as "class" | "struct" | "enum" | "interface"
      const className = classMatch[4]
      const inheritance = classMatch[5]?.trim()

      // 解析基类和接口
      let baseClass: string | null = null
      const interfaces: string[] = []

      if (inheritance) {
        const parts = inheritance.split(",").map((p) => p.trim())
        if (type === "class" || type === "struct") {
          // 第一个可能是基类
          if (parts[0] && !parts[0].startsWith("I")) {
            baseClass = parts[0]
            interfaces.push(...parts.slice(1))
          } else {
            interfaces.push(...parts)
          }
        } else {
          interfaces.push(...parts)
        }
      }

      // 提取类体内容
      const classBody = extractClassBody(lines, i)
      const methodCount = (
        classBody.match(
          /\b(public|private|protected|internal)\s+(?:static\s+)?(?:virtual\s+)?(?:override\s+)?\w+\s+\w+\s*\(/g,
        ) || []
      ).length
      const fieldCount = (
        classBody.match(/\b(public|private|protected|internal)\s+(?:static\s+)?(?:readonly\s+)?\w+\s+\w+;/g) || []
      ).length

      // 提取依赖类型
      const dependencies = extractDependencies(classBody, className)

      // 计算复杂度
      const complexity = calculateComplexity(methodCount, fieldCount, dependencies.length)

      const fullName = currentNamespace ? `${currentNamespace}.${className}` : className

      classes.push({
        fullName,
        namespace: currentNamespace,
        name: className,
        type,
        baseClass,
        interfaces,
        methodCount,
        fieldCount,
        isAbstract,
        isSealed,
        isStatic,
        dependencies,
        complexity,
        startLine: lineNumber,
      })
    }
  }

  return classes
}

function extractClassBody(lines: string[], startIndex: number): string {
  let braceCount = 0
  let inClass = false
  const bodyLines: string[] = []

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]
    bodyLines.push(line)

    for (const char of line) {
      if (char === "{") {
        braceCount++
        inClass = true
      } else if (char === "}") {
        braceCount--
        if (inClass && braceCount === 0) {
          return bodyLines.join("\n")
        }
      }
    }
  }

  return bodyLines.join("\n")
}

function extractDependencies(classBody: string, currentClass: string): string[] {
  const deps = new Set<string>()

  // 匹配类型引用
  const typePattern = /\b([A-Z]\w+(?:\.\w+)*)\b/g
  let match

  while ((match = typePattern.exec(classBody)) !== null) {
    const typeName = match[1]
    if (typeName !== currentClass && !isSystemType(typeName)) {
      deps.add(typeName)
    }
  }

  return Array.from(deps)
}

function calculateComplexity(methods: number, fields: number, deps: number): number {
  return methods * 2 + fields + deps
}

function isSystemType(typeName: string): boolean {
  const systemPrefixes = [
    "System",
    "Microsoft",
    "Mono",
    "UnityEngine",
    "Unity",
    "Object",
    "String",
    "Int32",
    "Boolean",
    "Void",
    "Single",
    "Double",
    "List",
    "Dictionary",
    "Array",
    "Action",
    "Func",
  ]

  return systemPrefixes.some((prefix) => typeName.startsWith(prefix))
}

function filterGameClasses(
  allClasses: ClassInfo[],
  includeNamespaces: string[],
  excludeNamespaces: string[],
): ClassInfo[] {
  // 内置的第三方库黑名单
  const thirdPartyNamespaces = [
    "UnityEngine",
    "Unity",
    "UnityEditor",
    "System",
    "Microsoft",
    "Mono",
    "Photon",
    "ExitGames",
    "Facebook",
    "Google",
    "Firebase",
    "PlayFab",
    "GameAnalytics",
    "Adjust",
    "DOTween",
    "DG",
    "ES3",
    "EasyMobile",
    "I2",
    "InControl",
    "Vuforia",
    "ARCore",
    "ARKit",
    "Sirenix",
    "Odin",
    "TMPro",
    "TextMeshPro",
    "Cinemachine",
    "Timeline",
    "Newtonsoft",
    "Json",
    "LitJson",
    "MiniJson",
  ]

  const allExcludes = [...thirdPartyNamespaces, ...excludeNamespaces]

  return allClasses.filter((cls) => {
    // 强制包含
    if (includeNamespaces.some((ns) => cls.fullName.startsWith(ns))) {
      return true
    }

    // 强制排除
    if (allExcludes.some((ns) => cls.fullName.startsWith(ns))) {
      return false
    }

    // 排除没有命名空间的类（通常是系统类）
    if (!cls.namespace) {
      return false
    }

    // 排除所有方法都是外部的类（通常是第三方库）
    // 这需要更详细的解析，暂时跳过

    return true
  })
}

function topologicalSort(gameClasses: ClassInfo[], allClasses: ClassInfo[]): ClassInfo[] {
  const classMap = new Map(allClasses.map((c) => [c.fullName, c]))
  const gameClassNames = new Set(gameClasses.map((c) => c.fullName))

  const sorted: ClassInfo[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()

  function visit(className: string) {
    if (visited.has(className)) return
    if (visiting.has(className)) {
      // 循环依赖，跳过
      return
    }

    visiting.add(className)

    const cls = classMap.get(className)
    if (!cls) {
      visiting.delete(className)
      return
    }

    // 先访问基类
    if (cls.baseClass && gameClassNames.has(cls.baseClass)) {
      visit(cls.baseClass)
    }

    // 再访问依赖
    for (const dep of cls.dependencies) {
      if (gameClassNames.has(dep)) {
        visit(dep)
      }
    }

    visiting.delete(className)
    visited.add(className)

    if (gameClassNames.has(className)) {
      sorted.push(cls)
    }
  }

  // 按字母顺序访问所有游戏类
  const sortedNames = Array.from(gameClassNames).sort()
  for (const name of sortedNames) {
    visit(name)
  }

  return sorted
}

function prioritizeClasses(classes: ClassInfo[]): ClassInfo[] {
  // 分类
  const enums = classes.filter((c) => c.type === "enum")
  const structs = classes.filter((c) => c.type === "struct")
  const simpleClasses = classes.filter((c) => c.type === "class" && c.complexity < 20)
  const mediumClasses = classes.filter((c) => c.type === "class" && c.complexity >= 20 && c.complexity < 50)
  const complexClasses = classes.filter((c) => c.type === "class" && c.complexity >= 50)
  const interfaces = classes.filter((c) => c.type === "interface")

  // 按优先级排序
  return [...enums, ...structs, ...simpleClasses, ...interfaces, ...mediumClasses, ...complexClasses]
}

function generateStatistics(allClasses: ClassInfo[], gameClasses: ClassInfo[], prioritized: ClassInfo[]) {
  const byCategory = {
    Enum: gameClasses.filter((c) => c.type === "enum").length,
    Struct: gameClasses.filter((c) => c.type === "struct").length,
    Interface: gameClasses.filter((c) => c.type === "interface").length,
    "Simple Class": gameClasses.filter((c) => c.type === "class" && c.complexity < 20).length,
    "Medium Class": gameClasses.filter((c) => c.type === "class" && c.complexity >= 20 && c.complexity < 50).length,
    "Complex Class": gameClasses.filter((c) => c.type === "class" && c.complexity >= 50).length,
  }

  const namespaceMap = new Map<string, number>()
  for (const cls of gameClasses) {
    namespaceMap.set(cls.namespace, (namespaceMap.get(cls.namespace) || 0) + 1)
  }

  const topNamespaces = Object.fromEntries(
    Array.from(namespaceMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20),
  )

  return {
    totalClasses: allClasses.length,
    gameClasses: gameClasses.length,
    thirdPartyClasses: allClasses.length - gameClasses.length,
    byCategory,
    topNamespaces,
    averageComplexity: gameClasses.reduce((sum, c) => sum + c.complexity, 0) / gameClasses.length,
  }
}
