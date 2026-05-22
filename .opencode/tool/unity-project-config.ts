import * as fs from "fs/promises"
import * as path from "path"

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
}

const DEFAULTS: UnityProjectConfig = {
  dumpDir: "Assets/Il2CppDump",
  dumpCsName: "dump.cs",
  scriptJsonName: "script.json",
  scriptsDir: "Assets/Scripts",
  analysisDir: ".opencode/docs/analysis",
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
