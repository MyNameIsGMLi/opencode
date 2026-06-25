---
description: 开启自动模型选择
subtask: true
---

!`bun -e "const {createOpencodeClient}=await import('@opencode-ai/sdk/v2');const c=createOpencodeClient({baseUrl:process.env.OPENCODE_SERVER_URL||'http://localhost:4096'});const r=await c.global.config.update({config:{model_selector_enabled:true}});console.log(r.error?'failed':'ok')"`

告知用户：自动模型选择已开启，新消息将自动路由到最合适的模型。
