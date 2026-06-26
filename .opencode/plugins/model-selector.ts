/**
 * model-selector — 单职责模型路由 plugin
 *
 * 仅在 build（默认）agent 下生效。
 * 根据任务内容的信号特征选择最匹配的模型。
 *
 * 边界保护：
 *   1. 开关：实时读取 global config，关闭时跳过
 *   2. 短输入（≤5词）：继承上一轮模型，不覆盖
 *   3. 连续失败：检测到错误关键词时逐级升 tier，最高升到 D
 */
import type { PluginInput, Hooks } from "@opencode-ai/plugin"
import { readFile } from "fs/promises"
import { existsSync } from "fs"

// ── Tier 顺序（用于逐级升级）────────────────────────────────────────────────
const TIER_ORDER = ["A", "B", "C", "D"] as const
type TierKey = "A" | "B" | "C" | "D" | "REASON" | "LONG"

// ── 模型候选表 ──────────────────────────────────────────────────────────────
const TIERS: Record<TierKey, readonly string[]> = {
  // A: 极轻量工具类 — 标题、注释、格式化、摘要
  A: [
    "google/gemini-flash-lite-latest", // $0.1/$0.4  1M ctx
    "google/gemini-2.5-flash-lite",    // $0.1/$0.4  1M ctx
    "google/gemini-2.5-flash",         // $0.3/$2.5  1M ctx（兜底）
  ],

  // B: 性价比主力类 — 日常编码、小改动、代码解释
  B: [
    "google/gemini-2.5-flash",         // $0.3/$2.5  1M ctx
    "google/gemini-3-flash-preview",   // $0.5/$3    1M ctx
    "xai/grok-4-fast",                 // $0.2/$0.5  2M ctx
  ],

  // C: 高质量均衡类 — 复杂功能实现、code review
  C: [
    "anthropic/claude-sonnet-4-6",     // $3/$15   1M ctx  编码最强
    "google/gemini-2.5-pro",           // $1.25/$10 1M ctx
    "anthropic/claude-sonnet-4-5",     // $3/$15   200K
    "xai/grok-4",                      // $3/$15   1M ctx
  ],

  // D: 旗舰推理类 — 架构设计、超难 bug、多步深度推理
  D: [
    "anthropic/claude-opus-4-8",       // $5/$25   1M ctx  顶级编码
    "anthropic/claude-opus-4-7",       // $5/$25   1M ctx
    "anthropic/claude-fable-5",        // $10/$50  1M ctx  最强
    "xai/grok-4",                      // $3/$15   1M ctx（价格更低的旗舰备选）
  ],

  // REASON: 纯算法/数学推理专项
  REASON: [
    "anthropic/claude-opus-4-8",       // $5/$25   1M ctx
    "xai/grok-4",                      // $3/$15   1M ctx
    "google/gemini-2.5-pro",           // $1.25/$10 1M ctx
    "anthropic/claude-sonnet-4-6",     // $3/$15   1M ctx
  ],

  // LONG: 超长上下文专项 (>80K tokens)
  LONG: [
    "google/gemini-2.5-pro",           // $1.25/$10 1M ctx  最大上下文
    "anthropic/claude-sonnet-4-6",     // $3/$15   1M ctx
    "anthropic/claude-opus-4-8",       // $5/$25   1M ctx
    "xai/grok-4-fast",                 // $0.2/$0.5  2M ctx
  ],
}

// ── 信号检测 ──────────────────────────────────────────────────────────────
const SIGNALS = {
  // 极简任务（匹配开头或完整句子）
  trivial:
    /(^|\s)(加注释|add\s+comments?|格式化|format(\s+this)?|rename\s+\w|重命名|fix\s+typo|翻译[：:])/i,

  // 工具性任务（摘要/标题）
  utility:
    /^(总结|摘要|summary|summarize|标题|title|简述|tl;?dr)/i,

  // 纯算法推理
  algorithm:
    /(算法|时间复杂度|空间复杂度|数学证明|最优解|O\([nkm\d]\)|动态规划|图算法|graph\s+algorithm|NP.?(hard|complete)|最短路|最长公共子|knapsack|背包问题|二分查找|divide\s+and\s+conquer)/i,

  // 深度架构/设计
  architecture:
    /(架构设计|系统设计|如何设计|如何实现.{0,20}(系统|服务|平台|框架)|整体方案|技术选型|分布式|高可用|microservice|scalab)/i,

  // 高难度调试
  hard:
    /(race\s+condition|死锁|deadlock|内存泄漏|memory\s+leak|性能瓶颈|bottleneck|根本原因|root\s+cause|heap\s+(dump|corruption)|segfault|undefined\s+behavior)/i,

  // 编译/类型错误（用于连续失败检测）— 英文 tsc 输出 + 中文描述
  compileError:
    /(error TS\d+|is not assignable|cannot find (name|module)|type.*is not|does not exist on type|no overload matches|argument of type|expected \d+ arguments|类型错误|编译错误|类型不匹配|找不到名称|找不到模块)/i,
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────
function getText(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join(" ")
    .trim()
}

function estimateTokens(parts: Array<{ type: string; text?: string }>): number {
  let chars = 0
  for (const p of parts) {
    if (p.type === "text") chars += p.text?.length ?? 0
    if (p.type === "file") chars += 12000
  }
  return Math.ceil(chars / 4)
}

function hasVisualAttachment(parts: Array<{ type: string; mediaType?: string }>): boolean {
  return parts.some(
    (p) => p.type === "file" && (p.mediaType?.startsWith("image/") || p.mediaType?.startsWith("video/")),
  )
}

function selectTier(text: string, tokens: number, hasVisual: boolean): TierKey {
  if (tokens > 80000) return "LONG"
  if (SIGNALS.algorithm.test(text)) return "REASON"
  if (SIGNALS.architecture.test(text) || SIGNALS.hard.test(text)) return "D"
  if (tokens < 1500 && (SIGNALS.trivial.test(text) || SIGNALS.utility.test(text))) return "A"
  if (tokens < 1000 && !hasVisual) return "B"
  if (tokens < 8000) return "C"
  return "C"
}

// 将 tier 逐级升一档（REASON/LONG 不参与升级链）
function upgradeTier(tier: TierKey): TierKey {
  const idx = TIER_ORDER.indexOf(tier as typeof TIER_ORDER[number])
  if (idx === -1) return tier // REASON/LONG 不升级
  const next = TIER_ORDER[Math.min(idx + 1, TIER_ORDER.length - 1)]
  return next
}

function pickModel(tier: TierKey, currentProvider?: string): { providerID: string; modelID: string } | undefined {
  const candidates = TIERS[tier]
  const preferred = currentProvider
    ? candidates.find((c) => c.startsWith(currentProvider + "/"))
    : undefined
  const chosen = preferred ?? candidates[0]
  if (!chosen) return undefined
  const slashIdx = chosen.indexOf("/")
  return {
    providerID: chosen.slice(0, slashIdx),
    modelID: chosen.slice(slashIdx + 1),
  }
}

// ── 会话状态（内存，进程生命周期内有效）──────────────────────────────────────
// key: sessionID, value: { tier: 上一轮实际使用的 tier, failCount: 连续错误次数 }
const sessionState = new Map<string, { tier: TierKey; failCount: number }>()

// ── Plugin 主体 ──────────────────────────────────────────────────────────────
const server = async (input: PluginInput): Promise<Hooks> => {
  return {
    "chat.message": async (incoming, output) => {
      // ① 直接读取全局配置文件，绕过所有缓存
      const configCandidates = ["opencode.jsonc", "opencode.json", "config.json"].map(
        (f) => `${process.env.HOME}/.config/opencode/${f}`,
      )
      let modelSelectorEnabled = false
      for (const filepath of configCandidates) {
        if (existsSync(filepath)) {
          try {
            const text = await readFile(filepath, "utf-8")
            const json = JSON.parse(text.replace(/\/\/[^\n]*/g, "").replace(/,\s*([}\]])/g, "$1"))
            modelSelectorEnabled = json.model_selector_enabled === true
          } catch {}
          break
        }
      }
      if (!modelSelectorEnabled) return

      // ② 只在 build（默认）agent 下生效
      if (incoming.agent && incoming.agent !== "build") return

      const parts = (output.parts ?? []) as Array<{ type: string; text?: string; mediaType?: string }>
      const text = getText(parts)
      if (!text) return

      // ③ 短输入：继承上一轮模型，不覆盖
      // 例外：消息含编译错误关键词时不跳过（用户粘贴了错误信息）
      const hasError = SIGNALS.compileError.test(text)
      if (!hasError) {
        const wordCount = text.split(/\s+/).filter(Boolean).length
        const charCount = text.replace(/\s/g, "").length
        const isChinese = /[\u4e00-\u9fff]/.test(text)
        const isShort = isChinese ? charCount <= 10 : wordCount <= 5
        if (isShort) return
      }

      const tokens = estimateTokens(parts)
      const hasVisual = hasVisualAttachment(parts)
      const sessionID = incoming.sessionID

      // ④ 连续失败检测：消息中包含编译错误关键词时，逐级升 tier
      const state = sessionState.get(sessionID) ?? { tier: "B", failCount: 0 }

      let baseTier = selectTier(text, tokens, hasVisual)

      if (hasError) {
        // 有错误关键词：在自然 tier 和上一轮 tier 中取较高者，再升一级
        const lastTierIdx = TIER_ORDER.indexOf(state.tier as typeof TIER_ORDER[number])
        const baseTierIdx = TIER_ORDER.indexOf(baseTier as typeof TIER_ORDER[number])
        const higherTier = lastTierIdx >= baseTierIdx ? state.tier : baseTier
        baseTier = upgradeTier(higherTier as TierKey)
        const newFailCount = state.failCount + 1
        sessionState.set(sessionID, { tier: baseTier, failCount: newFailCount })
      } else {
        // 无错误：重置失败计数，记录本轮 tier
        sessionState.set(sessionID, { tier: baseTier, failCount: 0 })
      }

      const model = pickModel(baseTier, incoming.model?.providerID)
      if (!model) return

      // 与当前模型一致时不覆盖
      if (incoming.model?.providerID === model.providerID && incoming.model?.modelID === model.modelID) return

      output.model = model

      if (process.env.OPENCODE_MODEL_SELECTOR_DEBUG === "1") {
        process.stderr.write(
          `[model-selector] tier=${baseTier} tokens≈${tokens} hasError=${hasError} → ${model.providerID}/${model.modelID}\n`,
        )
      }
    },
  }
}

export default {
  id: "model-selector",
  server,
}
