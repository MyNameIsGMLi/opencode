import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

// 项目配置结构，可通过 .opencode/unity-config.json 覆盖默认值
export interface UnityProjectConfig {
  // dump 文件目录（相对于 projectDir）
  dumpDir: string
  // dump.cs 文件名
  dumpCsName: string
  // script.json 文件名
  scriptJsonName: string
  // 生成代码输出目录（相对于 projectDir）
  scriptsDir: string
  // 分析文档输出目录（相对于 projectDir）
  analysisDir: string

  // ── 资产重绑定配置（可选）──────────────────────────────────────
  // AssetRipper 已导出的源 Unity 项目路径（绝对路径）
  // 例："/Users/ggm/UnPackAPP/arrows_unity_project"
  sourceProjectPath?: string
  // AssetRipper 可执行文件路径（不填则自动探测）
  assetRipperPath?: string
  // 额外排除的目录（相对于 Assets/，追加到默认排除列表）
  // 默认排除：["Scripts/", "Editor/", "Il2CppDump/"]
  rebindExcludePaths?: string[]
}

const DEFAULTS: UnityProjectConfig = {
  dumpDir: "Assets/Il2CppDump",
  dumpCsName: "dump.cs",
  scriptJsonName: "script.json",
  scriptsDir: "Assets/Scripts",
  analysisDir: ".opencode/docs/analysis",
}

// Unity Hub 默认路径（按平台）
const UNITY_HUB_DEFAULTS: Record<string, string> = {
  darwin:  "/Applications/Unity/Hub/Editor",
  win32:   "C:\\Program Files\\Unity\\Hub\\Editor",
  linux:   path.join(os.homedir(), "Unity", "Hub", "Editor"),
}

// AssetRipper 自动探测候选路径
function getAssetRipperCandidates(): string[] {
  const home = os.homedir()
  return [
    path.join(home, "UnPackAPP", "UnPackTools", "AssetRipper", "AssetRipper"),
    path.join(home, "UnPackTools", "AssetRipper", "AssetRipper.GUI.Free"),
    path.join(home, "UnPackTools", "AssetRipper", "AssetRipper"),
    path.join(home, "GitHubProjects", "AssetRipper", "AssetRipper", "Release", "AssetRipper.GUI.Free"),
    "/Applications/AssetRipper.app/Contents/MacOS/AssetRipper",
  ]
}

// 加载项目配置：先用默认值，再用 .opencode/unity-config.json 覆盖
export async function loadProjectConfig(projectDir: string): Promise<UnityProjectConfig> {
  const configPath = path.join(projectDir, ".opencode", "unity-config.json")
  try {
    const raw = await Bun.file(configPath).json()
    return { ...DEFAULTS, ...raw }
  } catch {
    return { ...DEFAULTS }
  }
}

// 解析 dump.cs 的完整路径（支持直接路径覆盖）
export function resolveDumpCsPath(projectDir: string, config: UnityProjectConfig, override?: string): string {
  return override ?? path.join(projectDir, config.dumpDir, config.dumpCsName)
}

// 解析 script.json 的完整路径（支持直接路径覆盖）
export function resolveScriptJsonPath(projectDir: string, config: UnityProjectConfig, override?: string): string {
  return override ?? path.join(projectDir, config.dumpDir, config.scriptJsonName)
}

// 解析代码输出目录
export function resolveScriptsDir(projectDir: string, config: UnityProjectConfig, override?: string): string {
  return override ?? path.join(projectDir, config.scriptsDir)
}

// 解析分析文档目录
export function resolveAnalysisDir(projectDir: string, config: UnityProjectConfig): string {
  return path.join(projectDir, config.analysisDir)
}

// 自动检测项目根目录（向上最多 3 级查找）
export async function detectProjectDir(startDir?: string): Promise<string | null> {
  const base = startDir ?? process.cwd()
  const candidates = [base, path.join(base, ".."), path.join(base, "../.."), path.join(base, "../../..")]

  for (const dir of candidates) {
    const resolved = path.resolve(dir)
    // 支持任意 dumpDir 位置：只要 .opencode/rag 或 Assets 目录存在即认为是项目根
    const hasAssets = await fs.access(path.join(resolved, "Assets")).then(() => true).catch(() => false)
    const hasRag = await fs.access(path.join(resolved, ".opencode", "rag")).then(() => true).catch(() => false)
    if (hasAssets || hasRag) return resolved
  }
  return null
}

// 解析源项目路径（参数 > unity-config.json > 无默认，必须显式配置）
export function resolveSourceProjectPath(
  config: UnityProjectConfig,
  override?: string,
): string | null {
  return override ?? config.sourceProjectPath ?? null
}

// 解析 AssetRipper 可执行文件路径（参数 > unity-config.json > 自动探测）
export async function resolveAssetRipperPath(
  config: UnityProjectConfig,
  override?: string,
): Promise<string | null> {
  const explicit = override ?? config.assetRipperPath
  if (explicit) {
    const exists = await fs.access(explicit).then(() => true).catch(() => false)
    return exists ? explicit : null
  }
  // 自动探测
  for (const candidate of getAssetRipperCandidates()) {
    const exists = await fs.access(candidate).then(() => true).catch(() => false)
    if (exists) return candidate
  }
  return null
}

// 解析 Unity Editor 可执行文件路径（按版本，含模糊匹配）
// log 参数可选，用于输出 fallback 警告
export async function resolveUnityEditorPath(
  version: string,
  override?: string,
  log?: (msg: string) => void,
): Promise<string | null> {
  if (override) {
    const exists = await fs.access(override).then(() => true).catch(() => false)
    return exists ? override : null
  }
  const hubBase = UNITY_HUB_DEFAULTS[process.platform] ?? UNITY_HUB_DEFAULTS.linux
  const binaryName = process.platform === "win32" ? "Unity.exe" : "Unity"
  const getPath = (v: string) =>
    process.platform === "darwin"
      ? path.join(hubBase, v, "Unity.app", "Contents", "MacOS", "Unity")
      : path.join(hubBase, v, "Editor", binaryName)

  // 精确匹配
  const exactPath = getPath(version)
  if (await fs.access(exactPath).then(() => true).catch(() => false)) return exactPath

  let installed: string[] = []
  try { installed = await fs.readdir(hubBase) } catch { return null }

  // 同 major.minor 模糊匹配：取最新补丁
  const majorMinor = version.match(/^(\d+\.\d+)/)
  if (majorMinor) {
    const prefix = majorMinor[1]
    const candidates = installed.filter((v: string) => v.startsWith(prefix)).sort().reverse()
    for (const v of candidates) {
      const p = getPath(v)
      if (await fs.access(p).then(() => true).catch(() => false)) {
        log?.(`  ⚠️ 未找到 Unity ${version}，使用同 major.minor 最新版本 ${v}`)
        return p
      }
    }
  }

  // 跨 major.minor fallback：按 major 版本号距离排序，取最接近的已安装版本
  const requestedMajor = parseInt(version.split(".")[0], 10)
  const requestedMinor = parseInt(version.split(".")[1] ?? "0", 10)
  const ranked = installed
    .filter(v => /^\d+\.\d+/.test(v))
    .map(v => {
      const [maj, min] = v.split(".").map(n => parseInt(n, 10))
      const dist = Math.abs(maj - requestedMajor) * 1000 + Math.abs((min ?? 0) - requestedMinor)
      return { v, dist }
    })
    .sort((a, b) => a.dist - b.dist || b.v.localeCompare(a.v))

  for (const { v } of ranked) {
    const p = getPath(v)
    if (await fs.access(p).then(() => true).catch(() => false)) {
      log?.(`  ⚠️ 未找到 Unity ${version}，使用最接近版本 ${v}（跨 major.minor fallback）`)
      return p
    }
  }

  return null
}

// 获取默认排除路径列表（含用户追加）
export function getDefaultExcludePaths(config: UnityProjectConfig): string[] {
  const defaults = ["Scripts/", "Editor/", "Il2CppDump/"]
  const extra = config.rebindExcludePaths ?? []
  return [...new Set([...defaults, ...extra])]
}
