import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import { execSync, spawn } from "child_process"

/**
 * AssetRipper Web API 自动化导出工具
 * 
 * 以 headless 模式启动 AssetRipper.GUI.Free，通过 Web API 调用：
 * 1. POST /Settings/Update — 设置 ScriptExportMode=Decompiled
 * 2. POST /LoadFolder      — 加载游戏数据（可同时加载 DummyDll 目录获取完整字段数据）
 * 3. POST /Export/UnityProject — 导出到目标目录
 * 
 * 当提供 dummydllPath 时，AssetRipper 会同时加载 DummyDll 和游戏数据，
 * 从而正确反序列化 IL2CPP MonoBehaviour 的自定义字段（如 MeshRenderer、Head、Tail 等）。
 */
export default tool({
  description: "通过 AssetRipper Web API 自动将 APK/IPA 导出为包含完整字段数据的 Unity 工程（Decompiled 模式）",

  args: {
    inputPath: tool.schema.string().describe("APK/IPA/XAPK 文件路径或游戏文件夹"),
    outputPath: tool.schema.string().describe("导出目标目录"),
    dummydllPath: tool.schema.string().optional().describe(
      "Il2CppDumper 生成的 DummyDll 目录路径。提供后 AssetRipper 能正确反序列化 MonoBehaviour 字段数据（推荐）"
    ),
    assetRipperPath: tool.schema.string().optional().describe(
      "AssetRipper.GUI.Free 路径，默认自动探测"
    ),
    scriptExportMode: tool.schema.enum(["Decompiled", "Hybrid", "DllExportWithRenaming", "DllExportWithoutRenaming"]).optional().describe(
      "脚本导出模式，默认 Decompiled"
    ),
    scriptContentLevel: tool.schema.number().optional().describe(
      "脚本内容级别 0-3，默认 2"
    ),
    port: tool.schema.number().optional().describe("AssetRipper Web 服务端口，默认随机"),
    timeoutSeconds: tool.schema.number().optional().describe("导出超时秒数，默认 600"),
  },

  async execute(args, _ctx) {
    const timeout = (args.timeoutSeconds ?? 600) * 1000
    const scriptMode = args.scriptExportMode ?? "Decompiled"
    const scriptLevel = args.scriptContentLevel ?? 2
    const outputDir = path.resolve(args.outputPath)

    // 找 AssetRipper 可执行文件
    const ripperPath = args.assetRipperPath ?? await findAssetRipper()
    if (!ripperPath) {
      return "Error: 找不到 AssetRipper.GUI.Free，请通过 assetRipperPath 参数指定路径"
    }

    // 准备输出目录
    await fs.mkdir(outputDir, { recursive: true })

    // 启动 AssetRipper headless
    const port = args.port ?? (50000 + Math.floor(Math.random() * 10000))
    const logFile = path.join(os.tmpdir(), `assetripper_api_${Date.now()}.log`)

    console.log(`[AssetRipper] 启动 headless 服务 port=${port}...`)
    const proc = spawn(ripperPath, [
      "--launch-browser=false",
      `--port=${port}`,
      `--log-path=${logFile}`,
    ], {
      detached: false,
      stdio: "ignore",
    })

    const baseUrl = `http://localhost:${port}`
    let procKilled = false

    const killProc = () => {
      if (!procKilled) {
        procKilled = true
        try { proc.kill("SIGTERM") } catch {}
      }
    }

    try {
      // 等待服务启动（最多 30 秒）
      await waitForServer(baseUrl, 30000)
      console.log(`[AssetRipper] 服务已启动`)

      // 设置 ScriptExportMode
      console.log(`[AssetRipper] 设置 ScriptExportMode=${scriptMode}, ScriptContentLevel=${scriptLevel}...`)
      await apiPost(baseUrl, "/Settings/Update", {
        ScriptExportMode: scriptMode,
        ScriptContentLevel: String(scriptLevel),
      })

      // 加载游戏数据，可选同时加载 DummyDll 以获取完整字段数据
      const inputStat = await fs.stat(args.inputPath).catch(() => null)
      if (args.dummydllPath) {
        // 多路径加载：DummyDll 目录 + 游戏文件
        // AssetRipper LoadFolder/LoadFile 支持多个 Path 值（StringValues）
        // 需要手动构造 multivalue form body：Path=/dummydll&Path=/gamefolder
        const dummydllAbs = path.resolve(args.dummydllPath)
        const inputAbs = path.resolve(args.inputPath)
        console.log(`[AssetRipper] 加载 DummyDll: ${dummydllAbs}`)
        console.log(`[AssetRipper] 加载游戏文件: ${inputAbs}`)
        const bodyParts = [
          `Path=${encodeURIComponent(dummydllAbs)}`,
          `Path=${encodeURIComponent(inputAbs)}`,
        ]
        // 游戏文件是文件时用 LoadFile，是文件夹时用 LoadFolder
        // 当有 DummyDll 时统一用 LoadFolder（DummyDll 是目录，AssetRipper 可递归扫描）
        await apiPostRaw(baseUrl, "/LoadFolder", bodyParts.join("&"))
      } else {
        // 单路径加载（无 DummyDll，字段数据可能为空）
        console.log(`[AssetRipper] 加载文件: ${args.inputPath}`)
        const endpoint = inputStat?.isDirectory() ? "/LoadFolder" : "/LoadFile"
        await apiPost(baseUrl, endpoint, { Path: args.inputPath })
      }

      // 等待加载完成（轮询，最多 120 秒）
      await waitForLoaded(baseUrl, 120000)
      console.log(`[AssetRipper] 文件加载完成`)

      // 清空输出目录（避免旧文件干扰）
      try { await fs.rm(outputDir, { recursive: true }) } catch {}
      await fs.mkdir(outputDir, { recursive: true })

      // 导出 Unity 工程
      console.log(`[AssetRipper] 开始导出到: ${outputDir}`)
      await apiPost(baseUrl, "/Export/UnityProject", { Path: outputDir })

      // 等待导出完成（检查目标目录里有文件出现）
      await waitForExport(outputDir, timeout)
      console.log(`[AssetRipper] 导出完成 → ${outputDir}`)

      // 验证结果
      const exported = await countExportedFiles(outputDir)
      return `✅ AssetRipper 导出完成\n  模式: ${scriptMode}\n  输出: ${outputDir}\n  文件数: ${exported}\n  日志: ${logFile}`

    } finally {
      killProc()
    }
  },
})

// ── 工具函数 ─────────────────────────────────────────────────────────────────

async function findAssetRipper(): Promise<string | null> {
  const candidates = [
    "/Users/ggm/UnPackAPP/UnPackTools/AssetRipper_Compiled/AssetRipper.GUI.Free",
    `${os.homedir()}/UnPackAPP/UnPackTools/AssetRipper_Compiled/AssetRipper.GUI.Free`,
    "/Applications/AssetRipper.app/Contents/MacOS/AssetRipper.GUI.Free",
  ]
  for (const c of candidates) {
    if (await fs.access(c).then(() => true).catch(() => false)) return c
  }
  return null
}

async function apiPost(baseUrl: string, endpoint: string, fields: Record<string, string>): Promise<void> {
  const body = new URLSearchParams(fields).toString()
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",  // 不自动跟随重定向（命令执行后服务会 redirect）
  })
  // 200 OK 或 3xx redirect 都算成功
  if (res.status >= 400) {
    throw new Error(`API ${endpoint} 返回 ${res.status}`)
  }
}

// 支持多值 form body（如 Path=/a&Path=/b），用于同时加载 DummyDll + 游戏文件
async function apiPostRaw(baseUrl: string, endpoint: string, rawBody: string): Promise<void> {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: rawBody,
    redirect: "manual",
  })
  if (res.status >= 400) {
    throw new Error(`API ${endpoint} 返回 ${res.status}`)
  }
}

async function waitForServer(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl, { signal: AbortSignal.timeout(2000) })
      if (res.ok || res.status === 200) return
    } catch {}
    await sleep(500)
  }
  throw new Error("AssetRipper 服务启动超时")
}

async function waitForLoaded(baseUrl: string, timeoutMs: number): Promise<void> {
  // AssetRipper 加载时 /Commands 页面状态会变化
  // 简单策略：等待服务不再返回 "loading" 相关内容，或等固定 5 秒
  await sleep(5000)
  // 轮询检查 /Commands 页面是否有 "IsLoaded"
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/Commands`, { signal: AbortSignal.timeout(3000) })
      const text = await res.text()
      if (text.includes("Export") || text.includes("export")) return
    } catch {}
    await sleep(2000)
  }
  throw new Error("AssetRipper 文件加载超时")
}

async function waitForExport(outputDir: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastCount = 0
  let stableFor = 0

  while (Date.now() < deadline) {
    const count = await countExportedFiles(outputDir)
    if (count > 0 && count === lastCount) {
      stableFor += 3000
      if (stableFor >= 9000) return  // 文件数稳定 9 秒，认为完成
    } else {
      stableFor = 0
      lastCount = count
    }
    await sleep(3000)
  }

  if (lastCount > 0) return  // 超时但有文件，认为基本完成
  throw new Error("AssetRipper 导出超时（无文件生成）")
}

async function countExportedFiles(dir: string): Promise<number> {
  try {
    let count = 0
    const walk = async (d: string) => {
      const entries = await fs.readdir(d).catch(() => [] as string[])
      for (const e of entries) {
        const p = path.join(d, e)
        const s = await fs.stat(p).catch(() => null)
        if (s?.isDirectory()) await walk(p)
        else if (s?.isFile()) count++
      }
    }
    await walk(dir)
    return count
  } catch {
    return 0
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
