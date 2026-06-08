import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../config"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { usePluginRuntime } from "../../plugin/runtime"

import { getScrollAcceleration } from "../../util/scroll"
import { WorkspaceLabel } from "../../component/workspace-label"
import { ModelCostDisplay } from "../../component/model-cost-display"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"

const moneyFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const pluginRuntime = usePluginRuntime()
  const project = useProject()
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const workspace = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return
    return project.workspace.get(workspaceID)
  }
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  const stats = createMemo(() => {
    const s = sync.session.get(props.sessionID)
    if (!s) return { tokens: 0, cost: 0, messages: 0 }

    const parentID = s.parentID ?? s.id
    const family = sync.data.session.filter((x) => x.id === parentID || x.parentID === parentID)

    let totalTokens = 0
    let totalCost = 0
    let totalMessages = 0

    for (const session of family) {
      totalCost += session.cost ?? 0
      const msgs = sync.data.message[session.id] ?? []
      for (const m of msgs) {
        if (m.role === "assistant") {
          const msg = m as AssistantMessage
          totalTokens +=
            msg.tokens.input +
            msg.tokens.output +
            msg.tokens.reasoning +
            msg.tokens.cache.read +
            msg.tokens.cache.write
          totalMessages++
        }
      }
    }
    return { tokens: totalTokens, cost: totalCost, messages: totalMessages }
  })

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <pluginRuntime.Slot
              name="sidebar_title"
              mode="single_winner"
              session_id={props.sessionID}
              title={session()!.title}
              share_url={session()!.share?.url}
            >
              <box paddingRight={1}>
                <text fg={theme.text}>
                  <b>{session()!.title}</b>
                </text>
                <Show when={InstallationChannel !== "latest"}>
                  <text fg={theme.textMuted}>{props.sessionID}</text>
                </Show>
                <Show when={session()!.workspaceID}>
                  <text fg={theme.textMuted}>
                    <Show
                      when={workspace()}
                      fallback={<WorkspaceLabel type="unknown" name={session()!.workspaceID!} status="error" icon />}
                    >
                      {(item) => (
                        <WorkspaceLabel
                          type={item().type}
                          name={item().name}
                          status={project.workspace.status(item().id) ?? "error"}
                          icon
                        />
                      )}
                    </Show>
                  </text>
                </Show>
                <Show when={session()!.share?.url}>
                  <text fg={theme.textMuted}>{session()!.share!.url}</text>
                </Show>
              </box>
            </pluginRuntime.Slot>

            <box marginTop={1} marginBottom={1} gap={0}>
              <text fg={theme.text}>
                <b>对话总计</b>
              </text>
              <text fg={theme.textMuted}>
                Tokens: <span style={{ fg: theme.text }}>{stats().tokens.toLocaleString()}</span>
              </text>
              <text fg={theme.textMuted}>
                花费: <span style={{ fg: theme.success }}>{moneyFormat.format(stats().cost)}</span>
              </text>
              <text fg={theme.textMuted}>
                消息: <span style={{ fg: theme.text }}>{stats().messages}</span> 条
              </text>
            </box>

            <ModelCostDisplay sessionID={props.sessionID} />
            <text fg={theme.border} marginTop={1} marginBottom={1}>
              {"─".repeat(38)}
            </text>
            <pluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <pluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID}>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.success }}>•</span> <b>Open</b>
              <span style={{ fg: theme.text }}>
                <b>Code</b>
              </span>{" "}
              <span>{InstallationVersion}</span>
            </text>
          </pluginRuntime.Slot>
        </box>
      </box>
    </Show>
  )
}
