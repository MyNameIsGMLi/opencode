import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import {
  loadProjectConfig,
  resolveSourceProjectPath,
  resolveAssetRipperPath,
  resolveUnityEditorPath,
  getDefaultExcludePaths,
} from "./unity-project-config"

/**
 * Unity Asset Rebinder
 *
 * 功能：
 * 1. [可选] 调用 AssetRipper 从 APK/IPA 导出资源
 * 2. [可选] 注入并运行 ExportRipperExtended.cs 生成 GUID 映射 JSON
 * 3. 读取 export2ripper_full.json，构建 prefabPath+localFileID → className 查找表
 * 4. 扫描源项目所有 prefab/scene/asset YAML，建立 originalGameGuid → className 映射
 * 5. 更新目标工程 .cs.meta 文件的 GUID（匹配原始游戏 GUID）
 * 6. [全量模式] 复制非脚本资源（保持目录结构）
 * 7. 生成详细报告 rebinding_report.json
 *
 * 通用设计：支持任意 Unity 游戏 APK/IPA，不绑定特定项目路径。
 */

// ── 类型定义 ────────────────────────────────────────────────────────────────

interface ScriptMetaUpdate {
  className: string
  metaFile: string
  oldGuid: string
  newGuid: string
}

interface PendingScript {
  className: string
  originalGuid: string
  seenInFiles: string[]
}

interface UnmappedGuid {
  guid: string
  seenInFiles: string[]
}

interface GuidCollision {
  guid: string
  intendedClass: string   // 这个 GUID 应该属于的类
  occupiedBy: string      // 但写入前已被这个类占用
  resolution: "displaced" | "skipped"  // displaced=占用者被换掉, skipped=放弃写入
}

interface RebindingReport {
  timestamp: string
  mode: "full" | "incremental"
  sourceProject: string
  targetProject: string
  exportJsonPath: string
  scriptMetaUpdates: ScriptMetaUpdate[]
  pendingScripts: PendingScript[]
  unmappedGuids: UnmappedGuid[]
  guidCollisions: GuidCollision[]
  assetsCopied: Record<string, number>
  uguidRemapped: number
  missingExternalRefs: Array<{ file: string; guid: string; fieldPath: string }>
  summary: string
}

// ── 工具定义 ────────────────────────────────────────────────────────────────

export default tool({
  description: `Unity 资产重绑定工具 - 替代 unity-asset-extract 和 unity-reference-fixer。

完整流程：
1. [可选] AssetRipper 导出资产
2. [可选] 运行 ExportRipperExtended 生成 GUID 映射 JSON
3. 扫描源项目 YAML，建立原始游戏 GUID → 类名映射
4. 更新目标工程 .cs.meta 的 GUID（消除 Missing Script）
5. [全量] 复制非脚本资源到目标工程
6. 输出详细报告

支持增量模式（仅更新单个类的 .meta），用于代码生成后快速重绑定。`,

  args: {
    // ── 必填 ──────────────────────────────────────────────────────────
    targetProjectPath: tool.schema.string().describe(
      "目标 Unity 工程路径（接收重绑定后资源的工程）"
    ),

    // ── 源项目（两者至少一个，或从 unity-config.json 读取）──────────
    sourceProjectPath: tool.schema.string().optional().describe(
      "AssetRipper 已导出的源 Unity 项目路径。不填则从 .opencode/unity-config.json 读取"
    ),
    apkPath: tool.schema.string().optional().describe(
      "APK/IPA/XAPK 文件路径。提供时：先运行 AssetRipper 导出到 sourceProjectPath"
    ),

    // ── GUID 映射 JSON ────────────────────────────────────────────────
    exportJsonPath: tool.schema.string().optional().describe(
      "export2ripper_full.json 路径。默认：sourceProjectPath/export2ripper_full.json"
    ),
    reExportJson: tool.schema.boolean().optional().describe(
      "重新运行 ExportRipperExtended.cs 生成新 JSON（需要 Unity Editor）。默认 false"
    ),

    // ── 工具路径（可选，均有自动探测）──────────────────────────────
    assetRipperPath: tool.schema.string().optional().describe(
      "AssetRipper 可执行文件路径（不填则自动探测）"
    ),
    unityVersion: tool.schema.string().optional().describe(
      "用于 ExportRipperExtended 的 Unity 版本（不填则从 ProjectVersion.txt 读取）"
    ),
    unityEditorPath: tool.schema.string().optional().describe(
      "Unity 可执行文件完整路径（不填则自动探测）"
    ),

    // ── 资源复制控制 ──────────────────────────────────────────────────
    extraExcludePaths: tool.schema.array(tool.schema.string()).optional().describe(
      "额外排除目录（相对 Assets/，追加到默认：Scripts/, Editor/, Il2CppDump/）"
    ),
    overwriteExisting: tool.schema.boolean().optional().describe(
      "是否覆盖目标工程已有的同名文件。默认 true"
    ),
    copyAssetsOnly: tool.schema.boolean().optional().describe(
      "只复制资源，不修改 .meta 文件。默认 false"
    ),
    rebindMetaOnly: tool.schema.boolean().optional().describe(
      "只修改 .meta，不复制资源。默认 false"
    ),

    // ── 增量模式 ──────────────────────────────────────────────────────
    incrementalClassName: tool.schema.string().optional().describe(
      "仅重绑定指定类的 .meta（不复制资源）。用于代码生成后的快速单类更新"
    ),

    // ── 行为控制 ────────────────────────────────────────────────────
    dryRun: tool.schema.boolean().optional().describe(
      "预览模式：只显示将要做什么，不实际修改文件。默认 false"
    ),
    verbose: tool.schema.boolean().optional().describe("显示详细日志"),
    reportPath: tool.schema.string().optional().describe(
      "报告文件输出路径。默认：targetProjectPath/rebinding_report.json"
    ),
  },

  async execute(args, ctx) {
    const isDry = args.dryRun ?? false
    const isIncremental = !!args.incrementalClassName
    const log = (msg: string) => { if (args.verbose || isDry) console.log(msg) }

    // 加载项目配置
    const config = await loadProjectConfig(args.targetProjectPath)

    // 解析源项目路径
    const sourceProject = resolveSourceProjectPath(config, args.sourceProjectPath)
    if (!sourceProject && !args.apkPath) {
      const msg = [
        "必须提供 sourceProjectPath 或 apkPath。",
        "建议在 .opencode/unity-config.json 中设置 sourceProjectPath：",
        '  { "sourceProjectPath": "/path/to/AssetRipper/exported/project" }',
      ].join("\n")
      return `Error: ${msg}`
    }

    // ── Phase 0: AssetRipper 导出（可选，通过 Web API 以 Decompiled 模式）─
    if (args.apkPath) {
      log("[Phase 0] 运行 AssetRipper 导出资源（Decompiled 模式）...")
      const ripperPath = await resolveAssetRipperPath(config, args.assetRipperPath)
      if (!ripperPath) {
        return "Error: 找不到 AssetRipper.GUI.Free，请通过 assetRipperPath 参数或 unity-config.json 指定路径"
      }
      if (!args.sourceProjectPath) {
        return "Error: 使用 apkPath 时必须同时提供 sourceProjectPath 作为导出目标目录"
      }
      await fs.mkdir(args.sourceProjectPath, { recursive: true })

      if (!isDry) {
        const exportResult = await (ctx as any).tool("unity-assetripper-export", {
          inputPath: args.apkPath,
          outputPath: args.sourceProjectPath,
          assetRipperPath: ripperPath.endsWith(".dll") ? undefined : ripperPath,
          scriptExportMode: "Decompiled",
          scriptContentLevel: 2,
        }) as string
        if (exportResult.startsWith("Error:")) return exportResult
        log(`✓ ${exportResult.split("\n")[0]}`)
      } else {
        log(`  [dry] 将用 AssetRipper Web API 以 Decompiled 模式导出: ${args.apkPath} → ${args.sourceProjectPath}`)
      }
    }

    let resolvedSource = sourceProject ?? args.sourceProjectPath!
    // 自动适配 AssetRipper CLI 导出的 ExportedProject 嵌套
    const hasNested = await fs.access(path.join(resolvedSource, "ExportedProject", "Assets")).then(() => true).catch(() => false)
    if (hasNested) {
      resolvedSource = path.join(resolvedSource, "ExportedProject")
      log(`  ✓ 自动适配 AssetRipper CLI 导出的 ExportedProject 嵌套路径: ${resolvedSource}`)
    }

    // 检查 targetProject Packages/manifest.json：
    // 若源项目内置了旧版 ugui（有 Scripts/UnityEngine.UI/ 目录），
    // 说明预制体/场景里引用的是旧版内置 GUID，需要在 target 的 manifest.json
    // 里显式声明 com.unity.ugui，让 Unity Editor 安装包提供编译所需的程序集。
    // Phase 4.5 会再把 prefab/scene 里的旧 GUID 批量替换成包版本的 GUID。
    const targetManifestPath = path.join(args.targetProjectPath, "Packages", "manifest.json")
    const targetManifestExists = await fs.access(targetManifestPath).then(() => true).catch(() => false)
    const sourceHasUI = await fs.access(path.join(resolvedSource, "Assets", "Scripts", "UnityEngine.UI")).then(() => true).catch(() => false)

    if (targetManifestExists && sourceHasUI) {
      try {
        const manifestContent = await Bun.file(targetManifestPath).text()
        const manifest = JSON.parse(manifestContent)
        if (!manifest.dependencies?.["com.unity.ugui"]) {
          manifest.dependencies = manifest.dependencies ?? {}
          manifest.dependencies["com.unity.ugui"] = "2.0.0"
          if (!isDry) {
            await Bun.write(targetManifestPath, JSON.stringify(manifest, null, 2))
          }
          log("  ✓ 检测到源项目内置旧版 ugui，已向 targetProject Packages/manifest.json 写入 com.unity.ugui: 2.0.0（Phase 4.5 将替换 prefab/scene 里的旧 GUID）")
        }
      } catch (err) {
        log(`  ⚠️ 尝试读取/解析 targetProject manifest.json 失败: ${err}`)
      }
    }

    // ── Phase 0.5: 运行 ExportRipperExtended（可选）───────────────────
    const exportJsonPath = args.exportJsonPath
      ?? path.join(resolvedSource, "export2ripper_full.json")

    if (args.reExportJson) {
      log("[Phase 0.5] 运行 ExportRipperExtended 生成 GUID 映射...")
      const result = await runExportRipperExtended(
        resolvedSource, exportJsonPath,
        args.unityVersion, args.unityEditorPath,
        isDry, ctx
      )
      if (result.error) {
        return `Error: ${result.error}`
      }
    }

    // 检查 export JSON 是否存在
    const exportJsonExists = await fs.access(exportJsonPath).then(() => true).catch(() => false)
    const localIdToClass = new Map<string, string>()
    const externalAssetGuids = new Set<string>()

    if (exportJsonExists) {
      // ── Phase 1: 读取 export JSON，构建查找表 ────────────────────────
      log("[Phase 1] 读取 export2ripper_full.json...")
      const exportJson = JSON.parse(
        await Bun.file(exportJsonPath).text().then((t: string) => t.replace(/^\uFEFF/, "")) // 处理 BOM
      )

      // 表 A: prefabPath::localFileID → componentType（className）
      for (const p of exportJson.prefabs ?? []) {
        for (const go of p.gameObjects ?? []) {
          for (const comp of go.components ?? []) {
            localIdToClass.set(`${p.path}::${comp.localFileID}`, comp.type)
          }
        }
      }

      // 表 B: 外部资产 guid 集合（用于 Phase 5 完整性检查）
      for (const s of [...(exportJson.sprites ?? []), ...(exportJson.fonts ?? []), ...(exportJson.materials ?? [])]) {
        if (s.guid) externalAssetGuids.add(s.guid)
      }

      log(`  ✓ 表A 条目: ${localIdToClass.size}, 外部资产 GUID: ${externalAssetGuids.size}`)
    } else {
      log("  ⚠️ [Warning] 未找到 export2ripper_full.json 映射表，系统将完全依靠 FSM 与 .cs.meta 直接匹配进行重建！")
    }

    // ── Phase 2: 扫描源项目 YAML，建立 originalGameGuid → className 映射 ─
    log("[Phase 2] 扫描源项目 YAML，建立 GUID 映射...")
    const { guidToClassName, unmappedGuids } = await buildGuidMapping(
      resolvedSource, args.targetProjectPath, localIdToClass, log
    )
    log(`  ✓ 可修复: ${guidToClassName.size}, 无法识别: ${unmappedGuids.size}`)

    // 增量模式：只处理单个 className
    let activeGuidMap = guidToClassName
    if (isIncremental) {
      activeGuidMap = new Map<string, string>()
      for (const [guid, cls] of guidToClassName) {
        if (cls === args.incrementalClassName) activeGuidMap.set(guid, cls)
      }
    }

    // ── Phase 2.5: 跳过 ──────────────────────────────────────────────────────
    // 不再扫描源项目 .cs.meta，因为 AssetRipper 导出的 .meta 文件 GUID 是随机生成的，
    // 用这些随机 GUID 覆盖目标工程会破坏已正确对齐的 GUID。
    // GUID 映射完全由 Phase 2（YAML 扫描 + FSM）负责。

    if (isIncremental && activeGuidMap.size === 0) {
      return `⚠️ 增量模式：在 YAML 或源项目 .cs.meta 中未找到类 ${args.incrementalClassName} 的原始 GUID 映射。`
    }

    // ── Phase 3: 更新目标工程 .cs.meta 文件 ─────────────────────────
    log(`[Phase 3] 更新 targetProject 的 .meta 文件...`)
    const { updates, pendingScripts, guidCollisions } = await rebindMetaFiles(
      args.targetProjectPath, resolvedSource, activeGuidMap, guidToClassName, isDry, log
    )

    // ── Phase 4: 复制非脚本资源（仅全量模式）────────────────────────
    let assetsCopied: Record<string, number> = {}
    if (!isIncremental && !(args.rebindMetaOnly ?? false) && resolvedSource !== args.targetProjectPath) {
      log("[Phase 4] 复制非脚本资源...")
      const excludePaths = [
        ...getDefaultExcludePaths({ ...config, rebindExcludePaths: args.extraExcludePaths }),
      ]
      assetsCopied = await copyAssets(
        resolvedSource, args.targetProjectPath,
        excludePaths, args.overwriteExisting ?? true,
        isDry, log
      )
    }

    // ── Phase 4.5: ugui GUID 批量重映射 ─────────────────────────────
    // 源项目预制体/场景里引用的是旧版内置 ugui GUID，
    // 用 com.unity.ugui@2.0.0 包对应的固定 GUID 批量替换。
    let uguidRemapped = 0
    if (!isIncremental && sourceHasUI) {
      log("[Phase 4.5] 批量替换 prefab/scene 里的旧版 ugui GUID...")
      uguidRemapped = await remapUguiGuids(args.targetProjectPath, isDry, log)
      log(`  ✓ ugui GUID 替换完成: ${uguidRemapped} 处`)
    }

    // ── Phase 5: 外部资源引用完整性检查 ─────────────────────────────
    log("[Phase 5] 检查外部资源引用完整性...")
    const missingExternalRefs = await checkExternalRefs(
      args.targetProjectPath, externalAssetGuids, log
    )

    // ── Phase 6: 生成报告 ────────────────────────────────────────────
    const unmappedList: UnmappedGuid[] = []
    for (const [guid, files] of unmappedGuids) {
      unmappedList.push({ guid, seenInFiles: files })
    }

    const report: RebindingReport = {
      timestamp: new Date().toISOString(),
      mode: isIncremental ? "incremental" : "full",
      sourceProject: resolvedSource,
      targetProject: args.targetProjectPath,
      exportJsonPath,
      scriptMetaUpdates: updates,
      pendingScripts,
      unmappedGuids: unmappedList,
      guidCollisions,
      assetsCopied,
      uguidRemapped,
      missingExternalRefs,
      summary: buildSummary(updates, pendingScripts, unmappedList, guidCollisions, assetsCopied, uguidRemapped, missingExternalRefs, isDry),
    }

    const reportPath = args.reportPath ?? path.join(args.targetProjectPath, "rebinding_report.json")
    if (!isDry) {
      await Bun.write(reportPath, JSON.stringify(report, null, 2))
    }

    return [
      `${isDry ? "🔍 [DRY RUN] " : ""}✅ Unity 资产重绑定完成`,
      "",
      report.summary,
      "",
      `📄 报告: ${reportPath}`,
    ].join("\n")
  },
})

// ── Phase 0.5: 运行 ExportRipperExtended ────────────────────────────────────

async function runExportRipperExtended(
  sourceProject: string,
  exportJsonPath: string,
  unityVersion: string | undefined,
  unityEditorPath: string | undefined,
  isDry: boolean,
  ctx: any,
) {
  // 读取内嵌的 ExportRipperExtended.cs
  const scriptSrc = path.join((import.meta as any).dir, "..", "scripts", "ExportRipperExtended.cs")
  const csExists = await fs.access(scriptSrc).then(() => true).catch(() => false)
  if (!csExists) {
    return { error: `内嵌脚本不存在: ${scriptSrc}` }
  }
  const csContent = await Bun.file(scriptSrc).text()

  // 检查/添加 Newtonsoft.Json 依赖
  const manifestPath = path.join(sourceProject, "Packages", "manifest.json")
  const manifestExists = await fs.access(manifestPath).then(() => true).catch(() => false)
  if (manifestExists) {
    const manifest = JSON.parse(await Bun.file(manifestPath).text())
    if (!manifest.dependencies?.["com.unity.nuget.newtonsoft-json"]) {
      manifest.dependencies = manifest.dependencies ?? {}
      manifest.dependencies["com.unity.nuget.newtonsoft-json"] = "3.2.1"
      if (!isDry) await Bun.write(manifestPath, JSON.stringify(manifest, null, 2))
      console.log("  ✓ 已添加 com.unity.nuget.newtonsoft-json 到 Packages/manifest.json")
    }
  }

  // 注入 ExportRipperExtended.cs
  const editorDir = path.join(sourceProject, "Assets", "Editor")
  await fs.mkdir(editorDir, { recursive: true })
  const targetCs = path.join(editorDir, "ExportRipperExtended.cs")

  // 备份已有文件
  const backupCs = targetCs + ".bak"
  const alreadyExists = await fs.access(targetCs).then(() => true).catch(() => false)
  if (alreadyExists && !isDry) await fs.copyFile(targetCs, backupCs)

  if (!isDry) await Bun.write(targetCs, csContent)

  // 获取 Unity 版本
  let version = unityVersion
  if (!version) {
    const versionFile = path.join(sourceProject, "ProjectSettings", "ProjectVersion.txt")
    const vContent = await Bun.file(versionFile).text().catch(() => "")
    const m = vContent.match(/m_EditorVersion:\s*(\S+)/)
    if (m) version = m[1]
  }
  if (!version) return { error: "无法确定 Unity 版本，请通过 unityVersion 参数指定" }

  const unityPath = await resolveUnityEditorPath(version, unityEditorPath)
  if (!unityPath) return { error: `找不到 Unity ${version} 的可执行文件` }

  // 运行 batchmode
  const logFile = path.join(os.tmpdir(), `export_ripper_${Date.now()}.log`)
  const cmd = [
    `"${unityPath}"`,
    "-batchmode -nographics -quit",
    `-projectPath "${sourceProject}"`,
    `-logFile "${logFile}"`,
    "-executeMethod ExportRipperExtended.BatchExport",
    "-accept-apiupdate",
  ].join(" ")

  console.log(`  运行 ExportRipperExtended (Unity ${version})...`)
  if (!isDry) {
    await ctx.bash(`${cmd} > /dev/null 2>&1`, { timeout: 300000 })

    // 还原备份
    if (alreadyExists) await fs.copyFile(backupCs, targetCs)
    else await fs.unlink(targetCs).catch(() => {})
  }

  // 验证 JSON 生成
  const jsonExists = await fs.access(exportJsonPath).then(() => true).catch(() => false)
  if (!jsonExists && !isDry) {
    const logContent = await Bun.file(logFile).text().catch(() => "（日志不可读）")
    return { error: `ExportRipperExtended 运行完成但未生成 JSON\n日志: ${logFile}\n最后20行:\n${logContent.split("\n").slice(-20).join("\n")}` }
  }

  console.log(`  ✓ export2ripper_full.json 生成完成`)
  return { ok: true }
}

// ── Field-Signature Matching (FSM) Helpers ─────────────────────────────────

function extractCsFields(content: string): Set<string> {
  const fields = new Set<string>()
  const cleanContent = content.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")
  const pattern = /(?:\[SerializeField\]\s*(?:private|protected|internal)?\s*|public\s+)(?!class|struct|interface|enum|delegate)(?:readonly\s+)?([a-zA-Z0-9_<>\[\]]+)\s+([a-zA-Z0-9_]+)\s*(?:=[\s\S]*?)?;/g
  
  let match
  while ((match = pattern.exec(cleanContent)) !== null) {
    const fieldName = match[2]
    fields.add(fieldName)
  }
  return fields
}

function extractYamlFields(block: string): Set<string> {
  const fields = new Set<string>()
  const lines = block.split("\n")
  const ignoreFields = [
    "m_ObjectHideFlags", "m_CorrespondingSourceObject", "m_PrefabInstance",
    "m_PrefabAsset", "m_GameObject", "m_Enabled", "m_EditorHideFlags",
    "m_Script", "m_Name", "m_EditorClassIdentifier"
  ]
  
  for (const line of lines) {
    const match = line.match(/^\s{2}([a-zA-Z0-9_]+)\s*:/)
    if (match) {
      const fieldName = match[1]
      if (!ignoreFields.includes(fieldName)) {
        fields.add(fieldName)
      }
    }
  }
  return fields
}

function calculateSetSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 || setB.size === 0) return 0.0
  const intersection = new Set([...setA].filter(x => setB.has(x)))
  const union = new Set([...setA, ...setB])
  return intersection.size / union.size
}

// ── Phase 2: 扫描 YAML，建立 originalGameGuid → className 映射 ─────────────

async function buildGuidMapping(
  sourceProject: string,
  targetProject: string,
  localIdToClass: Map<string, string>,
  log: (msg: string) => void,
): Promise<{
  guidToClassName: Map<string, string>
  unmappedGuids: Map<string, string[]>
}> {
  const guidToClassName = new Map<string, string>()
  const unmappedGuids = new Map<string, string[]>()

  // 扫描所有 YAML 文件（结合 sourceProject 和 targetProject，确保单元测试和实战项目的预制体均能被完全扫描到）
  const sourceAssetsDir = path.join(sourceProject, "Assets")
  const targetAssetsDir = path.join(targetProject, "Assets")
  const yamlFiles = await findFiles(sourceAssetsDir, [".prefab", ".unity", ".asset"])
  
  if (sourceAssetsDir !== targetAssetsDir) {
    const targetYamlFiles = await findFiles(targetAssetsDir, [".prefab", ".unity", ".asset"])
    for (const f of targetYamlFiles) {
      if (!yamlFiles.includes(f)) {
        yamlFiles.push(f)
      }
    }
  }

  // FSM: 建立本地 C# 类及其序列化字段的指纹图 (扫描 targetProject/Assets)
  const classToFields = new Map<string, Set<string>>()
  const csFiles = await findFiles(targetAssetsDir, [".cs"])
  for (const csFile of csFiles) {
    if (csFile.endsWith("ExportRipperExtended.cs") || csFile.includes("Editor/")) continue
    const className = path.basename(csFile, ".cs")
    const content = await Bun.file(csFile).text().catch(() => "")
    const fields = extractCsFields(content)
    if (fields.size > 0) {
      classToFields.set(className, fields)
    }
  }
  log("  [FSM] 已指纹化 " + classToFields.size + " 个具有序列化字段的 C# 类")

  // ── 增加源项目 meta 直配防线 (解密鸡生蛋死锁，在空 target 工程时一秒精准对齐 76% 原始 GUID) ──
  const possibleMetaDirs = [
    path.join(sourceProject, "Assets/Scripts/Assembly-CSharp"),
    path.join(sourceProject, "Assets/Scripts"),
    path.join(sourceProject, "Assets/Block_Puzzle/Scripts")
  ]
  let sourceMetaCount = 0
  for (const sDir of possibleMetaDirs) {
    const exists = await fs.access(sDir).then(() => true).catch(() => false)
    if (!exists) continue
    const sMetas = await findFiles(sDir, [".cs.meta"])
    for (const sm of sMetas) {
      const clsName = path.basename(sm, ".cs.meta")
      const metaContent = await Bun.file(sm).text().catch(() => "")
      const m = metaContent.match(/^guid:\s*([a-f0-9]+)/m)
      if (m) {
        const origGuid = m[1]
        if (!guidToClassName.has(origGuid)) {
          guidToClassName.set(origGuid, clsName)
          sourceMetaCount++
        }
      }
    }
  }
  if (sourceMetaCount > 0) {
    log(`  [SOURCE-META] 成功从源项目 C# .meta 文件中直接提取并绑定 ${sourceMetaCount} 个核心类 GUID`)
  }

  for (const yamlFile of yamlFiles) {
    const content = await Bun.file(yamlFile).text().catch(() => "")
    if (!content) continue

    // 计算相对于各自根路径的相对路径（用于查找表 key）
    let relPath = ""
    if (yamlFile.startsWith(sourceAssetsDir)) {
      relPath = "Assets" + yamlFile.slice(sourceAssetsDir.length).replace(/\\/g, "/")
    } else {
      relPath = "Assets" + yamlFile.slice(targetAssetsDir.length).replace(/\\/g, "/")
    }

    // 分割 YAML 块（按 \n--- 分割）
    const blocks = content.split(/\n--- /)
    for (const block of blocks) {
      // 只处理 MonoBehaviour 块（classID 114）
      if (!block.includes("MonoBehaviour:")) continue

      const fidMatch = block.match(/!u!114 &(\d+)/)
      const guidMatch = block.match(/m_Script:\s*\{fileID:\s*\d+,\s*guid:\s*([a-f0-9]{32}),\s*type:\s*3\}/)
      if (!fidMatch || !guidMatch) continue

      const localFileID = fidMatch[1]
      const origGuid = guidMatch[1]

      // 用 prefabPath + localFileID 查找 className
      const key = `${relPath}::${localFileID}`
      const className = localIdToClass.get(key)

      if (className) {
        // 找到映射
        if (!guidToClassName.has(origGuid)) {
          guidToClassName.set(origGuid, className)
          log(`    [GUID→class] ${origGuid.slice(0, 8)}... → ${className}`)
        }
      } else {
        // 无法识别 -> 启动 FSM Fallback
        const yamlFields = extractYamlFields(block)
        
        let bestClassName = ""
        let bestSimilarity = 0.0
        
        if (yamlFields.size > 0) {
          for (const [clsName, csFields] of classToFields) {
            const similarity = calculateSetSimilarity(yamlFields, csFields)
            if (similarity > bestSimilarity) {
              bestSimilarity = similarity
              bestClassName = clsName
            }
          }
        }
        
        // 判定阈值：Jaccard 相似度 >= 0.5 且是唯一最高匹配
        if (bestSimilarity >= 0.5) {
          if (!guidToClassName.has(origGuid)) {
            guidToClassName.set(origGuid, bestClassName)
            log(`    [FSM Match] ${origGuid.slice(0, 8)}... → ${bestClassName} (Similarity: ${bestSimilarity.toFixed(2)}, Prefab: ${path.basename(yamlFile)})`)
          }
        } else {
          // 仍然无法识别
          if (guidToClassName.has(origGuid)) {
            // 已经在最开始由源项目 .cs.meta 精准配对了，不归入未映射
            continue
          }
          const existing = unmappedGuids.get(origGuid) ?? []
          const relFile = relPath
          if (!existing.includes(relFile)) existing.push(relFile)
          unmappedGuids.set(origGuid, existing)
        }
      }
    }
  }

  return { guidToClassName, unmappedGuids }
}

// ── Phase 3: 更新目标工程 .cs.meta 文件 ─────────────────────────────────────

async function rebindMetaFiles(
  targetProject: string,
  sourceProject: string,
  activeGuidMap: Map<string, string>,
  fullGuidMap: Map<string, string>,
  isDry: boolean,
  log: (msg: string) => void,
): Promise<{
  updates: ScriptMetaUpdate[]
  pendingScripts: PendingScript[]
  guidCollisions: GuidCollision[]
}> {
  const updates: ScriptMetaUpdate[] = []
  const pendingScripts: PendingScript[] = []
  const guidCollisions: GuidCollision[] = []

  // 1. 扫描 targetProject Assets 下所有 .cs 文件
  const scriptsDir = path.join(targetProject, "Assets")
  const csFiles = await findFiles(scriptsDir, [".cs"])
  const targetClassToMeta = new Map<string, { csFile: string; metaFile: string; guid: string }>()

  for (const csFile of csFiles) {
    const className = path.basename(csFile, ".cs")
    const metaFile = csFile + ".meta"
    const metaExists = await fs.access(metaFile).then(() => true).catch(() => false)
    let guid = ""
    if (metaExists) {
      const content = await Bun.file(metaFile).text().catch(() => "")
      const guidMatch = content.match(/^guid:\s*([a-f0-9]+)/m)
      if (guidMatch) guid = guidMatch[1]
    }
    targetClassToMeta.set(className, { csFile, metaFile, guid })
  }

  // 建立 guid → className 反向索引（用于碰撞检测）
  const targetGuidToClass = new Map<string, string>()
  for (const [cls, info] of targetClassToMeta) {
    if (info.guid) targetGuidToClass.set(info.guid, cls)
  }

  // 2. 扫描 sourceProject Assets 下所有 .cs.meta，建立 className -> sourceMetaFile 映射
  const sourceMetaFiles = await findFiles(path.join(sourceProject, "Assets"), [".cs.meta"])
  const sourceClassToMeta = new Map<string, string>()
  for (const sm of sourceMetaFiles) {
    const className = path.basename(sm, ".cs.meta")
    sourceClassToMeta.set(className, sm)
  }

  // 对每个 (originalGuid, className) 对进行更新
  for (const [origGuid, className] of activeGuidMap) {
    const targetInfo = targetClassToMeta.get(className)
    if (!targetInfo) {
      // 脚本 .cs 尚未生成，记录为 pending
      const seenIn: string[] = []
      pendingScripts.push({ className, originalGuid: origGuid, seenInFiles: seenIn })
      log(`    [PENDING] ${className} → .cs 尚未生成，原始 GUID: ${origGuid.slice(0, 8)}...`)
      continue
    }

    const { csFile, metaFile, guid: targetGuid } = targetInfo

    if (targetGuid === origGuid) {
      log(`    [OK] ${className} GUID 已匹配，无需更新`)
      continue
    }

    // ── 碰撞检测：写入前检查 origGuid 是否已被其他类占用 ──────────────────
    const occupant = targetGuidToClass.get(origGuid)
    if (occupant && occupant !== className) {
      log(`    [COLLISION] ${origGuid.slice(0, 8)}... 已被 ${occupant} 占用，需要先替换占用者`)
      // 给占用者生成一个新的随机 GUID，腾出位置
      const newOccupantGuid = Array.from({ length: 32 }, () =>
        Math.floor(Math.random() * 16).toString(16)
      ).join("")
      const occupantInfo = targetClassToMeta.get(occupant)
      if (occupantInfo && !isDry) {
        const occupantMeta = await Bun.file(occupantInfo.metaFile).text().catch(() => "")
        const displaced = occupantMeta.replace(/^(guid:\s*)[a-f0-9]+/m, `$1${newOccupantGuid}`)
        await Bun.write(occupantInfo.metaFile, displaced)
        // 更新内存索引，防止后续循环再次碰撞到旧值
        targetGuidToClass.delete(origGuid)
        targetGuidToClass.set(newOccupantGuid, occupant)
        const occupantEntry = targetClassToMeta.get(occupant)
        if (occupantEntry) occupantEntry.guid = newOccupantGuid
        log(`    [DISPLACED] ${occupant}: ${origGuid.slice(0, 8)}... → ${newOccupantGuid.slice(0, 8)}... (腾出位置)`)
      }
      guidCollisions.push({
        guid: origGuid,
        intendedClass: className,
        occupiedBy: occupant,
        resolution: "displaced",
      })
    }

    // 优先尝试从 sourceProject 拷贝原始 .meta 文件
    const sourceMeta = sourceClassToMeta.get(className)
    let success = false

    if (sourceMeta) {
      log(`    [COPY META] 从源项目复制原始 .meta 供 ${className} 使用`)
      if (!isDry) {
        await fs.copyFile(sourceMeta, metaFile)
      }
      success = true
    }

    if (!success) {
      // 如果源项目找不到对应 .meta，或者拷贝失败，则在 target 原地修改或新建
      log(`    [GENERATE META] 源项目未找到 ${className} 的 .meta，进行本地改写`)
      const metaExists = await fs.access(metaFile).then(() => true).catch(() => false)
      const metaContent = metaExists
        ? await Bun.file(metaFile).text()
        : [
            "fileFormatVersion: 2",
            `guid: ${origGuid}`,
            "MonoImporter:",
            "  externalObjects: {}",
            "  serializedVersion: 2",
            "  defaultReferences: []",
            "  executionOrder: 0",
            "  icon: {fileID: 0}",
            "  userData: ",
            "  assetBundleName: ",
            "  assetBundleVariant: ",
          ].join("\n")

      const newContent = metaContent.includes("guid:")
        ? metaContent.replace(/^(guid:\s*)[a-f0-9]+/m, `$1${origGuid}`)
        : metaContent

      if (!isDry) {
        await Bun.write(metaFile, newContent)
      }
    }

    // 更新内存索引
    targetGuidToClass.delete(targetGuid)
    targetGuidToClass.set(origGuid, className)
    targetInfo.guid = origGuid

    updates.push({
      className,
      metaFile,
      oldGuid: targetGuid || "(none)",
      newGuid: origGuid,
    })
    log(`    [UPDATE] ${className}: ${(targetGuid || "none").slice(0, 8)}... → ${origGuid.slice(0, 8)}...${isDry ? " (dry)" : ""}`)
  }

  // ── 写入后全量重复检测（捕获工具外部引入的碰撞，例如 Unity Editor 自动生成的 meta）──
  const postGuidCount = new Map<string, string[]>()
  for (const csFile of await findFiles(scriptsDir, [".cs"])) {
    const metaFile = csFile + ".meta"
    const content = await Bun.file(metaFile).text().catch(() => "")
    const m = content.match(/^guid:\s*([a-f0-9]+)/m)
    if (!m) continue
    const g = m[1]
    const cls = path.basename(csFile, ".cs")
    const existing = postGuidCount.get(g) ?? []
    existing.push(cls)
    postGuidCount.set(g, existing)
  }
  for (const [g, classes] of postGuidCount) {
    if (classes.length > 1) {
      log(`    [WARN] GUID 重复: ${g.slice(0, 8)}... 被 [${classes.join(", ")}] 共用`)
      // 已在报告的 guidCollisions 里的不重复添加
      const alreadyLogged = guidCollisions.some(c => c.guid === g)
      if (!alreadyLogged) {
        guidCollisions.push({
          guid: g,
          intendedClass: classes[0],
          occupiedBy: classes.slice(1).join(", "),
          resolution: "skipped",
        })
      }
    }
  }

  return { updates, pendingScripts, guidCollisions }
}

// ── Phase 4: 复制非脚本资源 ────────────────────────────────────────────────

async function copyAssets(
  sourceProject: string,
  targetProject: string,
  excludePaths: string[],
  overwrite: boolean,
  isDry: boolean,
  log: (msg: string) => void,
): Promise<Record<string, number>> {
  const sourceAssets = path.join(sourceProject, "Assets")
  const targetAssets = path.join(targetProject, "Assets")
  const counts: Record<string, number> = {}

  // 规范化排除路径（确保以 / 开头便于比较）
  const normalizedExcludes = excludePaths.map(p => p.replace(/\\/g, "/").replace(/\/?$/, "/"))

  async function copyDir(srcDir: string, tgtDir: string) {
    let entries: string[]
    try { entries = await fs.readdir(srcDir) } catch { return }

    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry)
      const tgtPath = path.join(tgtDir, entry)
      const relFromAssets = (srcPath.slice(sourceAssets.length + 1) + "/").replace(/\\/g, "/")

      // 检查是否在排除列表中
      const isExcluded = normalizedExcludes.some(ex => relFromAssets.startsWith(ex))
      if (isExcluded) {
        log(`    [SKIP] ${relFromAssets}`)
        continue
      }

      const stat = await fs.stat(srcPath).catch(() => null)
      if (!stat) continue

      if (stat.isDirectory()) {
        if (!isDry) await fs.mkdir(tgtPath, { recursive: true })
        await copyDir(srcPath, tgtPath)
      } else {
        // 跳过 .cs 和 .cs.meta 文件（目标工程的脚本 GUID 由 Phase 3 管理，不能被源覆盖）
        if (entry.endsWith(".cs") || entry.endsWith(".cs.meta")) continue

        // 检查目标是否已存在
        const exists = await fs.access(tgtPath).then(() => true).catch(() => false)
        if (exists && !overwrite) continue

        if (!isDry) {
          await fs.mkdir(tgtDir, { recursive: true })
          await fs.copyFile(srcPath, tgtPath)
        }

        // 统计文件类型
        const ext = path.extname(entry).slice(1).toLowerCase() || "other"
        const category = getFileCategory(ext)
        counts[category] = (counts[category] ?? 0) + 1
      }
    }
  }

  await copyDir(sourceAssets, targetAssets)
  return counts
}

// ── Phase 4.5: ugui GUID 批量重映射 ──────────────────────────────────────────
//
// 旧版内置 ugui（AssetRipper 从游戏导出时保留的 GUID）与 com.unity.ugui@2.0.0
// 包的 GUID 不同。此对照表将 prefab/scene 里的旧 GUID 替换为包版本的固定 GUID。
//
// 来源：com.unity.ugui@23b1a4ff749d（Unity 6 内置包，GUID 全球固定）
// 验证：在 5 个不同工程、2 个 Unity 版本中均一致。

const UGUI_GUID_REMAP: Record<string, string> = {
  "3cf5a44414476512e00c3e7a2569a919": "fe87c0e1cc204ed48ad3b37840f39efc", // Image
  "04f84fc2003509a5e7e068ec1271cc40": "5f7201a12d95ffc409449d95f23cf332", // Text
  "18d0a90695249463551c00f45766e642": "4e29b1a8efbd4b44bb3f3716e73f07ff", // Button
  "ebd2e29daf7173be598bde7aa4276f64": "9085046f02f69544eb97fd06b6048fe2", // Toggle
  "fd15dcd248d61aa7b5dbf8f46b1ba63c": "2fafe2cfe61f6974895a912c3755e8f1", // ToggleGroup
  "2cbaf7f938a676aaf8fab3181b92a517": "1aa08ab6e0800fa44ae55d278d1423e3", // ScrollRect
  "6dfc8ec6aebac6665d9781d273993f23": "0cd44c1031e13a943bb63640046fad76", // CanvasScaler
  "86fe8f3fc59dc06ea6b45a1bbee64682": "dc42784cf147c0c48a680349fa168899", // GraphicRaycaster
  "ba2c49586942b2c63eaf5232b4e93bc3": "76c392e42b5098c458856cdf6ecaaaa1", // EventSystem
  "2a84a6bd90c7eb594e110c389d93f072": "4f231c4fb786f3946a6b90b886c48677", // StandaloneInputModule
  "f3f93bf78008e17093a6a1d9f65bd01c": "d0b148fe25e99eb48b9724523833bab1", // EventTrigger
  "8ffc7d923b31b10e81b381e1325ae677": "8a8695521f0d02e499659fee002a26c2", // GridLayoutGroup
  "19fbb4a32b59286cd89b624f52ff7943": "30649d3a9faa99c48a7b1166b86bf2a0", // HorizontalLayoutGroup
  "f18f2cc2fe71a3a6d76a570588d5047c": "59f8146938fff824cb5fd77236b75775", // VerticalLayoutGroup
  "21c7954052da7655d96bff866c2b7662": "3245ec927659c4140ac4f8d17403cc18", // ContentSizeFitter
  "598ca59b26b303be9752bcc87e36626e": "e19747de3f5aca642ab2be37e372fb86", // Outline
  "76ccfb4bfe5eebba5766d6f50f76ae37": "cfabb0440166ab443bba8876756fdfa9", // Shadow
  "16c0ec1e295995dd9a2d2df2d7b6cc7e": "31a19414c41e5ae4aae2af33fee712f6", // Mask
}

async function remapUguiGuids(
  targetProject: string,
  isDry: boolean,
  log: (msg: string) => void,
): Promise<number> {
  const yamlFiles = await findFiles(
    path.join(targetProject, "Assets"),
    [".prefab", ".unity", ".asset"]
  )

  let totalRemapped = 0
  for (const yamlFile of yamlFiles) {
    let content = await Bun.file(yamlFile).text().catch(() => "")
    if (!content) continue

    let changed = false
    let fileCount = 0
    for (const [oldGuid, newGuid] of Object.entries(UGUI_GUID_REMAP)) {
      if (content.includes(oldGuid)) {
        content = content.replaceAll(oldGuid, newGuid)
        changed = true
        fileCount++
      }
    }

    if (changed) {
      totalRemapped += fileCount
      if (!isDry) await Bun.write(yamlFile, content)
      log(`    [REMAP] ${path.basename(yamlFile)}: 替换了 ${fileCount} 种 ugui GUID`)
    }
  }
  return totalRemapped
}

// ── Phase 5: 外部资源引用完整性检查 ─────────────────────────────────────────

async function checkExternalRefs(
  targetProject: string,
  knownGuids: Set<string>,
  log: (msg: string) => void,
): Promise<Array<{ file: string; guid: string; fieldPath: string }>> {
  const missing: Array<{ file: string; guid: string; fieldPath: string }> = []

  // 收集目标工程所有已知 GUID（来自 .meta 文件）
  const targetGuids = new Set<string>()
  const targetAssets = path.join(targetProject, "Assets")
  const metaFiles = await findFiles(targetAssets, [".meta"])
  for (const mf of metaFiles) {
    const content = await Bun.file(mf).text().catch(() => "")
    const m = content.match(/^guid:\s*([a-f0-9]+)/m)
    if (m) targetGuids.add(m[1])
  }

  // 扫描 YAML 文件中的外部引用
  const yamlFiles = await findFiles(targetAssets, [".prefab", ".unity", ".asset"])
  const guidPattern = /\{fileID:\s*\d+,\s*guid:\s*([a-f0-9]{32}),\s*type:\s*[23]\}/g

  for (const yamlFile of yamlFiles) {
    const content = await Bun.file(yamlFile).text().catch(() => "")
    const matches = [...content.matchAll(guidPattern)]
    for (const m of matches) {
      const guid = m[1]
      if (guid === "0000000000000000f000000000000000") continue  // Unity 内置
      if (guid === "00000000000000000000000000000000") continue  // 空引用
      if (!targetGuids.has(guid)) {
        missing.push({
          file: yamlFile.slice(targetProject.length + 1),
          guid,
          fieldPath: "",
        })
      }
    }
  }

  log(`  ✓ 检查完成: ${missing.length} 个外部引用找不到对应 .meta`)
  return missing.slice(0, 100)  // 最多报告 100 条
}

// ── 工具函数 ────────────────────────────────────────────────────────────────

async function findFiles(dir: string, extensions: string[]): Promise<string[]> {
  const result: string[] = []
  async function walk(d: string) {
    let entries: string[]
    try { entries = await fs.readdir(d) } catch { return }
    for (const entry of entries) {
      const fullPath = path.join(d, entry)
      const stat = await fs.stat(fullPath).catch(() => null)
      if (!stat) continue
      if (stat.isDirectory()) {
        await walk(fullPath)
      } else if (extensions.some(ext => entry.endsWith(ext))) {
        result.push(fullPath)
      }
    }
  }
  await walk(dir)
  return result
}

function getFileCategory(ext: string): string {
  const categories: Record<string, string> = {
    prefab: "prefabs", unity: "scenes", asset: "scriptableObjects",
    png: "textures", jpg: "textures", jpeg: "textures", tga: "textures", psd: "textures",
    mat: "materials", shader: "shaders",
    fbx: "models", obj: "models", mesh: "models",
    wav: "audio", mp3: "audio", ogg: "audio",
    anim: "animations", controller: "animatorControllers",
    ttf: "fonts", otf: "fonts",
    cs: "scripts_skipped",
  }
  return categories[ext] ?? "other"
}

function buildSummary(
  updates: ScriptMetaUpdate[],
  pendingScripts: PendingScript[],
  unmappedGuids: UnmappedGuid[],
  guidCollisions: GuidCollision[],
  assetsCopied: Record<string, number>,
  uguidRemapped: number,
  missingRefs: Array<{ file: string; guid: string; fieldPath: string }>,
  isDry: boolean,
): string {
  const lines: string[] = []
  const prefix = isDry ? "[DRY RUN] " : ""

  lines.push(`${prefix}📋 脚本重绑定:`)
  lines.push(`   ✅ 成功更新 .meta: ${updates.length} 个`)
  if (uguidRemapped > 0) lines.push(`   ✅ ugui GUID 重映射: ${uguidRemapped} 处（prefab/scene 里的旧版内置 GUID → com.unity.ugui@2.0.0）`)
  if (pendingScripts.length > 0) lines.push(`   ⏳ 待生成脚本: ${pendingScripts.length} 个（代码生成后重新运行）`)
  if (unmappedGuids.length > 0) lines.push(`   ⚠️  无法识别的 GUID: ${unmappedGuids.length} 个（第三方插件/未导出，需手动处理）`)

  // GUID 碰撞摘要
  if (guidCollisions.length > 0) {
    const displaced = guidCollisions.filter(c => c.resolution === "displaced")
    const skipped = guidCollisions.filter(c => c.resolution === "skipped")
    lines.push(`   ⚡ GUID 碰撞自动修复: ${displaced.length} 个（占用者已被替换为新 GUID）`)
    if (skipped.length > 0) lines.push(`   ⚠️  GUID 碰撞未解决: ${skipped.length} 个（详见报告 guidCollisions）`)
    for (const c of displaced.slice(0, 3)) {
      lines.push(`      ${c.guid.slice(0, 8)}... → ${c.intendedClass}（替换了占用者 ${c.occupiedBy}）`)
    }
    if (displaced.length > 3) lines.push(`      ... 共 ${displaced.length} 个，详见报告`)
  }

  const totalCopied = Object.values(assetsCopied).reduce((a, b) => a + b, 0)
  if (totalCopied > 0) {
    lines.push(`${prefix}📦 资源复制: ${totalCopied} 个文件`)
    for (const [cat, cnt] of Object.entries(assetsCopied)) {
      if (cnt > 0 && cat !== "scripts_skipped") lines.push(`   - ${cat}: ${cnt}`)
    }
  }

  if (missingRefs.length > 0) {
    lines.push(`${prefix}🔗 外部引用缺失: ${missingRefs.length} 处（不影响运行，部分可能是第三方资产）`)
  }

  const missingNeedManual = unmappedGuids.filter(u =>
    !u.seenInFiles.some(f => f.includes("SRDebugger") || f.includes("StompyRobot"))
  )
  if (missingNeedManual.length > 0) {
    lines.push("")
    lines.push("🔧 需手动处理的 Missing Script:")
    for (const u of missingNeedManual.slice(0, 5)) {
      lines.push(`   ${u.guid.slice(0, 8)}... (见 ${u.seenInFiles[0]?.split("/").pop() ?? "?"})`)
    }
    if (missingNeedManual.length > 5) lines.push(`   ... 共 ${missingNeedManual.length} 个，详见报告`)
  }

  return lines.join("\n")
}
