# Unity RAG 快速开始

## 🎯 5 分钟体验 RAG 增强逆向

### 前置条件

1. Unity IL2CPP dump 文件已准备好：
   - `dump.cs`
   - `script.json`
   
2. （可选）IDA Pro 已安装并配置 RPC 服务器

---

## 📝 完整示例

假设你有一个逆向项目：`ArcheroClone`

```
ArcheroClone/
  Assets/
    Il2CppDump/
      dump.cs
      script.json
    Scripts/          ← 生成的代码放这里
```

---

### Step 1: 初始化 RAG（1 分钟）

```bash
cd ArcheroClone

# 初始化 RAG 索引
opencode run unity-rag-workflow \
  --workflow=init \
  --projectDir=.
```

**输出**：
```
✅ RAG 初始化完成！

📊 知识库统计:
- 总类数: 342
- 总方法数: 2156
- 需要 IDA 分析: 34 个类 (9.9%)

💡 下一步:
直接开始实现: unity-rag-workflow --workflow=implement --className=YourClass
```

---

### Step 2: 实现第一个简单类（1 分钟）

```bash
# 实现一个简单的数据类
opencode run unity-rag-retriever \
  --projectDir=. \
  --className=PlayerData
```

**输出**：优化的 AI Prompt

```markdown
# 任务：重建 Unity C# 类

## 目标类
```csharp
class PlayerData {
    int level;
    string playerName;
    float experience;
}
```

## 相似的已验证实现（参考）
（暂时为空，因为是第一个类）

## 检测到的设计模式
无

## 实现要求
1. 零 TODO/Stub
2. 命名一致
...
```

**使用 AI 生成代码**：

把上面的 Prompt 发给 AI（Claude/GPT），得到：

```csharp
namespace Game.Data
{
    [System.Serializable]
    public class PlayerData
    {
        public int level;
        public string playerName;
        public float experience;

        public PlayerData()
        {
            level = 1;
            playerName = "";
            experience = 0f;
        }

        public void AddExperience(float exp)
        {
            experience += exp;
            CheckLevelUp();
        }

        private void CheckLevelUp()
        {
            float requiredExp = level * 100f;
            if (experience >= requiredExp)
            {
                level++;
                experience -= requiredExp;
            }
        }
    }
}
```

保存到 `Assets/Scripts/PlayerData.cs`

---

### Step 3: 学习成功案例（10 秒）

```bash
# 加入知识库
opencode run unity-rag-learn \
  --projectDir=. \
  --className=PlayerData \
  --codePath=Assets/Scripts/PlayerData.cs \
  --compileSuccess=true
```

**输出**：
```
✅ 已加入知识库: PlayerData

📊 代码分析:
- 命名空间: Game.Data
- 基类: 无
- 字段数: 3
- 方法数: 3
- 代码行数: 31

💡 此代码将用于后续类的参考。
```

---

### Step 4: 实现第二个类（会参考第一个）（1 分钟）

```bash
# 实现另一个数据类
opencode run unity-rag-retriever \
  --projectDir=. \
  --className=ItemData
```

**输出 Prompt**（注意多了"相似已验证"部分）：

```markdown
# 任务：重建 Unity C# 类

## 目标类
```csharp
class ItemData {
    int itemId;
    string itemName;
    int quantity;
}
```

## 相似的已验证实现（参考）
### PlayerData  ← 新增！之前学习的案例
命名空间: Game.Data
```csharp
namespace Game.Data
{
    [System.Serializable]
    public class PlayerData
    {
        public int level;
        public string playerName;
        ...
    }
}
```

## 实现要求
...
```

AI 现在知道项目风格（命名空间、Serializable 等），生成的代码会更一致！

---

### Step 5: 实现复杂类（需要 IDA）（2 分钟）

假设你要实现加密类：

```bash
# 智能检索会判断需要 IDA
opencode run unity-rag-retriever \
  --projectDir=. \
  --className=EncryptionHelper \
  --verbose=true
```

**输出**：
```
[1/6] 查找目标类: EncryptionHelper
✓ 找到: Game.Utils.EncryptionHelper

[2/6] 智能判断是否需要 IDA
✓ 判断结果: 需要 IDA （关键词匹配：Encrypt）

[3/6] 检索依赖类
✓ 找到 0 个依赖

[4/6] 检索相似的已验证代码
✓ 找到 0 个相似已验证类

[5/6] 检索 IDA 分析
⚠ 未找到 IDA 分析，需要按需获取

⚠ 建议先获取 IDA 分析以提高准确率
```

**获取 IDA**：

```bash
# 前提：IDA Pro 已启动并加载了 libil2cpp.so

# 获取单个类的 IDA 分析
opencode run unity-rag-ida \
  --mode=single \
  --projectDir=. \
  --className=EncryptionHelper
```

**输出**：
```
✅ IDA 批量分析完成

📊 统计:
- 总数: 1
- 成功: 1
- 失败: 0
- 成功率: 100.0%

💾 已更新 RAG 索引
```

**重新检索**（现在有 IDA 了）：

```bash
opencode run unity-rag-retriever \
  --projectDir=. \
  --className=EncryptionHelper
```

Prompt 现在包含 IDA 伪代码：

```markdown
## IDA Pro 伪代码（真实逻辑）

**重要**: 以下是从二进制反编译的真实代码逻辑，请严格参考实现。

```c
void Encrypt(byte[] data, char* key) {
  for (int i = 0; i < len; i++) {
    data[i] ^= key[i % keyLen];
    data[i] = (data[i] << 3) | (data[i] >> 5);
  }
}
```
```

AI 现在知道真实逻辑，生成的代码会正确！

---

## 🎉 总结

5 分钟内你做了什么：

1. ✅ 初始化了 342 个类的知识库
2. ✅ 实现了 2 个数据类
3. ✅ 学习了成功案例
4. ✅ 按需获取了 IDA 分析
5. ✅ 实现了 1 个复杂类

**关键收益**：

- ⚡ **不需要全量 IDA**：只对 1 个复杂类调用 IDA（而不是 342 个）
- 🎯 **准确率提升**：第二个类已经能参考第一个的风格
- 📚 **知识积累**：越实现越多，后续越准确

---

## 📊 继续实现

### 批量实现模块

```bash
# 查看有哪些模块
opencode run unity-rag-core --action=stats

# 批量实现 Gameplay 模块
opencode run unity-rag-workflow \
  --workflow=batch \
  --moduleName=Gameplay

# 逐个实现类
for class in ArrowController BowController EnemyAI; do
  opencode run unity-rag-retriever --className=$class
  # 生成代码...
  opencode run unity-rag-learn --className=$class --codePath=...
done
```

### 自动化脚本

创建 `auto_implement.sh`：

```bash
#!/bin/bash

# 类列表
CLASSES=(
  "PlayerData"
  "ItemData"
  "ArrowController"
  "BowController"
  "EnemyAI"
)

for CLASS in "${CLASSES[@]}"; do
  echo "🎯 实现: $CLASS"
  
  # 检索上下文
  opencode run unity-rag-retriever \
    --projectDir=. \
    --className=$CLASS > prompt.txt
  
  # 使用 AI 生成代码（这里假设你有 AI API）
  # cat prompt.txt | ai-generate > Assets/Scripts/$CLASS.cs
  
  # 手动生成后，学习
  echo "代码已生成，按回车继续学习..."
  read
  
  opencode run unity-rag-learn \
    --projectDir=. \
    --className=$CLASS \
    --codePath=Assets/Scripts/$CLASS.cs
  
  echo "✅ 完成: $CLASS"
done

# 查看进度
opencode run unity-rag-workflow --workflow=status
```

---

## 🚀 下一步

- 阅读完整指南：[UNITY_RAG_GUIDE.md](./UNITY_RAG_GUIDE.md)
- 了解高级用法：自定义 IDA 服务器、批量处理等
- 集成 CI/CD：自动化整个逆向流程

---

## ❓ 遇到问题？

1. 查看详细日志：`--verbose=true`
2. 检查 RAG 索引：`.opencode/rag/index.json`
3. 查看统计：`unity-rag-workflow --workflow=status`

祝逆向顺利！🎉
