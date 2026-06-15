import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"

// Known Unity official packages: namespace prefix → package info
const UNITY_OFFICIAL: Record<string, { pkg: string; version: string }> = {
  "Cinemachine":                  { pkg: "com.unity.cinemachine",   version: "3.1.3" },
  "Unity.Cinemachine":            { pkg: "com.unity.cinemachine",   version: "3.1.3" },
  "UnityEngine.Splines":          { pkg: "com.unity.splines",       version: "2.6.1" },
  "Unity.Mathematics":            { pkg: "com.unity.mathematics",   version: "1.3.2" },
  "Unity.Collections":            { pkg: "com.unity.collections",   version: "2.4.4" },
  "Unity.Burst":                  { pkg: "com.unity.burst",         version: "1.8.18" },
  "UnityEngine.Timeline":         { pkg: "com.unity.timeline",      version: "1.8.7" },
  "UnityEngine.Localization":     { pkg: "com.unity.localization",  version: "1.5.3" },
  "UnityEngine.AddressableAssets":{ pkg: "com.unity.addressables",  version: "2.2.2" },
  "UnityEngine.InputSystem":      { pkg: "com.unity.inputsystem",   version: "1.8.2" },
}

// Known third-party packages: namespace root → info
const THIRD_PARTY: Record<string, { name: string; url: string }> = {
  "DG":          { name: "DOTween / DOTween Pro",        url: "https://assetstore.unity.com/packages/tools/animation/dotween-hotween-v2-27676" },
  "Sirenix":     { name: "Odin Inspector",               url: "https://assetstore.unity.com/packages/tools/utilities/odin-inspector-and-serializer-89041" },
  "Cysharp":     { name: "UniTask",                      url: "https://github.com/Cysharp/UniTask" },
  "Coffee":      { name: "Coffee.UIEffect / UIParticle", url: "https://github.com/mob-sakai/UIEffect" },
  "BrunoMikoski":{ name: "Animation Sequencer",          url: "https://github.com/brunomikoski/Animation-Sequencer" },
  "Obi":         { name: "Obi (rope/fluid/cloth)",       url: "https://assetstore.unity.com/publishers/10839" },
  "Nakama":      { name: "Nakama SDK",                   url: "https://github.com/heroiclabs/nakama-unity" },
  "MessagePack": { name: "MessagePack for C#",           url: "https://github.com/MessagePack-CSharp/MessagePack-CSharp" },
  "Dreamteck":   { name: "Dreamteck Splines",            url: "https://assetstore.unity.com/packages/tools/utilities/dreamteck-splines-61926" },
}

export default tool({
  description: "Scans C# scripts in a Unity project for using directives. Auto-installs Unity official packages into manifest.json. Lists third-party packages the user must import manually.",

  args: {
    projectPath: tool.schema.string().describe("Unity project root path"),
    scriptsDir:  tool.schema.string().optional().describe("C# scripts directory (defaults to Assets/Scripts)"),
    dryRun:      tool.schema.boolean().optional().describe("Preview only, don't write manifest"),
  },

  async execute(args) {
    const projectPath  = path.resolve(args.projectPath)
    const scriptsDir   = path.resolve(args.scriptsDir ?? path.join(projectPath, "Assets", "Scripts"))
    const manifestPath = path.join(projectPath, "Packages", "manifest.json")

    // Read existing manifest
    let manifest: { dependencies?: Record<string, string> } = { dependencies: {} }
    try {
      manifest = JSON.parse(await Bun.file(manifestPath).text())
    } catch { /* new project */ }
    const installed = new Set(Object.keys(manifest.dependencies ?? {}))

    // Collect all namespace roots used in C# scripts
    const usedRoots = new Set<string>()
    await walkDir(scriptsDir, async (file) => {
      if (!file.endsWith(".cs")) return
      const content = await Bun.file(file).text().catch(() => "")
      for (const m of content.matchAll(/^using ([\w.]+);/gm)) {
        const parts = m[1].split(".")
        usedRoots.add(parts[0])
        if (parts.length > 1) usedRoots.add(parts[0] + "." + parts[1])
      }
    })

    // Detect Unity official packages to install
    const toInstall: Array<{ pkg: string; version: string; ns: string }> = []
    for (const [ns, info] of Object.entries(UNITY_OFFICIAL)) {
      const root = ns.split(".")[0]
      if ((usedRoots.has(root) || usedRoots.has(ns)) && !installed.has(info.pkg)) {
        if (!toInstall.find(x => x.pkg === info.pkg)) {
          toInstall.push({ ...info, ns })
        }
      }
    }

    // Detect third-party packages needed
    const thirdParty: Array<{ name: string; url: string; ns: string }> = []
    for (const [ns, info] of Object.entries(THIRD_PARTY)) {
      if (usedRoots.has(ns)) {
        thirdParty.push({ ...info, ns })
      }
    }

    // Write to manifest unless dry run
    let addedCount = 0
    if (!args.dryRun && toInstall.length > 0) {
      if (!manifest.dependencies) manifest.dependencies = {}
      for (const { pkg, version } of toInstall) {
        manifest.dependencies[pkg] = version
        addedCount++
      }
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8")
    }

    const lines: string[] = []

    if (toInstall.length === 0) {
      lines.push("（无需安装新的 Unity 官方包）")
    } else if (args.dryRun) {
      lines.push(`[DRY RUN] 将写入 ${toInstall.length} 个 Unity 官方包到 manifest.json:`)
      toInstall.forEach(p => lines.push(`  + ${p.pkg}: ${p.version}  [namespace: ${p.ns}]`))
    } else {
      lines.push(`✅ 已写入 ${addedCount} 个 Unity 官方包到 manifest.json（Editor 刷新后自动安装）:`)
      toInstall.forEach(p => lines.push(`  + ${p.pkg}: ${p.version}  [namespace: ${p.ns}]`))
    }

    if (thirdParty.length > 0) {
      lines.push(`\n⚠️  检测到 ${thirdParty.length} 个第三方包，需要用户手动导入:`)
      thirdParty.forEach(p => lines.push(`  - ${p.name}\n    获取: ${p.url}  [namespace: ${p.ns}]`))
    }

    return {
      output: lines.join("\n"),
      metadata: {
        success: true,
        unityPackagesAdded: toInstall.map(p => p.pkg),
        thirdPartyRequired: thirdParty.map(p => ({ name: p.name, url: p.url })),
        manifestUpdated: addedCount > 0,
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
    } catch { /* skip unreadable */ }
  }
}
