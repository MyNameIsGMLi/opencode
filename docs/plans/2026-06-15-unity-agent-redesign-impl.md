# Unity Agent Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `unity-game-reverse` and `unity-game-reverse-visual` with two focused agents (`unity-asset-restore` + `unity-logic-rebuild`) and two new tools (`unity-script-placeholder` + `unity-upm-detector`).

**Architecture:** Asset layer (Phase 1) and Logic layer (Phase 2) are fully independent agents with separate state files. Phase 1 produces a visually correct project with placeholder scripts. Phase 2 replaces placeholders with real logic. IDA remains on-demand in Phase 3.

**Tech Stack:** OpenCode agent markdown files, TypeScript tools using Bun APIs.

---

## Reference Files

Before starting, read:
- `docs/plans/2026-06-15-unity-agent-redesign.md` — the approved design doc
- `.opencode/agent/unity-game-reverse.md` — existing agent to understand patterns
- `.opencode/agent/unity-asset-manager.md` — subagent used by new agents
- `.opencode/agent/unity-workflow-manager.md` — subagent used by new agents
- `.opencode/tool/unity-shader-fix.ts` — tool used in Stage 4
- `.opencode/tool/unity-assetripper-export.ts` — tool used in Stage 1

---

## Task 1: Create `unity-upm-detector.ts` tool

**Files:**
- Create: `.opencode/tool/unity-upm-detector.ts`

**Step 1: Write the tool**

This tool scans scenes/prefabs for MonoBehaviour script GUIDs and C# `using` directives to detect which UPM packages are needed. It outputs two lists: Unity official packages (auto-install) and third-party packages (user prompt).

```typescript
import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"

// Known Unity official packages: namespace prefixes that indicate the package
const UNITY_OFFICIAL_PACKAGES: Record<string, { pkg: string; version: string }> = {
  "Unity.Cinemachine":           { pkg: "com.unity.cinemachine",   version: "3.1.3" },
  "Cinemachine":                 { pkg: "com.unity.cinemachine",   version: "3.1.3" },
  "Unity.Splines":               { pkg: "com.unity.splines",       version: "2.6.1" },
  "UnityEngine.Splines":         { pkg: "com.unity.splines",       version: "2.6.1" },
  "Unity.Mathematics":           { pkg: "com.unity.mathematics",   version: "1.3.2" },
  "Unity.Collections":           { pkg: "com.unity.collections",   version: "2.4.4" },
  "Unity.Burst":                 { pkg: "com.unity.burst",         version: "1.8.18" },
  "UnityEngine.Timeline":        { pkg: "com.unity.timeline",      version: "1.8.7" },
  "UnityEngine.Localization":    { pkg: "com.unity.localization",  version: "1.5.3" },
  "UnityEngine.AddressableAssets":{ pkg: "com.unity.addressables",  version: "2.2.2" },
  "UnityEngine.InputSystem":     { pkg: "com.unity.inputsystem",   version: "1.8.2" },
}

// Known third-party packages: namespace prefixes
const THIRD_PARTY_PACKAGES: Record<string, { name: string; url: string }> = {
  "DG":          { name: "DOTween / DOTween Pro", url: "https://assetstore.unity.com/packages/tools/animation/dotween-hotween-v2-27676" },
  "Sirenix":     { name: "Odin Inspector", url: "https://assetstore.unity.com/packages/tools/utilities/odin-inspector-and-serializer-89041" },
  "Cysharp":     { name: "UniTask", url: "https://github.com/Cysharp/UniTask" },
  "Coffee":      { name: "Coffee.UIEffect / Coffee.UIParticle", url: "https://github.com/mob-sakai/UIEffect" },
  "BrunoMikoski":{ name: "Animation Sequencer", url: "https://github.com/brunomikoski/Animation-Sequencer" },
  "Obi":         { name: "Obi (rope/fluid/cloth)", url: "https://assetstore.unity.com/publishers/10839" },
  "Nakama":      { name: "Nakama SDK", url: "https://github.com/heroiclabs/nakama-unity" },
  "MessagePack": { name: "MessagePack for C#", url: "https://github.com/MessagePack-CSharp/MessagePack-CSharp" },
  "Dreamteck":   { name: "Dreamteck Splines", url: "https://assetstore.unity.com/packages/tools/utilities/dreamteck-splines-61926" },
}

export default tool({
  description: "Scans Unity project scenes/prefabs and C# scripts to detect missing UPM packages. Outputs two lists: Unity official packages (auto-installable) and third-party packages (user must import manually).",

  args: {
    projectPath: tool.schema.string().describe("Unity project path"),
    scriptsDir:  tool.schema.string().optional().describe("C# scripts directory to scan for using directives"),
  },

  async execute(args) {
    const projectPath = path.resolve(args.projectPath)
    const assetsDir   = path.join(projectPath, "Assets")
    const manifestPath= path.join(projectPath, "Packages", "manifest.json")

    // Read existing manifest
    let manifest: any = { dependencies: {} }
    try {
      manifest = JSON.parse(await Bun.file(manifestPath).text())
    } catch {}
    const installed = new Set(Object.keys(manifest.dependencies ?? {}))

    // Collect all namespaces used in C# scripts
    const usedNamespaces = new Set<string>()
    const scanDir = args.scriptsDir ?? path.join(assetsDir, "Scripts")
    await walkDir(scanDir, async (file) => {
      if (!file.endsWith(".cs")) return
      const content = await Bun.file(file).text().catch(() => "")
      for (const m of content.matchAll(/^using ([\w.]+);/gm)) {
        usedNamespaces.add(m[1].split(".")[0])  // root namespace prefix
        // Also add first two segments
        const parts = m[1].split(".")
        if (parts.length > 1) usedNamespaces.add(parts[0] + "." + parts[1])
      }
    })

    // Detect Unity official packages needed
    const unityToInstall: Array<{ pkg: string; version: string; reason: string }> = []
    for (const [ns, info] of Object.entries(UNITY_OFFICIAL_PACKAGES)) {
      const nsRoot = ns.split(".")[0]
      if ((usedNamespaces.has(nsRoot) || usedNamespaces.has(ns)) && !installed.has(info.pkg)) {
        unityToInstall.push({ ...info, reason: `namespace ${ns}` })
      }
    }

    // Detect third-party packages needed
    const thirdPartyNeeded: Array<{ name: string; url: string; reason: string }> = []
    for (const [ns, info] of Object.entries(THIRD_PARTY_PACKAGES)) {
      if (usedNamespaces.has(ns)) {
        thirdPartyNeeded.push({ ...info, reason: `namespace ${ns}` })
      }
    }

    // Write Unity official packages to manifest
    let addedCount = 0
    if (unityToInstall.length > 0) {
      for (const { pkg, version } of unityToInstall) {
        if (!manifest.dependencies) manifest.dependencies = {}
        manifest.dependencies[pkg] = version
        addedCount++
      }
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8")
    }

    const output = [
      addedCount > 0
        ? `✅ 已自动写入 ${addedCount} 个 Unity 官方包到 manifest.json（Editor 刷新后自动安装）:`
        : "（无需安装新的 Unity 官方包）",
      ...unityToInstall.map(p => `  + ${p.pkg}: ${p.version}  [${p.reason}]`),
      thirdPartyNeeded.length > 0 ? `\n⚠️  检测到 ${thirdPartyNeeded.length} 个第三方包，需要用户手动导入:` : "",
      ...thirdPartyNeeded.map(p => `  - ${p.name}\n      获取: ${p.url}  [${p.reason}]`),
    ].filter(Boolean).join("\n")

    return {
      output,
      metadata: {
        success: true,
        unityPackagesAdded: unityToInstall.map(p => p.pkg),
        thirdPartyRequired: thirdPartyNeeded.map(p => p.name),
        manifestPath,
      },
    }
  },
})

async function walkDir(dir: string, fn: (file: string) => Promise<void>) {
  let entries: string[]
  try { entries = await fs.readdir(dir) } catch { return }
  for (const entry of entries) {
    const full = path.join(dir, entry)
    try {
      const stat = await fs.stat(full)
      if (stat.isDirectory()) await walkDir(full, fn)
      else await fn(full)
    } catch {}
  }
}
```

**Step 2: Verify the file was created**

```bash
ls /Users/ggm/SelfProjects/PrivateOpenCode/opencode/.opencode/tool/unity-upm-detector.ts
```

**Step 3: Commit**

```bash
cd /Users/ggm/SelfProjects/PrivateOpenCode/opencode
git add .opencode/tool/unity-upm-detector.ts
git commit -m "feat(tool): unity-upm-detector scans namespaces to auto-install Unity packages and list third-party"
```

---

## Task 2: Create `unity-script-placeholder.ts` tool

**Files:**
- Create: `.opencode/tool/unity-script-placeholder.ts`

**Step 1: Write the tool**

This tool scans all `.unity` and `.prefab` files for MonoBehaviour script GUIDs. For each GUID that doesn't already have a corresponding `.cs` file, it generates a minimal placeholder `MonoBehaviour` with the **same GUID** in its `.meta` file. This ensures scenes/prefabs bind correctly without any logic.

```typescript
import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"

export default tool({
  description: "Scans Unity scene/prefab files for MonoBehaviour script GUIDs, generates minimal placeholder MonoBehaviour scripts with matching GUIDs. Eliminates Missing Script without adding any game logic.",

  args: {
    projectPath:      tool.schema.string().describe("Unity project path"),
    sourceExportPath: tool.schema.string().optional().describe("AssetRipper export path to resolve class names from meta files"),
    dumpCsPath:       tool.schema.string().optional().describe("dump.cs path to resolve class names from type definitions"),
    outputDir:        tool.schema.string().optional().describe("Output directory for placeholder scripts (default: Assets/Scripts/Placeholders)"),
    dryRun:           tool.schema.boolean().optional().describe("Preview only, don't write files"),
  },

  async execute(args) {
    const projectPath = path.resolve(args.projectPath)
    const assetsDir   = path.join(projectPath, "Assets")
    const outDir      = path.resolve(args.outputDir ?? path.join(assetsDir, "Scripts", "Placeholders"))

    // Step 1: Collect all script GUIDs referenced in scenes/prefabs
    const referencedGuids = new Map<string, string>()  // guid → fileID (for context)
    await walkDir(assetsDir, async (file) => {
      if (!file.endsWith(".unity") && !file.endsWith(".prefab")) return
      const content = await Bun.file(file).text().catch(() => "")
      for (const m of content.matchAll(/m_Script: \{fileID: (\d+), guid: ([a-f0-9]{32}), type: \d\}/g)) {
        const [, fileId, guid] = m
        if (guid !== "0".repeat(32)) referencedGuids.set(guid, fileId)
      }
    })

    // Step 2: Build GUID → className map from existing meta files
    const guidToClass = new Map<string, string>()

    // From existing project meta files
    await walkDir(assetsDir, async (file) => {
      if (!file.endsWith(".cs.meta")) return
      const content = await Bun.file(file).text().catch(() => "")
      const guidMatch = content.match(/^guid: ([a-f0-9]+)/m)
      if (!guidMatch) return
      const className = path.basename(file, ".cs.meta")
      guidToClass.set(guidMatch[1], className)
    })

    // From AssetRipper export meta files (if provided)
    if (args.sourceExportPath) {
      const exportScripts = path.join(args.sourceExportPath, "Assets", "Scripts")
      await walkDir(exportScripts, async (file) => {
        if (!file.endsWith(".cs.meta")) return
        const content = await Bun.file(file).text().catch(() => "")
        const guidMatch = content.match(/^guid: ([a-f0-9]+)/m)
        if (!guidMatch) return
        const className = path.basename(file, ".cs.meta")
        if (!guidToClass.has(guidMatch[1])) {
          guidToClass.set(guidMatch[1], className)
        }
      })
    }

    // Step 3: Determine which GUIDs need placeholders
    // (referenced in scenes/prefabs, no existing .cs with that GUID)
    const existingGuids = new Set<string>()
    await walkDir(assetsDir, async (file) => {
      if (!file.endsWith(".cs.meta")) return
      const content = await Bun.file(file).text().catch(() => "")
      const m = content.match(/^guid: ([a-f0-9]+)/m)
      if (m) existingGuids.add(m[1])
    })

    const toGenerate: Array<{ guid: string; className: string }> = []
    for (const [guid] of referencedGuids) {
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
          `[DRY RUN] 将生成 ${toGenerate.length} 个占位脚本:`,
          ...toGenerate.slice(0, 20).map(({ guid, className }) => `  + ${className}.cs  [guid: ${guid}]`),
          toGenerate.length > 20 ? `  ... 还有 ${toGenerate.length - 20} 个` : "",
        ].filter(Boolean).join("\n"),
        metadata: { success: true, wouldGenerate: toGenerate.length },
      }
    }

    // Step 4: Write placeholder files
    await fs.mkdir(outDir, { recursive: true })
    const written: string[] = []

    for (const { guid, className } of toGenerate) {
      const csContent = [
        "// AUTO-GENERATED PLACEHOLDER",
        "// This script is a temporary placeholder to prevent Missing Script errors.",
        "// Replace with real implementation in Phase 2 (unity-logic-rebuild).",
        "using UnityEngine;",
        "",
        $`public class ${className} : MonoBehaviour { }`,
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
        `   所有场景/Prefab 中的 MonoBehaviour 引用现在都有对应脚本（无 Missing Script）`,
        `   占位脚本仅包含空类定义，Phase 2 (unity-logic-rebuild) 会替换为真实实现`,
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

async function walkDir(dir: string, fn: (file: string) => Promise<void>) {
  let entries: string[]
  try { entries = await fs.readdir(dir) } catch { return }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue
    const full = path.join(dir, entry)
    try {
      const stat = await fs.stat(full)
      if (stat.isDirectory()) await walkDir(full, fn)
      else await fn(full)
    } catch {}
  }
}
```

Note: Fix the template literal syntax `$\`` → plain backtick in implementation.

**Step 2: Verify**

```bash
ls /Users/ggm/SelfProjects/PrivateOpenCode/opencode/.opencode/tool/unity-script-placeholder.ts
```

**Step 3: Commit**

```bash
cd /Users/ggm/SelfProjects/PrivateOpenCode/opencode
git add .opencode/tool/unity-script-placeholder.ts
git commit -m "feat(tool): unity-script-placeholder generates empty MonoBehaviour stubs matching scene GUID refs"
```

---

## Task 3: Create `unity-asset-restore.md` agent

**Files:**
- Create: `.opencode/agent/unity-asset-restore.md`

**Step 1: Write the agent**

Full agent definition implementing the 6-stage asset restore flow from the design doc. Key points:
- Frontmatter: `mode: primary`, `color: "#0EA5E9"` (blue), `temperature: 0.2`
- Stage 1: unpack + AssetRipper export via `@unity-workflow-manager`
- Stage 2: asset integrity check via `unity-asset-assess`
- Stage 3: UPM package detection via `unity-upm-detector`, block for third-party confirmation
- Stage 4: shader fix via `unity-shader-fix`
- Stage 5: placeholder scripts via `unity-script-placeholder`, compile check
- Stage 6: `unity-play-smoke` acceptance

State file: `.asset_restore_state.json`

Critical boundary: **no game logic code enters the project**. The agent must refuse to add any business logic, DLLs (except Unity official packages), or framework source code.

**Step 2: Verify stage headings**

```bash
grep "^## Stage" /Users/ggm/SelfProjects/PrivateOpenCode/opencode/.opencode/agent/unity-asset-restore.md
```

Expected: Stage 0 through Stage 6.

**Step 3: Commit**

```bash
cd /Users/ggm/SelfProjects/PrivateOpenCode/opencode
git add .opencode/agent/unity-asset-restore.md
git commit -m "feat(agent): unity-asset-restore — Phase 1 asset layer with UPM detection and placeholder scripts"
```

---

## Task 4: Create `unity-logic-rebuild.md` agent

**Files:**
- Create: `.opencode/agent/unity-logic-rebuild.md`

**Step 1: Write the agent**

Full agent definition implementing the 5-stage logic rebuild flow from the design doc. Key points:
- Frontmatter: `mode: primary`, `color: "#8B5CF6"` (purple), `temperature: 0.25`
- Prerequisite check: reads `.asset_restore_state.json`, verifies stage6 complete
- Stage 1: logic analysis — class dependency graph, pure vs presentation logic classification, output `logic_analysis.md`
- Stage 2: framework layer — copy AssetRipper C# source (Crescive/Loom), call `unity-dump-framework-gen`, compile check
- Stage 3: game logic implementation — topological order, exact dump.cs override signatures, incremental compile every 10 classes
- Stage 4: GUID redirect — update placeholder `.meta` files to point to real implementations
- Stage 5: compile + play acceptance

State file: `.logic_rebuild_state.json`

Critical boundaries:
- **Only depends on dump.cs and AssetRipper export** — no other project sources
- **Override signatures must match dump.cs exactly** — return types, parameter types
- **GUID redirect** replaces placeholder binding without touching scene/prefab YAML

**Step 2: Verify stage headings**

```bash
grep "^## Stage" /Users/ggm/SelfProjects/PrivateOpenCode/opencode/.opencode/agent/unity-logic-rebuild.md
```

Expected: Stage 0 (prerequisite check) through Stage 5.

**Step 3: Commit**

```bash
cd /Users/ggm/SelfProjects/PrivateOpenCode/opencode
git add .opencode/agent/unity-logic-rebuild.md
git commit -m "feat(agent): unity-logic-rebuild — Phase 2 logic layer with dump.cs analysis and GUID redirect"
```

---

## Task 5: Deprecate old agents

**Files:**
- Modify: `.opencode/agent/unity-game-reverse.md`
- Modify: `.opencode/agent/unity-game-reverse-visual.md`

**Step 1: Add deprecation notice to both files**

At the very top of each file (before frontmatter `---`), or as the first line of the body, add:

```markdown
> ⚠️ **DEPRECATED** — Replaced by `@unity-asset-restore` (Phase 1) + `@unity-logic-rebuild` (Phase 2).
> These agents mixed asset, logic, and DLL concerns in one flow and produced incorrect results.
> See `docs/plans/2026-06-15-unity-agent-redesign.md` for the new architecture.
```

**Step 2: Commit**

```bash
cd /Users/ggm/SelfProjects/PrivateOpenCode/opencode
git add .opencode/agent/unity-game-reverse.md .opencode/agent/unity-game-reverse-visual.md
git commit -m "deprecate(agent): unity-game-reverse and unity-game-reverse-visual replaced by asset-restore + logic-rebuild"
```

---

## Task 6: Verify all files exist and are well-formed

**Step 1: Check all new files**

```bash
ls /Users/ggm/SelfProjects/PrivateOpenCode/opencode/.opencode/tool/unity-upm-detector.ts
ls /Users/ggm/SelfProjects/PrivateOpenCode/opencode/.opencode/tool/unity-script-placeholder.ts
ls /Users/ggm/SelfProjects/PrivateOpenCode/opencode/.opencode/agent/unity-asset-restore.md
ls /Users/ggm/SelfProjects/PrivateOpenCode/opencode/.opencode/agent/unity-logic-rebuild.md
```

**Step 2: Check agent frontmatter**

```bash
head -15 /Users/ggm/SelfProjects/PrivateOpenCode/opencode/.opencode/agent/unity-asset-restore.md
head -15 /Users/ggm/SelfProjects/PrivateOpenCode/opencode/.opencode/agent/unity-logic-rebuild.md
```

Expected: valid YAML frontmatter with `mode: primary`.

**Step 3: Check stage headings in asset-restore**

```bash
grep "^## Stage" /Users/ggm/SelfProjects/PrivateOpenCode/opencode/.opencode/agent/unity-asset-restore.md
```

Expected stages: 0, 1, 2, 3, 4, 5, 6

**Step 4: Check stage headings in logic-rebuild**

```bash
grep "^## Stage" /Users/ggm/SelfProjects/PrivateOpenCode/opencode/.opencode/agent/unity-logic-rebuild.md
```

Expected stages: 0, 1, 2, 3, 4, 5

**Step 5: Check deprecation notices**

```bash
grep "DEPRECATED" /Users/ggm/SelfProjects/PrivateOpenCode/opencode/.opencode/agent/unity-game-reverse.md
grep "DEPRECATED" /Users/ggm/SelfProjects/PrivateOpenCode/opencode/.opencode/agent/unity-game-reverse-visual.md
```

**Step 6: Final commit**

```bash
cd /Users/ggm/SelfProjects/PrivateOpenCode/opencode
git add .
git commit -m "chore(agent): verify unity agent redesign — all files present and well-formed" --allow-empty
```

---

## Summary

| Task | Files | Action |
|------|-------|--------|
| 1 | `unity-upm-detector.ts` | New tool: detect Unity official vs third-party packages |
| 2 | `unity-script-placeholder.ts` | New tool: generate empty MonoBehaviour stubs from scene GUIDs |
| 3 | `unity-asset-restore.md` | New primary agent: Phase 1 asset layer |
| 4 | `unity-logic-rebuild.md` | New primary agent: Phase 2 logic layer |
| 5 | Old agent files | Deprecation notices |
| 6 | All files | Verification |
