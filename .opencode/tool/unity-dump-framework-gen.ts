import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"

/**
 * 从 dump.cs 提取框架层泛型类，生成可编译的 C# 骨架文件
 *
 * 解决问题：
 * - AssetRipper export 的 C# 源码会丢失泛型参数（IL2CPP 泛型消除）
 * - 例如 `Getter<T>` 在 export 里变成 `Getter`，导致游戏代码编译失败
 * - dump.cs 保留了完整的泛型定义，本工具直接从 dump.cs 提取并转换为可编译代码
 *
 * 工作流：
 * 1. 扫描 scriptsDir 里所有 .cs 文件，收集实际被使用的泛型类型（如 Getter<T>）
 * 2. 在 dump.cs 里找到对应的完整类定义（包含泛型参数）
 * 3. 将 dump.cs 格式（含 RVA 注释、空方法体）转换为可编译的 C# 骨架
 * 4. 检测与 AssetRipper export 里非泛型版本的冲突，移除非泛型版本
 * 5. 将生成的骨架写入 outputDir
 */

// 已知会被 AssetRipper 丢失泛型的核心类（namespace → class names）
const KNOWN_GENERIC_CLASSES = [
  "Getter", "Var", "Setter", "VarSync", "VarSo", "VarMono",
  "EventListener", "MethodCaller", "SerializableInterface",
  "BaseLevelCreator", "BaseLevelSaver", "BaseLevelCreatorData",
  "IGet", "IVar", "ISet", "IEvent", "IRegisterEvent", "IRaiseEvent",
  "ILevelCreator", "ILevelSaver", "ILevelCreatorData",
]

export default tool({
  description: "从 dump.cs 提取框架层泛型类（Getter<T>/Var<T>/BaseLevelCreator<,>等），生成可编译 C# 骨架，修复 AssetRipper 泛型消除问题",

  args: {
    dumpCsPath: tool.schema.string().describe("dump.cs 文件路径"),
    outputDir: tool.schema.string().describe("输出目录（生成的骨架文件放这里，建议放在 Assets/Scripts/CresciveGenericStubs/）"),
    scriptsDir: tool.schema.string().optional().describe("扫描此目录的 .cs 文件，自动检测实际用到的泛型类型"),
    conflictDir: tool.schema.string().optional().describe("AssetRipper export 的 Scripts 目录，检测并移除非泛型冲突文件"),
    dryRun: tool.schema.boolean().optional().describe("仅预览，不写入文件"),
  },

  async execute(args) {
    const dumpContent = await Bun.file(args.dumpCsPath).text()
    const outDir = path.resolve(args.outputDir)

    // Step 1: 确定需要提取的类列表
    let targetClasses = [...KNOWN_GENERIC_CLASSES]
    if (args.scriptsDir) {
      const detected = await detectUsedGenerics(args.scriptsDir)
      // 合并（以实际检测到的为主，加上已知列表补充）
      targetClasses = [...new Set([...detected, ...KNOWN_GENERIC_CLASSES])]
    }

    // Step 2: 从 dump.cs 提取类块
    const extracted = extractClassBlocks(dumpContent, targetClasses)

    if (extracted.length === 0) {
      return {
        output: `⚠️ 未找到任何目标泛型类，请检查 dump.cs 路径是否正确`,
        metadata: { success: false, extracted: [] },
      }
    }

    // Step 3: 转换为可编译 C# 骨架
    const files = buildCSharpFiles(extracted)

    if (args.dryRun) {
      return {
        output: [
          `[DRY RUN] 将生成 ${files.length} 个骨架文件到 ${outDir}:`,
          ...files.map(f => `  + ${f.filename} (${f.classCount} 个类, ns: ${[...f.namespaces].join(", ")})`),
        ].join("\n"),
        metadata: { success: true, files: files.map(f => f.filename) },
      }
    }

    // Step 4: 写入文件
    await fs.mkdir(outDir, { recursive: true })
    const written: string[] = []
    for (const f of files) {
      const outPath = path.join(outDir, f.filename)
      await fs.writeFile(outPath, f.content, "utf8")
      // 生成 .meta 文件（确保 Unity 识别）
      await fs.writeFile(outPath + ".meta", generateMeta(f.filename))
      written.push(f.filename)
    }

    // Step 5: 移除 AssetRipper export 中的非泛型冲突版本
    let removedCount = 0
    const removedFiles: string[] = []
    if (args.conflictDir) {
      const result = await removeNonGenericConflicts(
        path.resolve(args.conflictDir),
        extracted.map(e => e.className),
      )
      removedCount = result.removed
      removedFiles.push(...result.files)
    }

    return {
      output: [
        `✅ 生成 ${written.length} 个泛型骨架文件到 ${outDir}`,
        ...written.map(f => `  + ${f}`),
        removedCount > 0 ? `\n移除 ${removedCount} 个 AssetRipper 非泛型冲突文件:` : "",
        ...removedFiles.map(f => `  - ${f}`),
      ].filter(Boolean).join("\n"),
      metadata: {
        success: true,
        written,
        removedConflicts: removedFiles,
        classesExtracted: extracted.length,
      },
    }
  },
})

// ── 检测脚本中实际用到的泛型类型 ──────────────────────────────────────

async function detectUsedGenerics(scriptsDir: string): Promise<string[]> {
  const used = new Set<string>()
  const stack = [scriptsDir]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: string[]
    try { entries = await fs.readdir(dir) } catch { continue }
    for (const entry of entries) {
      const full = path.join(dir, entry)
      if (entry.endsWith(".cs")) {
        try {
          const content = await fs.readFile(full, "utf8")
          // 匹配泛型用法：ClassName<T> 或字段类型
          for (const m of content.matchAll(/\b([A-Z][a-zA-Z]+)<[A-Za-z,\s]+>/g)) {
            used.add(m[1])
          }
        } catch {}
      } else if (!entry.startsWith(".")) {
        try {
          const stat = await fs.stat(full)
          if (stat.isDirectory()) stack.push(full)
        } catch {}
      }
    }
  }
  return [...used]
}

// ── 从 dump.cs 提取类块 ───────────────────────────────────────────────

interface ExtractedClass {
  namespace: string
  className: string
  fullDeclaration: string  // 包含泛型参数的完整声明行
  body: string             // 类体（方法/字段）
  attributes: string[]     // [Serializable] 等
  isInterface: boolean
  isAbstract: boolean
  rawBlock: string         // 原始 dump.cs 内容
}

function extractClassBlocks(dumpContent: string, targetClassNames: string[]): ExtractedClass[] {
  const results: ExtractedClass[] = []
  const targetSet = new Set(targetClassNames)

  // 按命名空间+类块扫描
  // 格式：// Namespace: X.Y.Z\n[attrs]\npublic [abstract] class/interface Name<T>... { ... }
  const classPattern = /\/\/ Namespace: ([\w.]+)\n((?:\[[^\]]+\]\n)*)public ((?:abstract |sealed )?)(class|interface) ([A-Za-z_]\w*(?:<[^{]+>)?)[^{]*\{/g

  let match: RegExpExecArray | null
  while ((match = classPattern.exec(dumpContent)) !== null) {
    const namespace = match[1]
    const attrBlock = match[2]
    const modifier = match[3]
    const kind = match[4]
    const fullDecl = match[5]  // e.g. "Getter<T>" or "BaseLevelCreator<TCreatorData, TLevelData>"
    const baseName = fullDecl.split("<")[0].split(" ")[0]

    if (!targetSet.has(baseName)) continue

    // 提取类体（匹配大括号）
    const bodyStart = match.index + match[0].length - 1  // position of opening {
    let depth = 0
    let pos = bodyStart
    while (pos < dumpContent.length) {
      if (dumpContent[pos] === "{") depth++
      else if (dumpContent[pos] === "}") {
        depth--
        if (depth === 0) break
      }
      pos++
    }
    const rawBlock = dumpContent.slice(match.index, pos + 1)
    const body = dumpContent.slice(bodyStart + 1, pos)

    results.push({
      namespace,
      className: baseName,
      fullDeclaration: `public ${modifier}${kind} ${fullDecl}`,
      body,
      attributes: attrBlock.trim().split("\n").filter(Boolean),
      isInterface: kind === "interface",
      isAbstract: modifier.includes("abstract"),
      rawBlock,
    })
  }

  return results
}

// ── 将 dump.cs 类块转换为可编译 C# 骨架 ─────────────────────────────

interface GeneratedFile {
  filename: string
  content: string
  classCount: number
  namespaces: Set<string>
}

function buildCSharpFiles(classes: ExtractedClass[]): GeneratedFile[] {
  // 按命名空间分组
  const byNamespace = new Map<string, ExtractedClass[]>()
  for (const cls of classes) {
    if (!byNamespace.has(cls.namespace)) byNamespace.set(cls.namespace, [])
    byNamespace.get(cls.namespace)!.push(cls)
  }

  const files: GeneratedFile[] = []

  for (const [ns, nsClasses] of byNamespace.entries()) {
    const filename = `_GenericStubs_${ns.replace(/\./g, "_")}.cs`
    const classBlocks: string[] = []

    for (const cls of nsClasses) {
      const converted = convertClassToSkeleton(cls)
      classBlocks.push(converted)
    }

    const content = [
      "// AUTO-GENERATED: Generic framework stubs extracted from dump.cs",
      "// These replace non-generic versions produced by AssetRipper (IL2CPP generic erasure workaround)",
      "// DO NOT EDIT manually - regenerate using unity-dump-framework-gen tool",
      "",
      "using System;",
      "using System.Collections.Generic;",
      "using UnityEngine;",
      "using Cysharp.Threading.Tasks;",
      "",
      `namespace ${ns}`,
      "{",
      ...classBlocks.map(b => b.split("\n").map(l => "    " + l).join("\n")),
      "}",
    ].join("\n")

    files.push({
      filename,
      content,
      classCount: nsClasses.length,
      namespaces: new Set([ns]),
    })
  }

  return files
}

function convertClassToSkeleton(cls: ExtractedClass): string {
  const lines: string[] = []

  // Attributes
  for (const attr of cls.attributes) {
    if (attr && !attr.includes("TypeDefIndex")) lines.push(attr)
  }

  // Find base class and interfaces from the original declaration in dump
  // We need the full "public class Getter<T> : SerializableInterface<IGet<T>>, IGet<T>, IGet" line
  const rawFirstLine = cls.rawBlock.split("\n").find(l => l.includes(`${cls.isInterface ? "interface" : "class"} ${cls.className}`)) ?? ""
  // Clean up // TypeDefIndex comment
  const cleanDecl = rawFirstLine.replace(/\/\/ TypeDefIndex: \d+/, "").trim()

  lines.push(cleanDecl)
  lines.push("{")

  // Parse body: extract fields, properties, methods
  const bodyLines = cls.body.split("\n")
  let i = 0
  while (i < bodyLines.length) {
    const line = bodyLines[i].trim()

    // Skip RVA comments, GenericInstMethod blocks, empty lines groups
    if (line.startsWith("// RVA:") || line.startsWith("// Slot:") ||
        line.startsWith("/* GenericInstMethod") || line.startsWith("|-") ||
        line === "*/") {
      i++
      continue
    }

    // Section comments (// Fields, // Properties, // Methods)
    if (line.startsWith("// ") && !line.includes("(") && !line.includes("{")) {
      lines.push(`    ${line}`)
      i++
      continue
    }

    // Fields: keep as-is (attributes + field declaration)
    if (line.match(/^\[/) || line.match(/^(public|private|protected|internal|static)\s.+;\s*(?:\/\/ 0x[0-9a-f]+)?$/)) {
      const cleanLine = line.replace(/\s*\/\/ 0x[0-9a-f]+$/, "").trim()
      // Skip compiler-generated backing fields like <PropName>k__BackingField - invalid C# source syntax
      if (cleanLine && !cleanLine.startsWith("//") && !cleanLine.includes("<") && !cleanLine.includes(">")) {
        lines.push(`    ${cleanLine}`)
      }
      i++
      continue
    }

    // Method/property declarations: convert body to skeleton
    if (line.match(/^(public|private|protected|internal|override|virtual|abstract|static|new)\s/) && line.includes("(")) {
      let methodLine = line.replace(/\s*\/\/ TypeDefIndex.*$/, "").trim()

      // Skip IL constructors (.ctor) - they're not valid C# method names
      if (methodLine.includes(".ctor") || methodLine.includes(".cctor")) {
        i++
        continue
      }

      // Skip property accessor methods (get_X / set_X) - causes CS0082 duplicate accessor error
      if (methodLine.match(/^(public|private|protected)\s.*\s(get_|set_)\w+\s*\(/)) {
        i++
        continue
      }

      // Replace external/unknown types in method signatures with 'object' to avoid CS0246
      // Known external types that may not be in scope: UniTask, SaveArgs, CreationArgs, etc.
      // Pattern: types that appear in return position or parameters but aren't C# primitives
      const EXTERNAL_TYPES = ['UniTask', 'UniTaskVoid', 'SaveArgs', 'CreationArgs', 'CancellationToken']
      for (const ext of EXTERNAL_TYPES) {
        const regex = new RegExp(`\\b${ext}\\b`, 'g')
        methodLine = methodLine.replace(regex, ext === 'UniTask' || ext === 'UniTaskVoid' ? 'System.Threading.Tasks.Task' : 'object')
      }

      if (cls.isInterface || line.includes("abstract ")) {
        // Interface/abstract: keep declaration, no body
        lines.push(`    ${methodLine.replace(/\s*\{\s*\}\s*$/, ";").replace(/;$/, ";")}`)
      } else if (line.endsWith("{ }") || line.endsWith("{}")) {
        // Empty body → return default or void
        const returnType = inferReturnType(methodLine)
        if (returnType === "void" || methodLine.includes("void ")) {
          lines.push(`    ${methodLine.replace(/\{ \}|\{\}/, "{ }")}`)
        } else {
          lines.push(`    ${methodLine.replace(/\{ \}|\{\}/, "{ return default; }")}`)
        }
      } else {
        lines.push(`    ${methodLine}`)
      }
      i++
      continue
    }

    // Properties with getter/setter blocks
    if (line.match(/^(public|private|protected)\s.+\{$/) || line.match(/\{ get;/)) {
      const cleanLine = line.replace(/\s*\/\/ TypeDefIndex.*$/, "")
      lines.push(`    ${cleanLine}`)
      i++
      continue
    }

    // Braces
    if (line === "{" || line === "}") {
      lines.push(`    ${line}`)
      i++
      continue
    }

    // Everything else: skip or include as comment
    i++
  }

  lines.push("}")
  return lines.join("\n")
}

function inferReturnType(methodSignature: string): string {
  // Extract return type from "public [modifier] ReturnType MethodName(...)"
  const m = methodSignature.match(/(?:public|private|protected|static|virtual|override|abstract|new|sealed)\s+(?:static\s+)?([A-Za-z<>\[\],\s?]+?)\s+\w+\s*[(<]/)
  if (!m) return "void"
  const rt = m[1].trim()
  if (rt === "void") return "void"
  return rt
}

// ── 移除 AssetRipper export 中的非泛型冲突文件 ──────────────────────

async function removeNonGenericConflicts(
  conflictDir: string,
  genericClassNames: string[],
): Promise<{ removed: number; files: string[] }> {
  const genericSet = new Set(genericClassNames)
  const removed: string[] = []
  const stack = [conflictDir]

  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: string[]
    try { entries = await fs.readdir(dir) } catch { continue }

    for (const entry of entries) {
      const full = path.join(dir, entry)
      if (entry.endsWith(".cs")) {
        try {
          const content = await fs.readFile(full, "utf8")
          // Check if this file defines a non-generic version of a class we've replaced
          for (const cls of genericSet) {
            // Non-generic: "class Getter :" or "class Getter {" but NOT "class Getter<"
            if (content.match(new RegExp(`class ${cls}[^<{\\s]`)) ||
                content.match(new RegExp(`class ${cls}\\s*[:{]`))) {
              // Confirm it's NOT generic
              if (!content.includes(`class ${cls}<`)) {
                await fs.unlink(full).catch(() => {})
                await fs.unlink(full + ".meta").catch(() => {})
                removed.push(full)
                break
              }
            }
          }
        } catch {}
      } else if (!entry.startsWith(".")) {
        try {
          const stat = await fs.stat(full)
          if (stat.isDirectory()) stack.push(full)
        } catch {}
      }
    }
  }

  return { removed: removed.length, files: removed }
}

// ── 生成 Unity .meta 文件 ─────────────────────────────────────────────

function generateMeta(filename: string): string {
  const { createHash } = require("crypto")
  const guid = createHash("md5").update("gen-stub:" + filename).digest("hex").slice(0, 32)
  return `fileFormatVersion: 2\nguid: ${guid}\nMonoImporter:\n  externalObjects: {}\n  serializedVersion: 2\n  defaultReferences: []\n  executionOrder: 0\n  icon: {instanceID: 0}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`
}
