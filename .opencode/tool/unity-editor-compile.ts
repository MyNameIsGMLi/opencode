import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"

/**
 * Unity Editor 编译工具
 *
 * 功能：
 * 1. 自动检测 Unity 版本（从 ProjectSettings/ProjectVersion.txt）
 * 2. 定位 Unity 可执行文件（支持版本模糊匹配）
 * 3. Headless 模式编译项目
 * 4. 解析编译日志，返回结构化错误列表
 */

export interface CompileError {
  file: string      // 相对于项目根目录的路径
  line: number
  column: number
  code: string      // 如 CS0246
  message: string
}

export interface CompileWarning {
  file: string
  line: number
  message: string
}

export interface CompileResult {
  success: boolean
  exitCode: number
  errors: CompileError[]
  warnings: CompileWarning[]
  duration: number   // 毫秒
  logPath: string
  unityVersion: string
  unityPath: string
}

export default tool({
  description: `调用 Unity Editor headless 模式编译项目，返回结构化编译结果。

功能：
- 自动从 ProjectVersion.txt 读取 Unity 版本
- 支持版本模糊匹配（major.minor 相同时取最新安装版本）
- 解析编译日志，返回结构化错误/警告列表`,

  args: {
    projectPath: tool.schema.string().describe("Unity 项目根目录（含 Assets/ ProjectSettings/ Packages/）"),
    unityVersion: tool.schema.string().optional().describe("Unity 版本（不填则从 ProjectVersion.txt 读取）"),
    timeout: tool.schema.number().optional().describe("超时秒数（默认 180）"),
    logFile: tool.schema.string().optional().describe("日志文件路径（默认 /tmp/unity_compile_<timestamp>.log）"),
  },

  async execute(args, ctx) {
    const startTime = Date.now()

    // ── Step 1: 读取 Unity 版本 ────────────────────────────────────
    let unityVersion = args.unityVersion
    if (!unityVersion) {
      const versionFile = path.join(args.projectPath, "ProjectSettings", "ProjectVersion.txt")
      try {
        const versionContent = await Bun.file(versionFile).text()
        const match = versionContent.match(/m_EditorVersion:\s*(\S+)/)
        if (match) {
          unityVersion = match[1]
        } else {
          return { error: `无法从 ProjectVersion.txt 解析 Unity 版本，请手动指定 --unityVersion` }
        }
      } catch {
        return { error: `无法读取 ${versionFile}，请确认这是一个 Unity 项目目录` }
      }
    }
    const resolvedVersion = unityVersion as string

    // ── Step 2: 检测 Unity Editor 是否已打开此项目 ────────────────
    // 若已打开，headless 实例会立即退出（"another Unity instance is running"）
    // 此时应直接从 Editor.log 解析最新编译结果，而非启动 headless
    const editorRunning = await isEditorRunningProject(args.projectPath, ctx)
    if (editorRunning) {
      const editorLogPath = `${process.env.HOME}/Library/Logs/Unity/Editor.log`
      let editorLog = ""
      try {
        editorLog = await Bun.file(editorLogPath).text()
      } catch {
        return { error: `Unity Editor 正在运行但无法读取 Editor.log: ${editorLogPath}` }
      }

      // 截取最新一次编译会话（从最后一个 "Initialize engine version" 开始）
      const sessions = editorLog.split("Initialize engine version:")
      const lastSession = sessions.length > 1 ? sessions[sessions.length - 1] : editorLog

      const { errors, warnings } = parseUnityLog(lastSession)
      // Editor 有编译错误时会输出 "Scripts have compiler errors"
      const hasCompileErrors = lastSession.includes("Scripts have compiler errors") || errors.length > 0
      const success = !hasCompileErrors

      const duration = Date.now() - startTime
      return {
        success,
        exitCode: success ? 0 : 1,
        errors,
        warnings,
        duration,
        logPath: editorLogPath,
        unityVersion: resolvedVersion,
        unityPath: "(Editor already running)",
        source: "editor-log",
        output: success
          ? [
              `✅ Unity 编译成功（从 Editor.log 读取）`,
              ``,
              `版本: ${resolvedVersion}`,
              warnings.length > 0 ? `警告: ${warnings.length} 条` : "",
              `日志来源: ${editorLogPath}`,
            ].filter(Boolean).join("\n")
          : [
              `❌ Unity 编译失败（从 Editor.log 读取）`,
              ``,
              `版本: ${resolvedVersion}`,
              `错误: ${errors.length} 个`,
              ``,
              `前 5 个错误:`,
              ...errors.slice(0, 5).map(e =>
                `  ${e.file}(${e.line},${e.column}): ${e.code}: ${e.message}`
              ),
              errors.length > 5 ? `  ... 共 ${errors.length} 个错误` : "",
              ``,
              `日志来源: ${editorLogPath}`,
              `提示: 请在 Unity Editor 中 Assets → Refresh 后重新检查`,
            ].filter(Boolean).join("\n"),
      }
    }

    // ── Step 3: Editor 未运行，走 headless 编译 ───────────────────
    const unityPath = await findUnityExecutable(resolvedVersion, ctx)
    if (!unityPath) {
      const installed = await listInstalledVersions(ctx)
      return {
        error: [
          `找不到 Unity ${unityVersion} 的可执行文件`,
          ``,
          `已安装版本:`,
          ...installed.map(v => `  - ${v}`),
          ``,
          `请安装对应版本或通过 --unityVersion 指定已安装的版本。`,
        ].join("\n"),
      }
    }

    const logFile = args.logFile ?? `/tmp/unity_compile_${Date.now()}.log`
    const timeout = (args.timeout ?? 180) * 1000
    const cmd = [
      `"${unityPath}"`,
      `-batchmode`,
      `-nographics`,
      `-quit`,
      `-projectPath "${args.projectPath}"`,
      `-logFile "${logFile}"`,
      `-accept-apiupdate`,
    ].join(" ")

    await ctx.bash(`${cmd} > /dev/null 2>&1 &`)
    const pollResult = await pollCompilation(logFile, timeout, args.projectPath, ctx)

    let fullLog = ""
    try {
      fullLog = await Bun.file(logFile).text()
    } catch {}

    // 检测 headless 被另一个 Editor 实例阻断的情况
    if (fullLog.includes("another Unity instance is running")) {
      return {
        error: [
          `Unity Editor 正在运行此项目，headless 编译被阻断。`,
          `请关闭 Unity Editor 后重试，或在 Editor 中手动检查 Console 的编译错误。`,
        ].join("\n"),
      }
    }

    const { errors, warnings } = parseUnityLog(fullLog)
    const duration = Date.now() - startTime
    const success = errors.length === 0 && (
      fullLog.includes("Compilation finished") ||
      fullLog.includes("Exiting batchmode without errors") ||
      (!fullLog.includes("Build FAILED") && pollResult.exitedCleanly)
    )

    const result: CompileResult = {
      success,
      exitCode: success ? 0 : 1,
      errors,
      warnings,
      duration,
      logPath: logFile,
      unityVersion: resolvedVersion,
      unityPath,
    }

    return {
      ...result,
      output: success
        ? [
            `✅ Unity 编译成功`,
            `版本: ${resolvedVersion}`,
            `耗时: ${(duration / 1000).toFixed(1)}s`,
            warnings.length > 0 ? `警告: ${warnings.length} 条` : "",
            `日志: ${logFile}`,
          ].filter(Boolean).join("\n")
        : [
            `❌ Unity 编译失败`,
            `版本: ${resolvedVersion}`,
            `耗时: ${(duration / 1000).toFixed(1)}s`,
            `错误: ${errors.length} 个`,
            ``,
            `前 5 个错误:`,
            ...errors.slice(0, 5).map(e =>
              `  ${e.file}(${e.line},${e.column}): ${e.code}: ${e.message}`
            ),
            errors.length > 5 ? `  ... 共 ${errors.length} 个错误` : "",
            `日志: ${logFile}`,
          ].filter(Boolean).join("\n"),
    }
  },
})

// ── 辅助：定位 Unity 可执行文件 ──────────────────────────────────────

async function findUnityExecutable(version: string, ctx: any): Promise<string | null> {
  const hubBase = "/Applications/Unity/Hub/Editor"

  // 精确匹配
  const exactPath = `${hubBase}/${version}/Unity.app/Contents/MacOS/Unity`
  const exactExists = await Bun.file(exactPath).exists()
  if (exactExists) return exactPath

  // 模糊匹配：提取 major.minor，查找最新安装的补丁版本
  const majorMinor = version.match(/^(\d+\.\d+)/)
  if (!majorMinor) return null

  const prefix = majorMinor[1]
  const installed = await listInstalledVersions(ctx)
  // 过滤同 major.minor 的版本，取最后一个（按字典序最大，通常对应最新补丁）
  const candidates = installed
    .filter(v => v.startsWith(prefix))
    .sort()
  const bestMatch = candidates[candidates.length - 1]

  if (!bestMatch) return null

  const fuzzyPath = `${hubBase}/${bestMatch}/Unity.app/Contents/MacOS/Unity`
  const fuzzyExists = await Bun.file(fuzzyPath).exists()
  return fuzzyExists ? fuzzyPath : null
}

async function listInstalledVersions(ctx: any): Promise<string[]> {
  try {
    const result = await ctx.bash(`ls /Applications/Unity/Hub/Editor/ 2>/dev/null`)
    return result.trim().split("\n").filter(Boolean)
  } catch {
    return []
  }
}

// 检测 Unity Editor 是否正在运行指定项目
// 通过项目目录下的 Temp/UnityLockfile 判断（Editor 运行时会持有此锁文件）
async function isEditorRunningProject(projectPath: string, ctx: any): Promise<boolean> {
  // 方法1：检查锁文件
  const lockFile = path.join(projectPath, "Temp", "UnityLockfile")
  try {
    await Bun.file(lockFile).text()
    // 锁文件存在，再确认进程是否真的在运行
    const pid = await ctx.bash(`pgrep -f "Unity" | head -1 2>/dev/null || echo ""`)
    return pid.trim().length > 0
  } catch {
    // 锁文件不存在
  }

  // 方法2：检查 Unity 进程中是否有该项目路径
  try {
    const result = await ctx.bash(
      `pgrep -lf "Unity" 2>/dev/null | grep -v "batchmode\|headless" | head -1 || echo ""`
    )
    if (!result.trim()) return false
    // Unity Editor 在运行，检查它打开的是不是这个项目
    const projectName = path.basename(projectPath)
    const checkResult = await ctx.bash(
      `pgrep -lf "Unity.*${projectName}" 2>/dev/null | head -1 || echo ""`
    )
    return checkResult.trim().length > 0
  } catch {
    return false
  }
}

// ── 辅助：轮询等待编译完成 ───────────────────────────────────────────

async function pollCompilation(
  logFile: string,
  timeout: number,
  projectPath: string,
  ctx: any,
): Promise<{ exitedCleanly: boolean }> {
  const startTime = Date.now()
  let lastSize = 0

  // 获取进程名（用于检测 Unity 是否还在运行）
  const projectName = path.basename(projectPath)

  while (Date.now() - startTime < timeout) {
    await Bun.sleep(3000)

    // 读取日志新增内容
    let logContent = ""
    try {
      logContent = await Bun.file(logFile).text()
    } catch {
      // 日志还不存在，继续等待
      continue
    }

    const newContent = logContent.slice(lastSize)
    lastSize = logContent.length

    // 检测编译完成信号
    if (
      newContent.includes("Exiting batchmode") ||
      newContent.includes("Exiting without errors") ||
      logContent.includes("Build FAILED")
    ) {
      return { exitedCleanly: true }
    }

    // 检测 Unity 进程是否还在运行
    const isRunning = await ctx.bash(
      `pgrep -f "Unity.*batchmode" | head -1 2>/dev/null || echo ""`
    )
    if (!isRunning.trim() && lastSize > 0) {
      // 进程结束了
      return { exitedCleanly: true }
    }
  }

  // 超时：尝试终止 Unity 进程
  await ctx.bash(`pkill -f "Unity.*batchmode" 2>/dev/null || true`)
  return { exitedCleanly: false }
}

// ── 辅助：解析 Unity 编译日志 ────────────────────────────────────────

function parseUnityLog(logContent: string): { errors: CompileError[]; warnings: CompileWarning[] } {
  const errors: CompileError[] = []
  const warnings: CompileWarning[] = []

  // Unity 错误格式: "Assets/Scripts/Foo.cs(10,5): error CS0246: The type..."
  // 也支持 "Assets\Scripts\Foo.cs(10,5): error CS0246:"（Windows 路径分隔符）
  const errorPattern = /^(Assets[/\\][^(]+)\((\d+),(\d+)\):\s*error\s+(CS\d+):\s*(.+)$/gm
  const warnPattern  = /^(Assets[/\\][^(]+)\((\d+),(\d+)\):\s*warning\s+(CS\d+):\s*(.+)$/gm

  for (const match of logContent.matchAll(errorPattern)) {
    errors.push({
      file: match[1].replace(/\\/g, "/"),
      line: parseInt(match[2]),
      column: parseInt(match[3]),
      code: match[4],
      message: match[5].trim(),
    })
  }

  for (const match of logContent.matchAll(warnPattern)) {
    warnings.push({
      file: match[1].replace(/\\/g, "/"),
      line: parseInt(match[2]),
      message: match[5].trim(),
    })
  }

  return { errors, warnings }
}
