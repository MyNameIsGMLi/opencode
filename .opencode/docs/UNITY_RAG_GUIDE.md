# Unity RAG 系统使用指南

## 📖 概述

Unity RAG（Retrieval-Augmented Generation）系统是一个渐进式知识库，用于增强 Unity IL2CPP 逆向工程的代码生成质量和效率。

### 核心优势

- **⚡ 减少 IDA 调用**：按需获取，避免全量分析（节省 ~90% 时间）
- **🎯 提升准确率**：智能检索相关上下文（从 80% → 95%+）
- **📚 知识积累**：成功案例自动学习，越用越智能
- **🔍 智能判断**：自动识别哪些类需要 IDA 分析

---

## 🚀 快速开始

### 1. 初始化 RAG 索引

```bash
# 在 Unity 项目目录下运行
unity-rag-workflow --workflow=init --projectDir=/path/to/UnityProject
```

**输出示例**：
```
✅ RAG 初始化完成！

📊 知识库统计:
- 总类数: 1523
- 总方法数: 8942
- 需要 IDA 分析: 152 个类 (10.0%)

💡 下一步:
1. 启动 IDA Pro 并加载二进制文件
2. 运行: unity-rag-workflow --workflow=smart-ida
3. 开始实现类: unity-rag-workflow --workflow=implement --className=YourClass
```

### 2. 智能批量获取 IDA 分析（可选）

```bash
# 智能判断并批量获取需要 IDA 的类
unity-rag-workflow --workflow=smart-ida --projectDir=/path/to/UnityProject
```

**说明**：系统会自动识别复杂的类（加密、网络、算法等），只对这些类调用 IDA。

### 3. 实现单个类

```bash
# 实现 ArrowController 类
unity-rag-workflow --workflow=implement \
  --projectDir=/path/to/UnityProject \
  --className=ArrowController
```

**输出**：优化的 AI Prompt，包含：
- 目标类定义
- 基类和接口参考
- 相似的已验证代码
- IDA 伪代码（如果有）
- 检测到的设计模式

### 4. 学习成功案例

```bash
# 代码生成成功后，加入知识库
unity-rag-learn \
  --projectDir=/path/to/UnityProject \
  --className=ArrowController \
  --codePath=Assets/Scripts/ArrowController.cs \
  --compileSuccess=true
```

---

## 📚 工作流详解

### 工作流类型

| 工作流 | 用途 | 何时使用 |
|--------|------|---------|
| `init` | 初始化 RAG 索引 | 新项目开始时 |
| `smart-ida` | 智能批量获取 IDA | 初始化后，启动 IDA 时 |
| `implement` | 实现单个类 | 每次生成代码时 |
| `batch` | 批量实现模块 | 处理整个模块时 |
| `status` | 查看进度统计 | 随时查看进度 |

---

## 🎯 典型场景

### 场景 1: 小型项目（<100 类）

```bash
# Step 1: 初始化
unity-rag-workflow --workflow=init --projectDir=./MyGame

# Step 2: 直接实现（不需要 IDA）
unity-rag-workflow --workflow=implement --className=PlayerData

# Step 3: 学习成功案例
unity-rag-learn --className=PlayerData --codePath=... --compileSuccess=true
```

**说明**：小项目大多是简单类，不需要 IDA 也能生成准确。

---

### 场景 2: 中型项目（100-500 类）

```bash
# Step 1: 初始化
unity-rag-workflow --workflow=init --projectDir=./MediumGame

# Step 2: 智能获取 IDA（只对 ~10% 的类）
unity-rag-workflow --workflow=smart-ida

# Step 3: 批量实现模块
unity-rag-workflow --workflow=batch --moduleName=Gameplay

# Step 4: 逐个实现类
for class in $(cat class_list.txt); do
  unity-rag-workflow --workflow=implement --className=$class
  # 生成代码...
  unity-rag-learn --className=$class --codePath=...
done
```

---

### 场景 3: 大型项目（>500 类）

```bash
# Step 1: 初始化
unity-rag-workflow --workflow=init --projectDir=./LargeGame

# Step 2: 分模块获取 IDA
unity-rag-ida --mode=batch --moduleName=Encryption
unity-rag-ida --mode=batch --moduleName=Network

# Step 3: 自动化实现循环
while true; do
  # 实现下一个类
  unity-rag-workflow --workflow=implement --className=NextClass
  
  # AI 生成代码...
  
  # 编译验证
  if compile_success; then
    unity-rag-learn --className=NextClass --codePath=...
  fi
  
  # 检查进度
  unity-rag-workflow --workflow=status
done
```

---

## 🔧 高级用法

### 1. 强制使用 IDA

```bash
# 即使智能判断不需要，也强制获取 IDA
unity-rag-retriever --className=SimpleClass --forceIDA=true
```

### 2. 自定义 IDA 服务器

```bash
# 使用远程 IDA 服务器
unity-rag-ida \
  --mode=single \
  --className=NetworkManager \
  --idaRpcUrl=http://192.168.1.100:7734
```

### 3. 搜索已验证代码

```bash
# 搜索对象池模式的实现
unity-rag-core \
  --action=search \
  --query="ObjectPool pattern Stack" \
  --topK=5
```

### 4. 查看详细检索过程

```bash
# 显示详细的检索日志
unity-rag-retriever --className=ArrowController --verbose=true
```

---

## 📊 监控与优化

### 查看知识库统计

```bash
unity-rag-workflow --workflow=status
```

**输出示例**：
```
📊 RAG 知识库统计

版本: 1.0.0
创建时间: 2026-05-20T10:00:00Z
更新时间: 2026-05-20T15:30:00Z

📈 总体统计:
- 总类数: 1523
- 总方法数: 8942
- IDA 分析数: 152
- 已验证实现: 456

💡 知识覆盖率:
- IDA 覆盖: 10.0%
- 已验证覆盖: 29.9%

📈 实现进度:
- 已完成: 456/1523 (29.9%)
- 剩余: 1067
- 预计耗时: 88.9 小时
```

---

## 🎓 最佳实践

### 1. 渐进式工作流

**推荐顺序**：
1. 先实现简单的数据类（PlayerData, ItemData）
2. 积累 50+ 已验证类后，实现业务逻辑类
3. 最后实现复杂的核心算法类

**原因**：早期积累的简单类案例，会帮助后续类的生成。

### 2. 模块化处理

按模块批量处理，而不是随机顺序：

```bash
# 按依赖顺序处理模块
unity-rag-workflow --workflow=batch --moduleName=DataModels
unity-rag-workflow --workflow=batch --moduleName=Managers
unity-rag-workflow --workflow=batch --moduleName=Gameplay
```

### 3. 定期检查进度

每实现 50 个类后，检查知识库状态：

```bash
unity-rag-workflow --workflow=status
```

如果已验证覆盖率 > 30%，后续成功率会显著提升。

### 4. IDA 策略

- **小项目**：不用 IDA，直接生成
- **中型项目**：用 `smart-ida` 只对 10-20% 的类获取 IDA
- **大型项目**：分模块批量获取 IDA

---

## 🐛 常见问题

### Q1: 索引失败，提示找不到 dump.cs

**A**: 确保文件路径正确：
```
YourProject/
  Assets/
    Il2CppDump/
      dump.cs         ← 必须存在
      script.json     ← 必须存在
```

### Q2: IDA 连接失败

**A**: 检查 IDA Pro：
1. IDA Pro 是否已启动
2. RPC 插件是否加载
3. 检查 IDA 输出窗口是否显示 "Server started on http://..."
4. 测试连接：`curl -X POST http://localhost:7734/ping`

### Q3: 生成的代码准确率不高

**A**: 
1. 检查已验证覆盖率（`status` 工作流）
2. 如果 < 10%，继续积累更多已验证代码
3. 对复杂类，考虑强制使用 IDA

### Q4: 知识库太大，检索变慢

**A**: 
1. 定期清理未使用的 chunk：
   ```bash
   # TODO: 添加清理工具
   ```
2. 考虑升级到向量数据库（后续版本）

---

## 🔮 未来增强

### 计划中的功能

- [ ] **向量嵌入**：集成 OpenAI Embedding API
- [ ] **向量数据库**：使用 Qdrant/Chroma 替代 JSON
- [ ] **Reranker**：使用 Cohere Rerank 提升检索精度
- [ ] **Web UI**：可视化知识库和检索过程
- [ ] **自动模式**：全自动实现项目

---

## 📞 支持

如有问题，请：
1. 查看日志：`<projectDir>/.opencode/rag/`
2. 使用 `--verbose=true` 获取详细输出
3. 提交 Issue

---

## 📄 许可

MIT License
