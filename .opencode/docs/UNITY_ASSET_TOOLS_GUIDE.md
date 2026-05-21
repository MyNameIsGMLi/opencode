# Unity 资源处理工具使用指南

## 📖 概述

Unity 逆向工程完整流程需要处理两部分：
1. **代码逆向**：从 IL2CPP dump 重建 C# 代码（已有 RAG 系统）
2. **资源提取**：从 APK/IPA 提取游戏资源（本文档）

---

## 🎯 完整工作流

```
APK/IPA 包
   ↓
[1] unity-unpack (解包)
   ↓
libil2cpp.so + global-metadata.dat + Assets
   ↓
[2] unity-dump (生成 dump.cs)
   ↓
dump.cs + script.json
   ↓
[3] unity-asset-extract (提取资源)
   ↓
Textures + Models + Scenes + Prefabs
   ↓
[4] /impl-unity (实现代码，RAG 增强)
   ↓
C# Scripts
   ↓
[5] unity-scene-rebuilder (重建场景)
   ↓
[6] unity-reference-fixer (修复引用)
   ↓
[7] unity-project-builder (构建完整项目)
   ↓
可运行的 Unity 项目 ✅
```

---

## 🛠️ 工具详细使用

### 1️⃣ unity-unpack - 解包 APK/IPA

**功能**：解压 APK/IPA 文件，提取 IL2CPP 二进制和资源文件。

**使用方法**：
```bash
opencode run unity-unpack \
  --filePath=/path/to/game.apk \
  --outputDir=/path/to/output
```

**输出**：
```
output/
├── lib/
│   └── arm64-v8a/
│       └── libil2cpp.so        ← IL2CPP 二进制
├── assets/
│   └── bin/
│       └── Data/
│           └── Managed/
│               └── Metadata/
│                   └── global-metadata.dat  ← 元数据
└── assets/
    └── aa/                      ← 游戏资源
```

---

### 2️⃣ unity-dump - 生成 dump.cs

**功能**：使用 Il2CppDumper 生成类定义和方法地址映射。

**使用方法**：
```bash
opencode run unity-dump \
  --binaryPath=/path/to/libil2cpp.so \
  --metadataPath=/path/to/global-metadata.dat \
  --outputDir=/path/to/output
```

**输出**：
```
output/
├── dump.cs          ← 所有类定义（C# 头文件）
├── script.json      ← 方法地址映射
└── DummyDll/        ← 虚拟 DLL（用于引用）
```

**示例 dump.cs 内容**：
```csharp
namespace Game.Arrow
{
    public class ArrowController : MonoBehaviour
    {
        public float speed;
        public Vector3 direction;
        
        public void Launch(Vector3 dir, float force) { }
        private void Update() { }
        private void OnCollisionEnter(Collision col) { }
    }
}
```

---

### 3️⃣ unity-asset-extract - 提取资源 ⭐

**功能**：使用 AssetRipper 提取所有游戏资源。

#### 前置条件

**安装 AssetRipper**：
```bash
# macOS
# 下载: https://github.com/AssetRipper/AssetRipper/releases
# 解压到: ~/UnPackTools/AssetRipper/

# 或者使用 Homebrew
brew install --cask assetripper
```

#### 使用方法

**基础用法**：
```bash
opencode run unity-asset-extract \
  --inputPath=/path/to/unpacked_apk \
  --outputDir=/path/to/extracted_assets
```

**高级用法**：
```bash
opencode run unity-asset-extract \
  --inputPath=/path/to/unpacked_apk \
  --outputDir=/path/to/extracted_assets \
  --assetRipperPath=/custom/path/to/AssetRipper \
  --includeScenes=true \
  --includePrefabs=true \
  --includeScriptableObjects=true
```

#### 输出结构

```
extracted_assets/
├── Assets/
│   ├── Textures/
│   │   ├── UI/
│   │   │   ├── button_normal.png
│   │   │   └── icon_arrow.png
│   │   └── Characters/
│   │       └── player_texture.png
│   │
│   ├── Models/
│   │   └── arrow_model.fbx
│   │
│   ├── Audio/
│   │   ├── bgm.mp3
│   │   └── sfx_arrow_hit.wav
│   │
│   ├── Scenes/
│   │   ├── MainMenu.unity
│   │   └── BattleScene.unity
│   │
│   ├── Prefabs/
│   │   ├── ArrowPrefab.prefab
│   │   └── EnemyPrefab.prefab
│   │
│   └── Resources/
│       └── GameConfig.asset
│
└── ProjectSettings/
    └── ProjectSettings.asset
```

#### 资源统计

工具会自动统计提取的资源：
```
✅ Asset extraction completed!

📊 Extracted assets:
- Textures: 523
- Models: 45
- Audio: 187
- Scenes: 12
- Prefabs: 234
- Materials: 156
- Animations: 89

📁 Output: /path/to/extracted_assets
```

---

### 4️⃣ /impl-unity - 实现代码（RAG 增强）

**功能**：使用 RAG 系统智能生成 C# 代码。

**使用方法**：
```bash
# 初始化 RAG
/impl-unity --init

# 实现类
/impl-unity --class ArrowController
```

**详见**：[IMPL_UNITY_RAG_INTEGRATION.md](./IMPL_UNITY_RAG_INTEGRATION.md)

---

### 5️⃣ unity-scene-rebuilder - 重建场景

**功能**：从 AssetRipper 提取的 YAML 文件重建场景结构。

**使用方法**：
```bash
opencode run unity-scene-rebuilder \
  --extractedAssetsDir=/path/to/extracted_assets \
  --reversedCodeDir=/path/to/implemented_scripts \
  --outputDir=/path/to/rebuilt_scenes
```

**参数说明**：
- `extractedAssetsDir`: AssetRipper 提取的资源目录
- `reversedCodeDir`: 已实现的 C# 脚本目录
- `outputDir`: 重建后的场景输出目录

**功能**：
- 重建 GameObject 层级
- 恢复组件配置
- 修复脚本引用
- 处理缺失引用

**输出**：
```
rebuilt_scenes/
├── MainMenu.unity
└── BattleScene.unity
```

---

### 6️⃣ unity-reference-fixer - 修复引用

**功能**：生成正确的 GUID 和 .meta 文件，修复 Unity 引用。

**使用方法**：
```bash
opencode run unity-reference-fixer \
  --projectDir=/path/to/unity_project \
  --reversedCodeDir=/path/to/scripts \
  --extractedAssetsDir=/path/to/assets
```

**功能**：
- 生成 Script GUID（MonoScript 引用）
- 生成 Asset GUID（Texture、Model 引用）
- 创建 .meta 文件
- 修复场景和 Prefab 中的引用

**示例**：
```yaml
# ArrowController.cs.meta
fileFormatVersion: 2
guid: a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
MonoImporter:
  externalObjects: {}
  serializedVersion: 2
  defaultReferences: []
```

---

### 7️⃣ unity-project-builder - 构建完整项目

**功能**：组装所有部分，创建可在 Unity 中打开的完整项目。

**使用方法**：
```bash
opencode run unity-project-builder \
  --outputDir=/path/to/final_project \
  --reversedCodeDir=/path/to/scripts \
  --extractedAssetsDir=/path/to/assets \
  --rebuiltScenesDir=/path/to/scenes \
  --projectName="ReversedGame" \
  --unityVersion="2021.3.0f1"
```

**输出结构**：
```
final_project/
├── Assets/
│   ├── Scripts/           ← 逆向的 C# 代码
│   ├── Textures/          ← 提取的纹理
│   ├── Models/            ← 提取的模型
│   ├── Audio/             ← 提取的音频
│   ├── Scenes/            ← 重建的场景
│   └── Resources/         ← 资源文件
│
├── ProjectSettings/
│   ├── ProjectSettings.asset
│   └── ...
│
├── Packages/
│   └── manifest.json
│
└── README.md              ← 项目说明
```

**可以直接在 Unity 中打开**！

---

## 🎬 完整实战示例

### 场景：逆向一个弓箭游戏 APK

```bash
# ==================== Step 1: 解包 APK ====================
opencode run unity-unpack \
  --filePath=~/Downloads/ArcherGame.apk \
  --outputDir=~/ArcherGame/unpacked

# 输出:
# ✅ Unpacked to: ~/ArcherGame/unpacked
# - libil2cpp.so
# - global-metadata.dat
# - Assets

# ==================== Step 2: 生成 dump.cs ====================
opencode run unity-dump \
  --binaryPath=~/ArcherGame/unpacked/lib/arm64-v8a/libil2cpp.so \
  --metadataPath=~/ArcherGame/unpacked/assets/bin/Data/Managed/Metadata/global-metadata.dat \
  --outputDir=~/ArcherGame/dump

# 输出:
# ✅ Dump completed!
# - dump.cs (3000+ classes)
# - script.json

# ==================== Step 3: 提取资源 ====================
opencode run unity-asset-extract \
  --inputPath=~/ArcherGame/unpacked \
  --outputDir=~/ArcherGame/assets

# 输出:
# ✅ Asset extraction completed!
# 📊 Extracted:
# - Textures: 523
# - Prefabs: 234
# - Scenes: 12

# ==================== Step 4: 创建项目目录 ====================
mkdir -p ~/ArcherGame/Project/Assets/Il2CppDump
cp ~/ArcherGame/dump/dump.cs ~/ArcherGame/Project/Assets/Il2CppDump/
cp ~/ArcherGame/dump/script.json ~/ArcherGame/Project/Assets/Il2CppDump/

# ==================== Step 5: 初始化 RAG ====================
cd ~/ArcherGame/Project
/impl-unity --init

# 输出:
# ✅ RAG 初始化完成！
# 📊 总类数: 3247
# 💡 建议: 运行 /impl-unity --smart-ida

# ==================== Step 6: 智能批量 IDA（可选）====================
# 前提: IDA Pro 已启动
/impl-unity --smart-ida

# 输出:
# 🤖 智能判断需要 IDA 的类...
# ✅ 分析完成: 327/3247 (10%)

# ==================== Step 7: 实现类 ====================
# 实现弓箭控制器
/impl-unity --class ArrowController

# 输出优化的 Prompt → 使用 AI 生成代码 → 保存

# 实现敌人 AI
/impl-unity --class EnemyAI

# 自动学习（参考 ArrowController）

# 批量实现更多类...
/impl-unity --class BowController
/impl-unity --class GameManager
/impl-unity --class PlayerController

# ==================== Step 8: 查看进度 ====================
/impl-unity --progress

# 输出:
# 📊 实现进度: 125/3247 (3.8%)
# 💡 知识覆盖率: 已验证 3.8%

# ==================== Step 9: 重建场景 ====================
opencode run unity-scene-rebuilder \
  --extractedAssetsDir=~/ArcherGame/assets \
  --reversedCodeDir=~/ArcherGame/Project/Assets/Scripts \
  --outputDir=~/ArcherGame/Project/Assets/Scenes

# 输出:
# ✅ Scenes rebuilt: 12

# ==================== Step 10: 修复引用 ====================
opencode run unity-reference-fixer \
  --projectDir=~/ArcherGame/Project \
  --reversedCodeDir=~/ArcherGame/Project/Assets/Scripts \
  --extractedAssetsDir=~/ArcherGame/assets

# 输出:
# ✅ References fixed!
# - Generated 125 script GUIDs
# - Fixed 234 prefab references
# - Created 523 .meta files

# ==================== Step 11: 构建最终项目 ====================
opencode run unity-project-builder \
  --outputDir=~/ArcherGame/FinalProject \
  --reversedCodeDir=~/ArcherGame/Project/Assets/Scripts \
  --extractedAssetsDir=~/ArcherGame/assets \
  --rebuiltScenesDir=~/ArcherGame/Project/Assets/Scenes \
  --projectName="ArcherGameReversed" \
  --unityVersion="2021.3.0f1"

# 输出:
# ✅ Project built successfully!
# 📁 Output: ~/ArcherGame/FinalProject
# 
# 💡 Next steps:
# 1. Open in Unity: ~/ArcherGame/FinalProject
# 2. Fix remaining compilation errors
# 3. Test in Play mode

# ==================== Step 12: 在 Unity 中打开 ====================
open -a Unity ~/ArcherGame/FinalProject
```

---

## 📊 工具对比

| 工具 | 输入 | 输出 | 依赖 | 耗时 |
|------|------|------|------|------|
| **unity-unpack** | APK/IPA | libil2cpp.so + assets | 无 | ~1 分钟 |
| **unity-dump** | libil2cpp.so + metadata | dump.cs + script.json | Il2CppDumper | ~2 分钟 |
| **unity-asset-extract** | Assets 文件 | Textures/Models/Scenes | AssetRipper | ~10 分钟 |
| **/impl-unity** | dump.cs | C# Scripts | RAG + IDA (可选) | ~1 分钟/类 |
| **unity-scene-rebuilder** | Scenes YAML | Unity Scenes | 无 | ~5 分钟 |
| **unity-reference-fixer** | Scripts + Assets | GUIDs + .meta | 无 | ~3 分钟 |
| **unity-project-builder** | All above | Unity Project | 无 | ~2 分钟 |

---

## 🔧 故障排除

### 问题 1: AssetRipper not found

**错误**：
```
Error: AssetRipper not found
```

**解决**：
```bash
# 下载 AssetRipper
# https://github.com/AssetRipper/AssetRipper/releases

# 解压到指定位置
mkdir -p ~/UnPackTools/AssetRipper
unzip AssetRipper_mac_x64.zip -d ~/UnPackTools/AssetRipper/

# 或手动指定路径
opencode run unity-asset-extract \
  --assetRipperPath=/custom/path/to/AssetRipper \
  --inputPath=... \
  --outputDir=...
```

---

### 问题 2: 资源提取失败

**错误**：
```
AssetRipper automation not fully supported
```

**解决**：
```bash
# 手动运行 AssetRipper
open ~/UnPackTools/AssetRipper/AssetRipper

# 然后:
# 1. Load files from: /path/to/unpacked
# 2. Export to: /path/to/output
# 3. 继续下一步
```

---

### 问题 3: Unity 打开项目报错

**错误**：
```
Script 'ArrowController' could not be found
```

**解决**：
```bash
# 重新运行 reference fixer
opencode run unity-reference-fixer \
  --projectDir=/path/to/project \
  --reversedCodeDir=/path/to/scripts

# 在 Unity 中刷新
# Assets → Refresh (Cmd+R)
```

---

## 💡 最佳实践

### 1. 分阶段处理

不要一次性处理所有类，分模块处理：
```bash
# 第一批: 数据类
/impl-unity --class PlayerData
/impl-unity --class ItemData
...

# 第二批: 管理器
/impl-unity --class GameManager
/impl-unity --class UIManager
...

# 第三批: 游戏逻辑
/impl-unity --class ArrowController
/impl-unity --class EnemyAI
...
```

### 2. 及时验证

每完成一批类，就测试编译：
```bash
# 在 Unity 中打开项目
# 检查 Console 是否有编译错误
# 修复错误后继续
```

### 3. 备份进度

定期备份 RAG 知识库：
```bash
# 备份
tar -czf rag_backup_$(date +%Y%m%d).tar.gz .opencode/rag

# 恢复
tar -xzf rag_backup_20260520.tar.gz
```

---

## 📚 相关文档

- **RAG 系统**: [UNITY_RAG_README.md](./UNITY_RAG_README.md)
- **快速开始**: [UNITY_RAG_QUICKSTART.md](./UNITY_RAG_QUICKSTART.md)
- **完整指南**: [UNITY_RAG_GUIDE.md](./UNITY_RAG_GUIDE.md)
- **命令集成**: [IMPL_UNITY_RAG_INTEGRATION.md](./IMPL_UNITY_RAG_INTEGRATION.md)

---

## 🎉 总结

Unity 逆向工程完整流程：

```
APK/IPA
  → unpack (解包)
  → dump (生成 dump.cs)
  → asset-extract (提取资源) ⭐
  → impl-unity (实现代码，RAG)
  → scene-rebuilder (重建场景)
  → reference-fixer (修复引用)
  → project-builder (构建项目)
  → 可运行的 Unity 项目 ✅
```

**关键工具**：
- `unity-asset-extract` - 提取所有游戏资源
- `/impl-unity` - RAG 增强的代码生成

**预计耗时**：
- 小项目（<100 类）：~2 小时
- 中项目（500 类）：~1 天
- 大项目（3000 类）：~1 周

祝你逆向顺利！🚀
