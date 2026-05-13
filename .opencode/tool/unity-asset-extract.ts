import { tool } from "@opencode-ai/plugin"
import * as path from "path"
import * as fs from "fs/promises"
import * as os from "os"

export default tool({
  description:
    "Extract Unity assets using AssetRipper. Extracts textures, models, audio, scenes, prefabs, ScriptableObjects, and all game resources needed for a complete Unity project reconstruction.",

  args: {
    inputPath: tool.schema.string().describe("Path to unpacked APK/IPA directory or assets folder"),
    outputDir: tool.schema.string().describe("Output directory for extracted assets"),
    assetRipperPath: tool.schema
      .string()
      .optional()
      .describe("Custom AssetRipper path (auto-detected from ~/UnPackTools/AssetRipper if not specified)"),
    exportFormat: tool.schema
      .object({
        textures: tool.schema.string().optional(),
        models: tool.schema.string().optional(),
        audio: tool.schema.string().optional(),
      })
      .optional()
      .describe("Export format preferences"),
    includeScenes: tool.schema.boolean().optional().describe("Extract scene files (default: true)"),
    includePrefabs: tool.schema.boolean().optional().describe("Extract prefabs (default: true)"),
    includeScriptableObjects: tool.schema
      .boolean()
      .optional()
      .describe("Extract ScriptableObject data (default: true)"),
  },

  async execute(args, ctx) {
    const includeScenes = args.includeScenes !== false
    const includePrefabs = args.includePrefabs !== false
    const includeScriptableObjects = args.includeScriptableObjects !== false

    // Step 1: Locate AssetRipper
    let assetRipperPath = args.assetRipperPath

    if (!assetRipperPath) {
      // Auto-detect from ~/UnPackTools/AssetRipper
      const homeDir = os.homedir()
      const possiblePaths = [
        path.join(homeDir, "UnPackTools/AssetRipper/AssetRipper.GUI.Free"),
        path.join(homeDir, "UnPackTools/AssetRipper/AssetRipper"),
        path.join(homeDir, "UnPackAPP/UnPackTools/AssetRipper/AssetRipper.GUI.Free"),
        "/Applications/AssetRipper.app/Contents/MacOS/AssetRipper",
      ]

      for (const p of possiblePaths) {
        try {
          await fs.access(p)
          assetRipperPath = p
          break
        } catch {}
      }
    }

    if (!assetRipperPath) {
      return {
        output: `Error: AssetRipper not found

Searched locations:
- ~/UnPackTools/AssetRipper/AssetRipper.GUI.Free
- ~/UnPackAPP/UnPackTools/AssetRipper/AssetRipper.GUI.Free
- /Applications/AssetRipper.app

Please either:
1. Install AssetRipper to ~/UnPackTools/AssetRipper/
2. Specify custom path with --assetRipperPath parameter

Download AssetRipper: https://github.com/AssetRipper/AssetRipper/releases`,
        metadata: { success: false, error: "AssetRipper not found" },
      }
    }

    // Verify AssetRipper is executable
    try {
      await ctx.bash(`chmod +x "${assetRipperPath}"`)
    } catch (error) {
      console.log("Warning: Could not set executable permission:", error)
    }

    // Step 2: Verify input path
    try {
      await fs.access(args.inputPath)
    } catch (error) {
      return {
        output: `Error: Input path not found: ${args.inputPath}`,
        metadata: { success: false, error: "Invalid input path" },
      }
    }

    // Step 3: Create output directory
    await fs.mkdir(args.outputDir, { recursive: true })

    // Step 4: Prepare AssetRipper command
    // AssetRipper CLI usage (if supported) or use API mode
    const logPath = path.join(args.outputDir, "assetripper.log")

    console.log(`Starting AssetRipper extraction...`)
    console.log(`Input: ${args.inputPath}`)
    console.log(`Output: ${args.outputDir}`)
    console.log(`AssetRipper: ${assetRipperPath}`)

    // Try to use AssetRipper
    // Note: AssetRipper.GUI.Free may not have full CLI support
    // We'll try different approaches

    let extractionResult
    try {
      // Approach 1: Try command-line export (if supported)
      const cmd = `"${assetRipperPath}" "${args.inputPath}" -o "${args.outputDir}" > "${logPath}" 2>&1 || echo "AssetRipper completed with status $?"`

      extractionResult = await ctx.bash(cmd, { timeout: 1800000 }) // 30 min timeout
    } catch (error) {
      // Approach 2: Manual instructions if automation fails
      return {
        output: `AssetRipper automation not fully supported.

Please run AssetRipper manually:
1. Open AssetRipper: ${assetRipperPath}
2. Load files from: ${args.inputPath}
3. Export to: ${args.outputDir}
4. Then continue with unity-scene-rebuilder

Alternative: Install AssetRipper CLI wrapper
  See: https://github.com/AssetRipper/AssetRipper/discussions/1483

Attempted command:
${assetRipperPath} "${args.inputPath}" -o "${args.outputDir}"

Error: ${error}`,
        metadata: {
          success: false,
          error: "Manual intervention required",
          assetRipperPath: assetRipperPath,
          inputPath: args.inputPath,
          outputDir: args.outputDir,
        },
      }
    }

    // Step 5: Verify extraction results
    const expectedDirs = {
      Assets: includeScenes || includePrefabs,
      ProjectSettings: true,
    }

    const foundDirs = []
    const missingDirs = []

    for (const [dir, required] of Object.entries(expectedDirs)) {
      const dirPath = path.join(args.outputDir, dir)
      try {
        await fs.access(dirPath)
        foundDirs.push(dir)
      } catch {
        if (required) {
          missingDirs.push(dir)
        }
      }
    }

    // Step 6: Analyze extracted content
    let assetStats = {
      textures: 0,
      models: 0,
      audio: 0,
      scenes: 0,
      prefabs: 0,
      scripts: 0,
      materials: 0,
      animations: 0,
    }

    try {
      const assetsDir = path.join(args.outputDir, "Assets")

      // Count different asset types
      const countAssets = async (dir: string, extensions: string[]) => {
        try {
          const files = await ctx.glob(path.join(dir, "**/*"))
          return files.filter((f) => extensions.some((ext) => f.endsWith(ext))).length
        } catch {
          return 0
        }
      }

      assetStats.textures = await countAssets(assetsDir, [".png", ".jpg", ".tga"])
      assetStats.models = await countAssets(assetsDir, [".fbx", ".obj"])
      assetStats.audio = await countAssets(assetsDir, [".wav", ".mp3", ".ogg"])
      assetStats.scenes = await countAssets(assetsDir, [".unity"])
      assetStats.prefabs = await countAssets(assetsDir, [".prefab"])
      assetStats.materials = await countAssets(assetsDir, [".mat"])
      assetStats.animations = await countAssets(assetsDir, [".anim"])
    } catch (error) {
      console.log("Warning: Could not analyze assets:", error)
    }

    // Step 7: Generate asset manifest
    const manifestPath = path.join(args.outputDir, "asset_manifest.json")
    const manifest = {
      timestamp: new Date().toISOString(),
      inputPath: args.inputPath,
      assetRipperPath: assetRipperPath,
      statistics: assetStats,
      directories: foundDirs,
      exportSettings: args.exportFormat || {},
    }

    await ctx.write(manifestPath, JSON.stringify(manifest, null, 2))

    // Step 8: Check for critical assets
    const hasCriticalAssets = assetStats.scenes > 0 || assetStats.prefabs > 0
    const totalAssets = Object.values(assetStats).reduce((sum, n) => sum + n, 0)

    if (totalAssets === 0) {
      return {
        output: `Warning: AssetRipper extraction completed but no assets found

This could mean:
1. AssetRipper needs to be run manually (GUI mode)
2. Input path doesn't contain Unity assets
3. Assets are in a format AssetRipper can't handle

Please try:
1. Run AssetRipper GUI manually: ${assetRipperPath}
2. Load: ${args.inputPath}
3. Export to: ${args.outputDir}

Check log: ${logPath}`,
        metadata: {
          success: false,
          warning: "No assets extracted",
          assetRipperPath: assetRipperPath,
          logPath: logPath,
          statistics: assetStats,
        },
      }
    }

    return {
      output: `AssetRipper extraction completed!

AssetRipper: ${assetRipperPath}
Input: ${args.inputPath}
Output: ${args.outputDir}

Extracted Assets:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 Textures: ${assetStats.textures}
🎨 Models: ${assetStats.models}
🔊 Audio: ${assetStats.audio}
🎬 Scenes: ${assetStats.scenes}
🧩 Prefabs: ${assetStats.prefabs}
✨ Materials: ${assetStats.materials}
🏃 Animations: ${assetStats.animations}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total: ${totalAssets} assets

Directories created:
${foundDirs.map((d) => `✓ ${d}/`).join("\n")}

${
  hasCriticalAssets
    ? "✓ Critical assets found (Scenes/Prefabs) - Unity project can be reconstructed!"
    : "⚠️  No scenes or prefabs found - project may need manual scene setup"
}

Manifest: ${manifestPath}

Next steps:
1. Run unity-scene-rebuilder to reconstruct scenes
2. Run unity-reference-fixer to fix asset references
3. Run unity-project-builder to create complete Unity project`,

      metadata: {
        success: true,
        outputDir: args.outputDir,
        assetRipperPath: assetRipperPath,
        manifestPath: manifestPath,
        statistics: assetStats,
        totalAssets: totalAssets,
        hasCriticalAssets: hasCriticalAssets,
        directories: foundDirs,
      },
    }
  },
})
