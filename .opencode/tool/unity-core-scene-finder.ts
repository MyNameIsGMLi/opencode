import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"

/**
 * Unity 核心玩法场景定位 + 关键类识别 + SDK 入口链剥离清单（Stage 4）
 *
 * 核心方法（从 Brick Stack Master 真实案例提炼）：
 * - 不靠"全局引用数盲排"，而是从**场景实际挂载的 MonoBehaviour** 反推关键玩法类，
 *   精度远高于引用计数。
 * - 自动过滤 Unity 内置/第三方脚本（UnityEngine.* / TMPro / Newtonsoft / 广告 SDK）。
 * - 按场景内玩法关键词（Brick/Block/Drop/Ball/Player/Board/Grid 等）+ 玩法类密度
 *   推断"核心玩法场景"。
 * - 扫描 RuntimeInitializeOnLoads.json + 各场景，生成 SDK 入口链剥离清单。
 */

const GAMEPLAY_KEYWORDS =
  /brick|block|drop|ball|player|board|grid|cell|piece|stack|cube|tile|puzzle|level|spawn|score/i

// 广告/分析 SDK 类名特征（待剥离）
const SDK_PATTERNS =
  /ironsource|levelplay|lpinit|appsflyer|admob|admgr|topon|tradplus|firebase|analytics|gameanalytics|adjust|facebook|applovin|unityads|mediation/i

// 非游戏脚本路径特征（Unity 内置/包/第三方）
const NON_GAME_PATH = /UnityEngine|Unity\.|TMPro|Newtonsoft|Packages|System\./

export default tool({
  description: "定位核心玩法场景 + 从场景挂载反推关键玩法类 + 生成 SDK 入口链剥离清单（Stage 4）",

  args: {
    sourceExportPath: tool.schema.string().describe("AssetRipper 导出根目录（含 ExportedProject）"),
    unpackedDataPath: tool.schema
      .string()
      .optional()
      .describe("解包后的 Data 目录（含 RuntimeInitializeOnLoads.json），用于 SDK 入口链分析"),
  },

  async execute(args) {
    const root = path.resolve(args.sourceExportPath)
    const proj = (await exists(path.join(root, "ExportedProject")))
      ? path.join(root, "ExportedProject")
      : root
    const assets = path.join(proj, "Assets")
    const scriptsDir = path.join(assets, "Scripts")

    const scenes = await findFiles(assets, ".unity")
    if (scenes.length === 0) {
      return { output: "⛔ 无场景文件", metadata: { success: false, blocked: true, reason: "无 .unity 场景" } }
    }

    // GUID → 脚本类名 映射（仅游戏脚本）
    const guidToClass = await buildGameScriptGuidMap(scriptsDir)

    // 逐场景分析挂载的游戏类
    const sceneReports = []
    for (const scene of scenes) {
      const text = await fs.readFile(scene, "utf-8").catch(() => "")
      const guids = new Set(
        (text.match(/m_Script:\s*\{fileID:\s*\d+,\s*guid:\s*([a-f0-9]{32})/g) || []).map(
          (m) => m.match(/guid:\s*([a-f0-9]{32})/)![1],
        ),
      )
      const gameClasses = [...guids].map((g) => guidToClass.get(g)).filter((c): c is string => !!c)
      const sdkClasses = gameClasses.filter((c) => SDK_PATTERNS.test(c))
      const playClasses = gameClasses.filter((c) => !SDK_PATTERNS.test(c))

      const keywordHits = (text.match(new RegExp(`m_Name:\\s*\\S*`, "g")) || []).filter((n) =>
        GAMEPLAY_KEYWORDS.test(n),
      ).length

      sceneReports.push({
        scene: path.relative(assets, scene),
        gameObjects: (text.match(/^GameObject:/gm) || []).length,
        playClasses: [...new Set(playClasses)].sort(),
        sdkClasses: [...new Set(sdkClasses)].sort(),
        keywordHits,
        // 核心场景评分：玩法类数 + 关键词命中，减去 SDK 类（启动场景 SDK 多）
        score: playClasses.length * 2 + keywordHits - sdkClasses.length,
      })
    }

    sceneReports.sort((a, b) => b.score - a.score)
    const coreScene = sceneReports[0]

    // SDK 入口链（RuntimeInitializeOnLoads）
    const sdkEntryChain = await analyzeRuntimeInit(args.unpackedDataPath)
    // 汇总所有场景里的 SDK 类
    const allSdkClasses = [...new Set(sceneReports.flatMap((r) => r.sdkClasses))].sort()

    const report = {
      core_scene: coreScene.scene,
      core_scene_gameobjects: coreScene.gameObjects,
      core_play_classes: coreScene.playClasses,
      all_scenes: sceneReports.map((r) => ({
        scene: r.scene,
        score: r.score,
        play_classes: r.playClasses.length,
        sdk_classes: r.sdkClasses.length,
      })),
      sdk_strip_list: {
        runtime_init_entries: sdkEntryChain,
        scene_sdk_classes: allSdkClasses,
      },
    }

    return { output: renderReport(report, sceneReports), metadata: { success: true, ...report } }
  },
})

async function buildGameScriptGuidMap(scriptsDir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (!(await exists(scriptsDir))) return map
  const metas = await findFiles(scriptsDir, ".cs.meta")
  for (const meta of metas) {
    if (NON_GAME_PATH.test(meta)) continue // 跳过 Unity 内置/包/第三方
    const text = await fs.readFile(meta, "utf-8").catch(() => "")
    const g = text.match(/guid:\s*([a-f0-9]{32})/)
    if (g) map.set(g[1], path.basename(meta, ".cs.meta"))
  }
  return map
}

async function analyzeRuntimeInit(dataPath?: string): Promise<any[]> {
  if (!dataPath) return []
  const file = path.join(dataPath, "RuntimeInitializeOnLoads.json")
  if (!(await exists(file))) return []
  const json = JSON.parse(await fs.readFile(file, "utf-8").catch(() => "{}"))
  const entries = json.root || []
  return entries
    .filter((e: any) => SDK_PATTERNS.test(e.className) || SDK_PATTERNS.test(e.assemblyName || ""))
    .map((e: any) => ({
      class: e.className,
      method: e.methodName,
      assembly: e.assemblyName,
      // loadTypes 0 = BeforeSceneLoad（Play 崩溃高发），1 = AfterSceneLoad
      loadType: e.loadTypes === 0 ? "BeforeSceneLoad" : "AfterSceneLoad",
      crash_risk: e.loadTypes === 0 ? "high" : "medium",
    }))
}

function renderReport(r: any, scenes: any[]): string {
  return `核心玩法场景定位（Stage 4）

🎮 核心玩法场景：${r.core_scene}（${r.core_scene_gameobjects} GameObject）

各场景评分：
${scenes.map((s) => `  ${s.scene}  score=${s.score}  玩法类=${s.playClasses.length}  SDK类=${s.sdkClasses.length}`).join("\n")}

让核心场景能 Play 的关键玩法类（共 ${r.core_play_classes.length} 个）：
${r.core_play_classes.map((c: string) => "  - " + c).join("\n")}

待剥离的 SDK 入口链（RuntimeInitializeOnLoad，Play 崩溃风险）：
${r.sdk_strip_list.runtime_init_entries.map((e: any) => `  - ${e.class}.${e.method}  [${e.loadType}, ${e.crash_risk} risk]`).join("\n") || "  （无）"}

各场景挂载的 SDK 类（待剥离）：
${r.sdk_strip_list.scene_sdk_classes.map((c: string) => "  - " + c).join("\n") || "  （无）"}

请确认核心玩法场景与关键类清单，或告知需增删。`
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false)
}

async function findFiles(dir: string, ext: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string) => {
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile() && p.toLowerCase().endsWith(ext)) out.push(p)
    }
  }
  await walk(dir)
  return out
}
