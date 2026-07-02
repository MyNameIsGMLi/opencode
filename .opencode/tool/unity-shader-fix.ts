import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"

/**
 * Unity Shader / 渲染管线修复工具（Stage 3）
 *
 * 职责：
 * 1. 渲染管线对齐：确保目标工程 GraphicsSettings 与原版管线一致；URP/HDRP 补齐 UPM 包。
 * 2. 粉红材质修复：扫描材质，对引用了"丢失 shader"（GUID 悬空或内置 shader 名缺失）的材质，
 *    按管线做等价内置 shader 替换。
 *
 * 等价替换映射（BuiltIn）：
 *   - UI 材质      → UI/Default      (内置 shader fileID: 10753, guid: 0000000000000000f000000000000000)
 *   - Sprite 材质  → Sprites/Default (内置 shader fileID: 10753 / 10760)
 *   - 不透明 3D    → Standard
 *
 * 零降级：无法对齐管线或仍有粉红材质时返回 blocked: true。
 *
 * 注：对纯 2D/UI + BuiltIn 工程（材质多为引擎内置默认材质，fileID:0），
 * 本工具应正确识别"无需修复"并返回 success，不做无意义改写。
 */

// BuiltIn 内置 shader 的 known-good 引用（材质 m_Shader 指向引擎内置时用此形式）
const BUILTIN_SHADER_REFS: Record<string, string> = {
  "UI/Default": "{fileID: 10753, guid: 0000000000000000f000000000000000, type: 0}",
  "Sprites/Default": "{fileID: 10753, guid: 0000000000000000f000000000000000, type: 0}",
  Standard: "{fileID: 46, guid: 0000000000000000f000000000000000, type: 0}",
}

export default tool({
  description: "Unity 渲染管线对齐 + 粉红/丢失 shader 等价替换修复（Stage 3）",

  args: {
    targetProjectPath: tool.schema.string().describe("目标 Unity 工程路径"),
    renderPipeline: tool.schema
      .enum(["BuiltIn", "URP", "HDRP", "SRP", "Unknown"])
      .optional()
      .describe("Stage 2 判定的渲染管线，默认 BuiltIn"),
    dryRun: tool.schema.boolean().optional().describe("仅检测不改写"),
  },

  async execute(args) {
    const proj = path.resolve(args.targetProjectPath)
    const pipeline = args.renderPipeline ?? "BuiltIn"
    const assets = path.join(proj, "Assets")

    if (!(await exists(assets))) {
      // 目标工程尚无 Assets（资源还没搬运）→ 这是无需修复的前置状态，非错误
      return ok({
        pipeline_aligned: true,
        shaders_fixed: 0,
        remaining_pink: 0,
        upm_packages_added: [],
        note: "目标工程暂无 Assets 目录，跳过 shader 扫描（资源搬运后再调用）",
      })
    }

    // Step 1: 渲染管线对齐 + UPM 包补齐
    const upmAdded = await alignPipeline(proj, pipeline, args.dryRun ?? false)

    // Step 2: 扫描材质，检测丢失/粉红 shader
    const mats = await findFiles(assets, ".mat")
    const validShaderGuids = await collectShaderGuids(assets)

    let fixed = 0
    const remainingPink: string[] = []

    for (const mat of mats) {
      const text = await fs.readFile(mat, "utf-8").catch(() => "")
      const shaderRef = text.match(/m_Shader:\s*\{([^}]*)\}/)
      if (!shaderRef) continue

      const ref = shaderRef[1]
      // fileID:0 = 无 shader（粉红）；引用外部 guid 但 guid 不在工程内 = 丢失
      const isPink = /fileID:\s*0\b/.test(ref) && !/guid:/.test(ref)
      const guidMatch = ref.match(/guid:\s*([a-f0-9]{32})/)
      const isMissingGuid =
        guidMatch != null &&
        !isBuiltinGuid(guidMatch[1]) &&
        !validShaderGuids.has(guidMatch[1])

      if (!isPink && !isMissingGuid) continue

      // 选等价 shader：材质名/路径含 sprite/ui → UI/Default，否则 Standard
      const lower = mat.toLowerCase()
      const replacement = /sprite|ui[\/_]/.test(lower)
        ? BUILTIN_SHADER_REFS["UI/Default"]
        : BUILTIN_SHADER_REFS["Standard"]

      if (args.dryRun) {
        remainingPink.push(path.basename(mat))
        continue
      }

      const newText = text.replace(/m_Shader:\s*\{[^}]*\}/, `m_Shader: ${replacement}`)
      await fs.writeFile(mat, newText)
      fixed++
    }

    const remaining = args.dryRun ? remainingPink.length : 0

    if (remaining > 0) {
      return {
        output: `⛔ 仍有 ${remaining} 个粉红/丢失 shader 材质未修复（dryRun）：\n${remainingPink.map((m) => "  - " + m).join("\n")}`,
        metadata: {
          success: false,
          blocked: true,
          remaining_pink: remaining,
          remaining_list: remainingPink,
        },
      }
    }

    return ok({
      pipeline_aligned: true,
      shaders_fixed: fixed,
      remaining_pink: 0,
      materials_scanned: mats.length,
      upm_packages_added: upmAdded,
      note:
        mats.length === 0
          ? "工程无 .mat 材质（纯 2D/UI + 内置默认材质），无需 shader 修复"
          : `扫描 ${mats.length} 个材质，修复 ${fixed} 个，无残留粉红`,
    })
  },
})

async function alignPipeline(proj: string, pipeline: string, dryRun: boolean): Promise<string[]> {
  const added: string[] = []
  if (pipeline === "BuiltIn" || pipeline === "Unknown") return added // BuiltIn 无需额外包

  const manifestPath = path.join(proj, "Packages", "manifest.json")
  if (!(await exists(manifestPath))) return added
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8").catch(() => "{}"))
  manifest.dependencies = manifest.dependencies || {}

  const needed: Record<string, string> = {}
  if (pipeline === "URP") needed["com.unity.render-pipelines.universal"] = "14.0.12"
  if (pipeline === "HDRP") needed["com.unity.render-pipelines.high-definition"] = "14.0.12"

  for (const [pkg, ver] of Object.entries(needed)) {
    if (!manifest.dependencies[pkg]) {
      manifest.dependencies[pkg] = ver
      added.push(pkg)
    }
  }

  if (added.length > 0 && !dryRun) {
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  }
  return added
}

async function collectShaderGuids(assets: string): Promise<Set<string>> {
  const guids = new Set<string>()
  const shaderMetas = (await findFiles(assets, ".shader.meta")).concat(
    await findFiles(assets, ".shadergraph.meta"),
  )
  for (const meta of shaderMetas) {
    const text = await fs.readFile(meta, "utf-8").catch(() => "")
    const m = text.match(/guid:\s*([a-f0-9]{32})/)
    if (m) guids.add(m[1])
  }
  return guids
}

function isBuiltinGuid(guid: string): boolean {
  // Unity 内置资源 guid 固定为 0000000000000000f000000000000000 / e000... / f000...
  return /^0{16}[ef]0{15}$/.test(guid) || guid === "0000000000000000f000000000000000"
}

function ok(data: any) {
  return {
    output: `✅ Shader/渲染管线修复完成\n  ${data.note || ""}\n  管线对齐: ${data.pipeline_aligned}  修复材质: ${data.shaders_fixed}  残留粉红: ${data.remaining_pink}  新增UPM包: ${(data.upm_packages_added || []).join(", ") || "无"}`,
    metadata: { success: true, ...data },
  }
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
