import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"

export default tool({
  description: "Scans Unity scenes/prefabs for MonoBehaviour script GUIDs, generates minimal placeholder MonoBehaviour scripts with matching GUIDs. Eliminates Missing Script without adding game logic. Phase 2 replaces placeholders with real implementations.",

  args: {
    projectPath:      tool.schema.string().describe("Unity project path"),
    sourceExportPath: tool.schema.string().optional().describe("AssetRipper export path to resolve class names from .cs.meta files"),
    outputDir:        tool.schema.string().optional().describe("Output directory (default: Assets/Scripts/Placeholders)"),
    dryRun:           tool.schema.boolean().optional().describe("Preview only, don't write files"),
  },

  async execute(args) {
    const projectPath = path.resolve(args.projectPath)
    const assetsDir   = path.join(projectPath, "Assets")
    const outDir      = path.resolve(args.outputDir ?? path.join(assetsDir, "Scripts", "Placeholders"))

    // Step 1: Collect all script GUIDs referenced in scenes + prefabs
    const referencedGuids = new Set<string>()
    await walkDir(assetsDir, async (file) => {
      if (!file.endsWith(".unity") && !file.endsWith(".prefab")) return
      const content = await Bun.file(file).text().catch(() => "")
      for (const m of content.matchAll(/m_Script: \{fileID: \d+, guid: ([a-f0-9]{32}), type: \d\}/g)) {
        const guid = m[1]
        if (guid !== "0".repeat(32)) referencedGuids.add(guid)
      }
    })

    // Step 2: Build GUID → className map from existing project .cs.meta files
    const guidToClass = new Map<string, string>()
    await walkDir(assetsDir, async (file) => {
      if (!file.endsWith(".cs.meta")) return
      const content = await Bun.file(file).text().catch(() => "")
      const m = content.match(/^guid: ([a-f0-9]+)/m)
      if (m) guidToClass.set(m[1], path.basename(file, ".cs.meta"))
    })

    // Also scan AssetRipper export meta files if provided
    if (args.sourceExportPath) {
      const exportScripts = path.join(path.resolve(args.sourceExportPath), "Assets", "Scripts")
      await walkDir(exportScripts, async (file) => {
        if (!file.endsWith(".cs.meta")) return
        const content = await Bun.file(file).text().catch(() => "")
        const m = content.match(/^guid: ([a-f0-9]+)/m)
        if (m && !guidToClass.has(m[1])) {
          guidToClass.set(m[1], path.basename(file, ".cs.meta"))
        }
      })
    }

    // Step 3: Find existing script GUIDs in project
    const existingGuids = new Set<string>()
    await walkDir(assetsDir, async (file) => {
      if (!file.endsWith(".cs.meta")) return
      const content = await Bun.file(file).text().catch(() => "")
      const m = content.match(/^guid: ([a-f0-9]+)/m)
      if (m) existingGuids.add(m[1])
    })

    // Step 4: Determine which GUIDs need placeholders
    const toGenerate: Array<{ guid: string; className: string }> = []
    for (const guid of referencedGuids) {
      if (!existingGuids.has(guid)) {
        const className = guidToClass.get(guid) ?? `Placeholder_${guid.slice(0, 8)}`
        toGenerate.push({ guid, className })
      }
    }

    if (toGenerate.length === 0) {
      return {
        output: "✅ 所有 MonoBehaviour 引用均已有对应脚本，无需生成占位文件",
        metadata: { success: true, generated: 0 },
      }
    }

    if (args.dryRun) {
      return {
        output: [
          `[DRY RUN] 将生成 ${toGenerate.length} 个占位脚本到 ${outDir}:`,
          ...toGenerate.slice(0, 20).map(({ guid, className }) => `  + ${className}.cs  [guid: ${guid}]`),
          toGenerate.length > 20 ? `  ... 还有 ${toGenerate.length - 20} 个` : "",
        ].filter(Boolean).join("\n"),
        metadata: { success: true, wouldGenerate: toGenerate.length },
      }
    }

    // Step 5: Write placeholder files
    await fs.mkdir(outDir, { recursive: true })
    const written: string[] = []

    for (const { guid, className } of toGenerate) {
      const csContent = [
        "// AUTO-GENERATED PLACEHOLDER — DO NOT EDIT",
        "// Temporary stub to prevent Missing Script errors.",
        "// Replace with real implementation in Phase 2 (unity-logic-rebuild).",
        "using UnityEngine;",
        "",
        `public class ${className} : MonoBehaviour { }`,
        "",
      ].join("\n")

      const metaContent = [
        "fileFormatVersion: 2",
        `guid: ${guid}`,
        "MonoImporter:",
        "  externalObjects: {}",
        "  serializedVersion: 2",
        "  defaultReferences: []",
        "  executionOrder: 0",
        "  icon: {instanceID: 0}",
        "  userData: ",
        "  assetBundleName: ",
        "  assetBundleVariant: ",
        "",
      ].join("\n")

      const csPath = path.join(outDir, `${className}.cs`)
      await fs.writeFile(csPath, csContent, "utf8")
      await fs.writeFile(csPath + ".meta", metaContent, "utf8")
      written.push(className)
    }

    return {
      output: [
        `✅ 生成 ${written.length} 个占位脚本到 ${outDir}`,
        "   场景/Prefab 中的所有 MonoBehaviour 引用现在都有对应脚本（无 Missing Script）",
        "   占位脚本仅包含空类定义，Phase 2 (unity-logic-rebuild) 会替换为真实实现",
      ].join("\n"),
      metadata: {
        success: true,
        generated: written.length,
        outputDir: outDir,
        classNames: written,
      },
    }
  },
})

async function walkDir(dir: string, fn: (file: string) => Promise<void>): Promise<void> {
  let entries: string[]
  try { entries = await fs.readdir(dir) } catch { return }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue
    const full = path.join(dir, entry)
    try {
      const stat = await fs.stat(full)
      if (stat.isDirectory()) await walkDir(full, fn)
      else await fn(full)
    } catch { /* skip */ }
  }
}
