import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo } from "solid-js"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)

  // Calculate total tokens across all assistant messages
  const totalStats = createMemo(() => {
    const assistantMessages = msg().filter((item): item is AssistantMessage => item.role === "assistant")

    const tokens = {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    }

    for (const item of assistantMessages) {
      tokens.input += item.tokens.input
      tokens.output += item.tokens.output
      tokens.reasoning += item.tokens.reasoning
      tokens.cacheRead += item.tokens.cache.read
      tokens.cacheWrite += item.tokens.cache.write
    }

    const totalTokens = tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite

    return {
      totalTokens,
      tokens,
      messageCount: assistantMessages.length,
    }
  })

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) {
      return {
        tokens: 0,
        percent: null,
      }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>对话统计</b>
      </text>
      <text fg={theme().textMuted}>总 Tokens: {totalStats().totalTokens.toLocaleString()}</text>
      <text fg={theme().textMuted}>
        {"  "}输入: {totalStats().tokens.input.toLocaleString()}
      </text>
      <text fg={theme().textMuted}>
        {"  "}输出: {totalStats().tokens.output.toLocaleString()}
      </text>
      {totalStats().tokens.reasoning > 0 && (
        <text fg={theme().textMuted}>
          {"  "}推理: {totalStats().tokens.reasoning.toLocaleString()}
        </text>
      )}
      {(totalStats().tokens.cacheRead > 0 || totalStats().tokens.cacheWrite > 0) && (
        <text fg={theme().textMuted}>
          {"  "}缓存: {(totalStats().tokens.cacheRead + totalStats().tokens.cacheWrite).toLocaleString()}
        </text>
      )}
      <text fg={theme().textMuted}>总消息: {totalStats().messageCount} 条</text>
      <text fg={theme().textMuted}>总花费: {money.format(cost())}</text>
      <text fg={theme().text} style={{ marginTop: 1 }}>
        <b>当前上下文</b>
      </text>
      <text fg={theme().textMuted}>
        {state().tokens.toLocaleString()} tokens ({state().percent ?? 0}% 已用)
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
