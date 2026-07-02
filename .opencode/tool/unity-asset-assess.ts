import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"

/**
 * Unity 资源质检 + 渲染管线判定工具（Stage 2 Go/No-Go 检查点）
 *
 * 在 AssetRipper 导出后扫描产物，输出 GO / NO-GO 决策。
 * 零降级：质检不通过返回 assessment="NO-GO"，由主 Agent 据此 BLOCKED。
 *
 * 核心判定逻辑（从 Brick Stack Master 真实案例提炼）：
 * - 渲染管线：读 GraphicsSettings.asset 的 m_CustomRenderPipeline 判定 BuiltIn/URP/HDRP
 * - 材质质检：必须按渲染器类型分类。CanvasRenderer/UI 的 m_Material:{fileID:0} 是
 *   引擎内置默认材质，正常；只有 MeshRenderer/SpriteRenderer 引用了不存在的 .mat
 *   才算粉红风险。纯 2D/UI 游戏材质数=0 是正常形态，不能据此判 NO-GO。
 */
export default tool({
  description: "Unity AssetRipper 导出产物质检 + 渲染管线判定，输出 Stage 2 Go/No-Go 决策",

  args: {
    sourceExportPath: tool.schema.string().describe("AssetRipper 导出根目录（含 ExportedProject）"),
  },

  async execute(args) {
    const root = path.resolve(args.sourceExportPath)
    const proj = (await exists(path.join(root, "ExportedProject")))
      ? path.join(root, "ExportedProject")
      : root
    const assets = path.join(proj, "Assets")

    if (!(await exists(assets))) {
      return blocked("导出产物缺失 Assets 目录", { proj })
    }

    const scenes = await findFiles(assets, ".unity")
    const prefabs = await findFiles(assets, ".prefab")
    const materials = await findFiles(assets, ".mat")
    const textures = await findFiles(assets, ".png")
    const sprites = (await findFiles(assets, ".asset")).filter((f) => /sprite/i.test(f))
    const scripts = await findFiles(assets, ".cs")
    const anims = await findFiles(assets, ".anim")

    const renderPipeline = await detectRenderPipeline(proj)
    const sceneAnalysis = await analyzeScenes(scenes)

    // 零降级硬判定
    const issues: string[] = []
    if (scenes.length === 0) issues.push("无任何场景文件（.unity）导出")
    if (prefabs.length === 0 && sceneAnalysis.totalGameObjects === 0)
      issues.push("无 Prefab 且场景无 GameObject，资源严重损坏")
    if (!sceneAnalysis.fieldsPopulated)
      issues.push("场景 MonoBehaviour 字段疑似全空（DummyDll 未生效）")

    // 材质质检：按渲染器类型分类，区分"真粉红风险"与"UI 默认材质（正常）"
    const pinkRisk = sceneAnalysis.meshRendererMaterialRefs > 0 && materials.length === 0

    if (pinkRisk)
      issues.push(
        `场景含 ${sceneAnalysis.meshRendererMaterialRefs} 个 MeshRenderer 材质引用但工程 0 个 .mat，存在粉红材质风险`,
      )

    const assessment = issues.length === 0 ? "GO" : "NO-GO"

    const report = {
      assessment,
      render_pipeline: renderPipeline,
      scenes_count: scenes.length,
      scenes: scenes.map((s) => path.relative(assets, s)),
      prefabs_count: prefabs.length,
      materials_count: materials.length,
      textures_count: textures.length,
      sprites_count: sprites.length,
      scripts_count: scripts.length,
      anims_count: anims.length,
      total_gameobjects: sceneAnalysis.totalGameObjects,
      renderer_breakdown: sceneAnalysis.rendererBreakdown,
      mesh_renderer_material_refs: sceneAnalysis.meshRendererMaterialRefs,
      ui_default_material_refs: sceneAnalysis.uiDefaultMaterialRefs,
      pink_material_risk: pinkRisk,
      fields_populated: sceneAnalysis.fieldsPopulated,
      issues,
    }

    const summary = renderReport(report)
    return {
      output: summary,
      metadata: { success: assessment === "GO", blocked: assessment === "NO-GO", ...report },
    }
  },
})

async function detectRenderPipeline(proj: string): Promise<string> {
  const gs = path.join(proj, "ProjectSettings", "GraphicsSettings.asset")
  if (!(await exists(gs))) return "Unknown"
  const text = await fs.readFile(gs, "utf-8").catch(() => "")
  // m_CustomRenderPipeline: {fileID: 0} → Built-in；非 0 → SRP（URP/HDRP）
  const m = text.match(/m_CustomRenderPipeline:\s*\{fileID:\s*(-?\d+)/)
  if (!m || m[1] === "0") return "BuiltIn"
  // 进一步靠 Packages 判断 URP/HDRP
  const pkgManifest = path.join(proj, "Packages", "manifest.json")
  const pkg = await fs.readFile(pkgManifest, "utf-8").catch(() => "")
  if (/render-pipelines\.high-definition/.test(pkg)) return "HDRP"
  if (/render-pipelines\.universal/.test(pkg)) return "URP"
  return "SRP"
}

async function analyzeScenes(scenes: string[]) {
  let totalGameObjects = 0
  let meshRendererMaterialRefs = 0
  let uiDefaultMaterialRefs = 0
  let monoBehaviourCount = 0
  let nonTrivialFieldLines = 0
  const rendererBreakdown: Record<string, number> = {}

  for (const scene of scenes) {
    const text = await fs.readFile(scene, "utf-8").catch(() => "")
    totalGameObjects += (text.match(/^GameObject:/gm) || []).length
    monoBehaviourCount += (text.match(/^MonoBehaviour:/gm) || []).length

    for (const r of ["SpriteRenderer", "MeshRenderer", "CanvasRenderer", "LineRenderer"]) {
      const c = (text.match(new RegExp(r, "g")) || []).length
      if (c > 0) rendererBreakdown[r] = (rendererBreakdown[r] || 0) + c
    }

    // m_Materials: 数组（MeshRenderer/SpriteRenderer 的真实材质引用）
    meshRendererMaterialRefs += (text.match(/m_Materials:\s*\n\s*-\s*\{fileID:\s*[1-9]/g) || []).length
    // UI 默认材质 m_Material: {fileID: 0}（CanvasRenderer/Graphic 正常用法）
    uiDefaultMaterialRefs += (text.match(/m_Material:\s*\{fileID:\s*0\}/g) || []).length

    // 字段填充启发式：统计非空标量字段行（MonoBehaviour 反序列化成功的标志）
    nonTrivialFieldLines += (text.match(/^\s{2,}m_[A-Za-z]+:\s*\S/gm) || []).length
  }

  // 字段填充判定：有 MonoBehaviour 且平均每个有足够非空字段行
  const fieldsPopulated = monoBehaviourCount === 0 || nonTrivialFieldLines / Math.max(monoBehaviourCount, 1) >= 2

  return {
    totalGameObjects,
    meshRendererMaterialRefs,
    uiDefaultMaterialRefs,
    rendererBreakdown,
    fieldsPopulated,
  }
}

function renderReport(r: any): string {
  const mark = r.assessment === "GO" ? "✅ GO" : "⛔ NO-GO"
  return `${mark} — AssetRipper 资源质检（Stage 2）

渲染管线：${r.render_pipeline}
场景：${r.scenes_count} 个 [${r.scenes.join(", ")}]
GameObject 总数：${r.total_gameobjects}
Prefab：${r.prefabs_count}  脚本：${r.scripts_count}  动画：${r.anims_count}
贴图：${r.textures_count}  Sprite：${r.sprites_count}  材质(.mat)：${r.materials_count}

渲染器分布：${JSON.stringify(r.renderer_breakdown)}
3D材质引用(MeshRenderer)：${r.mesh_renderer_material_refs}  UI默认材质引用：${r.ui_default_material_refs}
粉红材质风险：${r.pink_material_risk ? "是 ⚠️" : "否"}
字段填充：${r.fields_populated ? "正常" : "疑似全空 ⚠️"}

${r.issues.length ? "阻塞问题：\n" + r.issues.map((i: string) => "  - " + i).join("\n") : "无阻塞问题，可进入 Stage 3。"}`
}

function blocked(reason: string, extra: any) {
  return {
    output: `⛔ NO-GO — ${reason}`,
    metadata: { success: false, blocked: true, assessment: "NO-GO", reason, ...extra },
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
