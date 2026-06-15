import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"
import { createHash } from "crypto"

/**
 * Unity 第三方 DLL 提取工具（Stage 6）
 *
 * 解决 missing_dll BLOCKED：把第三方/闭源 SDK 的 DummyDll 作为**真实引用 DLL**
 * 放入 target_project 的 Assets/Plugins/，让引用它们的游戏代码编译通过。
 *
 * 关键认知（IL2CPP 本质）：
 * - IL2CPP 游戏的托管代码已编译进 libil2cpp.so，Managed/ 目录无真实托管 DLL。
 * - Il2CppDumper 生成的 DummyDll 是带**完整类型签名**（字段/方法签名/继承）的桩 DLL，
 *   方法体为空但类型信息完整——这正是"让引用代码编译通过"所需的全部。
 * - 因此对第三方 SDK（AppsFlyer/LevelPlay/Firebase 等），DummyDll 即真实引用 DLL。
 *   这**不是**空 stub 类（符合零降级：提供的是带完整签名的真实类型）。
 *
 * 排除项：Assembly-CSharp.dll（游戏自身代码，由代码生成重建，不作为 DLL 引入）、
 * UnityEngine.* / System.* / mscorlib（Unity/运行时自带，引入会冲突）。
 *
 * 精确提取策略：
 * - 提供 scriptsDir 时，扫描所有 .cs 文件的 using 指令，
 *   只提取命名空间前缀匹配的 DLL，彻底排除无关 SDK。
 * - 不提供 scriptsDir 时退回到全量提取（不推荐）。
 *
 * meta 文件策略（Any: enabled: 0 + Editor: enabled: 1）：
 * - DummyDll 是 IL2CPP stripped 版本，放入 Plugins 后只能用于编译引用，
 *   不能在 Editor 运行时加载（否则 TypeLoadException → Play 崩溃）。
 * - Any: enabled: 0  → 不在任何平台运行时加载
 * - Editor: enabled: 1 → 仅 Editor 编译时作为引用（解决 CS0246）
 */

// 不应作为 Plugin 引入的 DLL（Unity 引擎/运行时自带，或游戏自身代码）
const EXCLUDE_DLL =
  /^(Assembly-CSharp|Assembly-CSharp-firstpass|Il2CppDummyDll|mscorlib|System(\.|$)|Mono\.|netstandard|UnityEngine|UnityEditor|Unity\.Services|Unity\.InputSystem|Unity\.TextMeshPro|Unity\.RenderPipelines|Unity\.2D|Unity\.Timeline|Unity\.Burst|Unity\.Mathematics|Unity\.Collections)/

export default tool({
  description:
    "从 DummyDll 提取第三方/闭源 SDK 的真实引用 DLL 到 Assets/Plugins/，解决 missing_dll 编译阻塞（Stage 6）",

  args: {
    dummyDllPath: tool.schema.string().describe("Il2CppDumper 生成的 DummyDll 目录"),
    targetProjectPath: tool.schema.string().describe("目标 Unity 工程路径"),
    scriptsDir: tool.schema
      .string()
      .optional()
      .describe("生成的 C# 脚本目录（提供后扫描 using 指令，只提取实际引用的 DLL，强烈推荐）"),
    onlyClasses: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("仅提取指定名称的 DLL（如 [\"AppsFlyer\", \"Unity.LevelPlay\"]）；scriptsDir 和 onlyClasses 同时提供时取交集"),
    dryRun: tool.schema.boolean().optional().describe("仅预览不复制"),
  },

  async execute(args) {
    const dummyDir = path.resolve(args.dummyDllPath)
    const proj = path.resolve(args.targetProjectPath)
    const pluginsDir = path.join(proj, "Assets", "Plugins")

    if (!(await exists(dummyDir))) {
      return blocked(`DummyDll 目录不存在: ${dummyDir}`)
    }

    const allDlls = (await fs.readdir(dummyDir)).filter((f) => f.endsWith(".dll"))
    const thirdParty = allDlls.filter((f) => !EXCLUDE_DLL.test(path.basename(f, ".dll")))

    // 扫描脚本 using 指令，建立命名空间前缀集合
    let referencedPrefixes: Set<string> | null = null
    if (args.scriptsDir) {
      const scriptsPath = path.resolve(args.scriptsDir)
      if (await exists(scriptsPath)) {
        referencedPrefixes = await scanUsingNamespaces(scriptsPath)
      }
    }

    // DLL名→命名空间根的已知映射（DLL名与命名空间不一致时的补充）
    const DLL_TO_NS_OVERRIDE: Record<string, string> = {
      "UniTask": "Cysharp",
      "UniTask.DOTween": "Cysharp",
      "Il2CppDummyDll": "Il2CppDummyDll", // 基础依赖，始终保留
    }

    // 按需过滤
    let targets = thirdParty
    if (referencedPrefixes) {
      targets = thirdParty.filter((f) => {
        const dllName = path.basename(f, ".dll")
        // 优先查映射表，否则用 DLL 名的第一段作为命名空间根
        const nsRoot = DLL_TO_NS_OVERRIDE[dllName] ?? dllName.split(".")[0]
        return [...referencedPrefixes!].some((ns) =>
          ns === nsRoot || ns.startsWith(nsRoot + ".") || nsRoot.startsWith(ns + ".")
        )
      })
    }
    if (args.onlyClasses) {
      targets = targets.filter((f) =>
        args.onlyClasses!.some((c) => path.basename(f, ".dll").toLowerCase() === c.toLowerCase()),
      )
    }

    if (targets.length === 0) {
      return {
        output: `无第三方 SDK DLL 需要提取（候选: ${thirdParty.length} 个，脚本未引用任何）`,
        metadata: { success: true, extracted: [], skipped: allDlls.length },
      }
    }

    if (args.dryRun) {
      const skipped = thirdParty.filter((f) => !targets.includes(f))
      return {
        output: [
          `[DRY RUN] 将提取 ${targets.length} 个 DLL（脚本实际引用）:`,
          ...targets.map((d) => "  + " + d),
          skipped.length > 0 ? `\n跳过 ${skipped.length} 个（脚本未引用）:` : "",
          ...skipped.slice(0, 10).map((d) => "  - " + d),
          skipped.length > 10 ? `  ... 还有 ${skipped.length - 10} 个` : "",
        ].filter(Boolean).join("\n"),
        metadata: { success: true, would_extract: targets, would_skip: skipped },
      }
    }

    // 必须连带提取 DummyDll 的基础依赖 Il2CppDummyDll.dll，
    // 否则 AppsFlyer/LevelPlay 等会因 "Unable to resolve reference 'Il2CppDummyDll'" 无法加载。
    const finalTargets = [...targets]
    const il2cppDummy = allDlls.find((f) => f === "Il2CppDummyDll.dll")
    if (il2cppDummy && !finalTargets.includes(il2cppDummy)) {
      finalTargets.push(il2cppDummy)
    }

    await fs.mkdir(pluginsDir, { recursive: true })
    const extracted: string[] = []
    for (const dll of finalTargets) {
      const src = path.join(dummyDir, dll)
      const dst = path.join(pluginsDir, dll)
      await fs.copyFile(src, dst)
      await fs.writeFile(dst + ".meta", pluginMeta(dll))
      extracted.push(dll)
    }

    const skipped = thirdParty.filter((f) => !targets.includes(f) && f !== "Il2CppDummyDll.dll")
    return {
      output: [
        `✅ 提取 ${extracted.length} 个真实引用 DLL 到 Assets/Plugins/`,
        `   meta 策略：Any: enabled: 0（不在 Editor 运行时加载）+ Editor: enabled: 1（编译引用）`,
        ...extracted.map((d) => "  + " + d),
        skipped.length > 0 ? `\n跳过 ${skipped.length} 个（脚本未引用，不放入 Plugins）:` : "",
        ...skipped.slice(0, 10).map((d) => "  - " + d),
        skipped.length > 10 ? `  ... 还有 ${skipped.length - 10} 个` : "",
      ].filter(Boolean).join("\n"),
      metadata: { success: true, extracted, skipped, plugins_dir: pluginsDir },
    }
  },
})

// 生成托管插件 .meta
// IL2CPP DummyDll 策略：只作为编译引用，不在 Editor 运行时加载
//   Any: enabled: 0     → 不在任何平台运行时加载（防止 TypeLoadException → Play 崩溃）
//   Editor: enabled: 1  → Editor 编译时作为引用（防止 CS0246 缺失类型错误）
function pluginMeta(dllName: string): string {
  const guid = createHash("md5").update("plugin:" + dllName).digest("hex").slice(0, 32)
  return `fileFormatVersion: 2
guid: ${guid}
PluginImporter:
  externalObjects: {}
  serializedVersion: 2
  iconMap: {}
  executionOrder: {}
  defineConstraints: []
  isPreloaded: 0
  isOverridable: 0
  isExplicitlyReferenced: 0
  validateReferences: 1
  platformData:
  - first:
      Any:
    second:
      enabled: 0
      settings: {}
  - first:
      Editor: Editor
    second:
      enabled: 1
      settings:
        DefaultValueInitialized: true
  userData:
  assetBundleName:
  assetBundleVariant:
`
}

// 扫描 scriptsDir 下所有 .cs 文件的 using 指令，返回命名空间根前缀集合
// 例：using Cysharp.Threading.Tasks → 加入 "Cysharp"
async function scanUsingNamespaces(scriptsDir: string): Promise<Set<string>> {
  const prefixes = new Set<string>()
  const stack = [scriptsDir]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: string[]
    try { entries = await fs.readdir(dir) } catch { continue }
    for (const entry of entries) {
      const full = path.join(dir, entry)
      if (entry.endsWith(".cs")) {
        try {
          const content = await fs.readFile(full, "utf8")
          for (const m of content.matchAll(/^using ([\w.]+);/gm)) {
            prefixes.add(m[1].split(".")[0])
          }
        } catch { /* skip unreadable */ }
      } else if (!entry.startsWith(".")) {
        try {
          const stat = await fs.stat(full)
          if (stat.isDirectory()) stack.push(full)
        } catch { /* skip */ }
      }
    }
  }
  return prefixes
}

function blocked(reason: string) {
  return { output: `⛔ BLOCKED: ${reason}`, metadata: { success: false, blocked: true, reason } }
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false)
}
