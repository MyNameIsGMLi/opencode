# unity-context-builder Skill

## 触发场景

在实现 Unity IL2CPP 逆向工程类之前，需要收集高质量 Context 时使用。

## 数据源

- **dump.cs**（必须）：IL2CPP 类定义，提供类结构、方法签名、依赖关系
- **script.json**（必须）：方法地址映射，用于 IDA 分析
- **IDA RPC**（可选）：真实方法实现逻辑，通过 `http://localhost:7734` 访问

## 工作步骤

### Step 1：检查 RAG 索引

```bash
/impl-unity --progress
```

如果未初始化：
```bash
/impl-unity --init
```

### Step 2：执行 Context 检索

通过 `unity-rag-retriever` 工具的六阶段检索：

1. **查找目标类**：在 `hotChunks.classes` 中精确匹配
2. **IDA 判断**：基于关键词/复杂度/方法数/命名空间规则
3. **检索依赖类**：基类、接口、字段类型（来自 `metadata.dependencies`）
4. **检索相似已验证代码**：同命名空间或相似后缀，最多 3 个
5. **IDA 分析**：按需解压 `coldChunks.idaBlob`，按优先级选方法
6. **Xrefs 融合**：反向引用（谁在使用本类），用于推断方法契约

### Step 3：IDA 智能分析（按需）

触发条件（任一满足）：
- 类名含关键词：Encrypt/Network/AI/Pathfind/Calculate/Sync
- 复杂度 > 80
- 方法数 > 20
- 同命名空间相似类已使用 IDA

IDA 方法优先级：
1. Unity 生命周期（Update/FixedUpdate/Awake）
2. 业务逻辑关键词（Calculate/Process/Execute/Handle）
3. 参数最多的方法

### Step 4：Token 预算管理

Prompt 总量不超过 **100K tokens**（约 400K 字符）。

裁剪优先级（高→低）：
1. 目标类定义（必须保留）
2. IDA 伪代码（完整保留）
3. xrefs 使用示例（最多 5 条）
4. 已验证代码参考（最多 3 个，各 2000 字符）
5. 依赖类摘要（最多 3 个，各 800 字符）
6. 设计模式说明

## 输出格式

返回结构：
```typescript
{
  output: string       // 检索摘要
  prompt: string       // 完整 AI Prompt（含所有 Context）
  context: object      // 结构化 Context 对象
  needsIDAFetch: bool  // 是否需要先获取 IDA
  outputPath: string   // 建议的代码输出路径
}
```

## 适用场景

- Unity IL2CPP 逆向工程（通过 `/impl-unity --class`）
- 任何需要从 dump.cs + IDA 获取代码上下文的场景
- 复用：其他 Unity 项目可通过配置 `unity-config.json` 复用

## 配置

`.opencode/unity-config.json`（可选，覆盖默认路径）：
```json
{
  "dumpDir": "Il2CppDump",
  "scriptsDir": "Assets/Scripts/Game"
}
```
