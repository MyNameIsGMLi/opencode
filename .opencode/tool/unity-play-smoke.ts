import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"
import { execSync } from "child_process"

/**
 * Unity Play 就绪静态体检工具（Stage 7 最终验收 - 静态部分）
 *
 * 设计取舍：Unity batchmode 下 EnterPlaymode() 不可靠（引擎已知限制），
 * 且 -nographics 无法验证渲染表现。因此最终"Play 起来像不像原版"由人工在
 * Editor 里手动点 Play + 手机对比原版完成。
 *
 * 本工具负责把工程准备到"一键可 Play"，并做可靠的静态体检：
 *   1. 核心场景能否被 Editor 加载（batchmode OpenScene，可靠）
 *   2. 核心场景 Missing Script 数（GUID 重绑定是否有效）
 *   3. 工程能否编译通过（无 error CS）
 *   4. 把核心场景设为启动场景，输出人工 Play 指引
 *
 * 零降级：场景无法加载 / 有 Missing Script / 编译失败 → assessment="NOT-READY", blocked。
 */
export default tool({
  description: "Unity Play 就绪静态体检 + 一键可 Play 准备，输出人工 Play 验收指引（Stage 7）",

  args: {
    projectPath: tool.schema.string().describe("目标 Unity 工程路径"),
    coreScene: tool.schema.string().describe("核心玩法场景相对路径，如 Assets/Block_Puzzle/_Scenes/Main.unity"),
    unityVersion: tool.schema.string().optional().describe("Unity 版本，不填则读 ProjectVersion.txt"),
    timeout: tool.schema.number().optional().describe("超时秒数，默认 300"),
  },

  async execute(args) {
    const proj = path.resolve(args.projectPath)
    const scene = args.coreScene
    const timeoutMs = (args.timeout ?? 300) * 1000

    const version = args.unityVersion ?? (await readUnityVersion(proj))
    if (!version) return blocked("无法确定 Unity 版本（ProjectVersion.txt 缺失）")

    const unityBin = `/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/MacOS/Unity`
    if (!(await exists(unityBin))) return blocked(`未找到 Unity ${version}`)

    const sceneAbs = path.join(proj, scene)
    if (!(await exists(sceneAbs))) return blocked(`核心场景不存在: ${scene}`)

    // 写入静态体检 EditorScript：OpenScene + 统计 Missing Script + 设为启动场景
    const editorDir = path.join(proj, "Assets", "Editor")
    await fs.mkdir(editorDir, { recursive: true })
    const scriptPath = path.join(editorDir, "PlayReadinessChecker.cs")
    await fs.writeFile(scriptPath, readinessScript(scene))

    const logFile = path.join("/tmp", `unity_readiness_${Date.now()}.log`)
    const cmd = [
      `"${unityBin}"`,
      "-batchmode",
      "-silent-crashes",
      `-projectPath "${proj}"`,
      `-executeMethod PlayReadinessChecker.Run`,
      `-logFile "${logFile}"`,
      "-quit",
    ].join(" ")

    let runError = ""
    try {
      execSync(cmd, { timeout: timeoutMs, stdio: "ignore" })
    } catch (e: any) {
      runError = (e.message || String(e)).slice(0, 200)
    }

    await fs.rm(scriptPath, { force: true }).catch(() => {})
    await fs.rm(scriptPath + ".meta", { force: true }).catch(() => {})

    const log = await fs.readFile(logFile, "utf-8").catch(() => "")
    return analyze(log, scene, proj, version, logFile, runError)
  },
})

function analyze(
  log: string,
  scene: string,
  proj: string,
  version: string,
  logFile: string,
  runError: string,
) {
  const sceneLoaded = /\[Readiness\]\s*SCENE_LOADED/.test(log)
  const missMatch = log.match(/\[Readiness\]\s*MISSING_SCRIPTS=(\d+)/)
  const missingScripts = missMatch ? parseInt(missMatch[1], 10) : -1
  const goMatch = log.match(/\[Readiness\]\s*GAMEOBJECTS=(\d+)/)
  const gameObjects = goMatch ? parseInt(goMatch[1], 10) : 0
  const compileErrors = (log.match(/error CS\d+/g) || []).length

  const issues: string[] = []
  if (!sceneLoaded) issues.push("核心场景无法被 Editor 加载")
  if (missingScripts > 0) issues.push(`核心场景含 ${missingScripts} 个 Missing Script（GUID 未重绑定）`)
  if (missingScripts < 0) issues.push("未能统计 Missing Script（体检脚本未正常执行）")
  if (compileErrors > 0) issues.push(`编译错误 ${compileErrors} 个`)

  const assessment = issues.length === 0 ? "READY" : "NOT-READY"
  const unityApp = `/Applications/Unity/Hub/Editor/${version}/Unity.app`

  const summary = `${assessment === "READY" ? "✅ READY" : "⛔ NOT-READY"} — Play 就绪静态体检（Stage 7）

核心场景：${scene}
场景加载：${sceneLoaded ? "✓" : "✗"}  GameObject：${gameObjects}  Missing Script：${missingScripts < 0 ? "?" : missingScripts}  编译错误：${compileErrors}

${issues.length ? "阻塞问题：\n" + issues.map((i) => "  - " + i).join("\n") : "静态体检全部通过，工程已就绪可 Play。"}

${
  assessment === "READY"
    ? `→ 人工 Play 验收（核心场景已设为启动场景）：
   1. 打开工程：open -a "${unityApp}" "${proj}"
   2. 在 Editor 里点 ▶ Play
   3. 用手机跑原版肉眼对比：砖块外观/生成/堆叠/掉落/计分/UI
   4. 给出结论：一致 / 部分一致+差异清单 / 不一致`
    : "→ 零降级：存在阻塞问题，修复后重测，不得判为成功。"
}

日志：${logFile}${runError ? `\n运行异常：${runError}` : ""}`

  return {
    output: summary,
    metadata: {
      success: assessment === "READY",
      blocked: assessment === "NOT-READY",
      assessment,
      scene_loaded: sceneLoaded,
      game_objects: gameObjects,
      missing_scripts: missingScripts,
      compile_errors: compileErrors,
      issues,
      manual_play_cmd: `open -a "${unityApp}" "${proj}"`,
      log_file: logFile,
    },
  }
}

function readinessScript(scene: string): string {
  return `using UnityEngine;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine.SceneManagement;
using System.Linq;

// 自动生成的 Play 就绪静态体检（Stage 7）。OpenScene + 统计 Missing Script + 设为启动场景。
public static class PlayReadinessChecker
{
    public static void Run()
    {
        try
        {
            var scene = EditorSceneManager.OpenScene("${scene}", OpenSceneMode.Single);
            if (!scene.IsValid()) { Debug.LogError("[Readiness] scene invalid"); EditorApplication.Exit(1); return; }
            Debug.Log("[Readiness] SCENE_LOADED");

            var roots = scene.GetRootGameObjects();
            int goCount = 0, missing = 0;
            foreach (var root in roots)
            {
                var all = root.GetComponentsInChildren<Transform>(true);
                goCount += all.Length;
                foreach (var t in all)
                {
                    var comps = t.GetComponents<Component>();
                    foreach (var c in comps) if (c == null) missing++;
                }
            }
            Debug.Log("[Readiness] GAMEOBJECTS=" + goCount);
            Debug.Log("[Readiness] MISSING_SCRIPTS=" + missing);

            // 设为启动场景，方便人工一键 Play
            var buildScenes = new EditorBuildSettingsScene[] {
                new EditorBuildSettingsScene("${scene}", true)
            };
            EditorBuildSettings.scenes = buildScenes;

            EditorApplication.Exit(0);
        }
        catch (System.Exception e)
        {
            Debug.LogError("[Readiness] EXCEPTION " + e);
            EditorApplication.Exit(1);
        }
    }
}
`
}

async function readUnityVersion(proj: string): Promise<string | null> {
  const f = path.join(proj, "ProjectSettings", "ProjectVersion.txt")
  const text = await fs.readFile(f, "utf-8").catch(() => "")
  return text.match(/m_EditorVersion:\s*(\S+)/)?.[1] ?? null
}

function blocked(reason: string) {
  return { output: `⛔ BLOCKED: ${reason}`, metadata: { success: false, blocked: true, reason } }
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false)
}
