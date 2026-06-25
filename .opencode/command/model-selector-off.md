---
description: 关闭自动模型选择
subtask: true
---

通过 server HTTP API 关闭自动模型选择，使配置变更在当前 TUI 会话中立即生效：

!`curl -s -X PATCH "${OPENCODE_SERVER_URL}/global/config" -H "Content-Type: application/json" -d '{"model_selector_enabled": false}' && echo "自动模型选择已关闭"`

告知用户：自动模型选择已关闭，将使用默认模型。
