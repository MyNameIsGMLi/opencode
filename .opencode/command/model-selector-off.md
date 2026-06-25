---
description: 关闭自动模型选择
subtask: true
---

!`opencode model-selector off && kill -USR2 $(ps -o ppid= -p $PPID | tr -d ' ')`

告知用户：自动模型选择已关闭，将使用默认模型。
