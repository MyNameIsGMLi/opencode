---
description: 开启自动模型选择
subtask: true
---

!`opencode model-selector on && kill -USR2 $(ps -o ppid= -p $PPID | tr -d ' ')`

告知用户：自动模型选择已开启，新消息将自动路由到最合适的模型。
