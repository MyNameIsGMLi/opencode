import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"

function formatCost(value: number) {
  if (value === 0) return "Free"
  if (value < 0.01) return `$${(value * 1000).toFixed(2)}/B`
  return `$${value.toFixed(2)}/M`
}

export function ModelCostDisplay(_props: { sessionID: string }) {
  const local = useLocal()
  const sync = useSync()
  const { theme } = useTheme()

  const cost = createMemo(() => {
    const current = local.model.current()
    if (!current) return undefined
    const model = sync.data.provider.find((p) => p.id === current.providerID)?.models[current.modelID]
    return model?.cost
  })

  return (
    <box>
      <text fg={theme.textMuted}>
        {"in "}
        <span style={{ fg: theme.text }}>{cost() ? formatCost(cost()!.input) : "—"}</span>
        {"  out "}
        <span style={{ fg: theme.text }}>{cost() ? formatCost(cost()!.output) : "—"}</span>
      </text>
    </box>
  )
}
