---
description: 开启自动模型选择
subtask: true
---

通过 server HTTP API 开启自动模型选择，使配置变更在当前 TUI 会话中立即生效：

!`curl -s -X PATCH "${OPENCODE_SERVER_URL}/global/config" -H "Content-Type: application/json" -d '{"model_selector_enabled": true}' && echo "自动模型选择已开启"`

告知用户：自动模型选择已开启，新消息将自动路由到最合适的模型。
