# Unity 逆向工具速查表

## 🚀 快速开始

```bash
# 1. 解包 APK
opencode run unity-unpack --filePath=game.apk --outputDir=./unpacked

# 2. 生成 dump.cs
opencode run unity-dump \
  --binaryPath=./unpacked/lib/arm64-v8a/libil2cpp.so \
  --metadataPath=./unpacked/assets/.../global-metadata.dat \
  --outputDir=./dump

# 3. 提取资源
opencode run unity-asset-extract \
  --inputPath=./unpacked \
  --outputDir=./assets

# 4. 初始化 RAG
/impl-unity --init

# 5. 实现代码
/impl-unity --class ClassName
```

---

## 📦 工具列表

| 工具 | 命令 | 功能 |
|------|------|------|
| **unpack** | `unity-unpack` | 解包 APK/IPA |
| **dump** | `unity-dump` | 生成 dump.cs |
| **extract** | `unity-asset-extract` | 提取资源 ⭐ |
| **impl** | `/impl-unity` | 实现代码（RAG） |
| **scene** | `unity-scene-rebuilder` | 重建场景 |
| **fix** | `unity-reference-fixer` | 修复引用 |
| **build** | `unity-project-builder` | 构建项目 |

---

## 🎯 常用命令

### 资源提取
```bash
# 基础
opencode run unity-asset-extract \
  --inputPath=/path/to/unpacked \
  --outputDir=/path/to/assets

# 完整
opencode run unity-asset-extract \
  --inputPath=/path/to/unpacked \
  --outputDir=/path/to/assets \
  --includeScenes=true \
  --includePrefabs=true \
  --includeScriptableObjects=true
```

### RAG 代码生成
```bash
# 初始化（首次）
/impl-unity --init

# 查看进度
/impl-unity --progress

# 智能 IDA
/impl-unity --smart-ida

# 实现类
/impl-unity --class ClassName

# 强制 IDA
/impl-unity --class ClassName --force-ida

# 详细日志
/impl-unity --class ClassName --verbose
```

### 场景重建
```bash
opencode run unity-scene-rebuilder \
  --extractedAssetsDir=/path/to/assets \
  --reversedCodeDir=/path/to/scripts \
  --outputDir=/path/to/scenes
```

### 引用修复
```bash
opencode run unity-reference-fixer \
  --projectDir=/path/to/project \
  --reversedCodeDir=/path/to/scripts \
  --extractedAssetsDir=/path/to/assets
```

### 项目构建
```bash
opencode run unity-project-builder \
  --outputDir=/path/to/final \
  --reversedCodeDir=/path/to/scripts \
  --extractedAssetsDir=/path/to/assets \
  --projectName="MyGame"
```

---

## 📂 目录结构

### 推荐工作目录
```
~/MyGameReverse/
├── original/
│   └── game.apk              ← 原始 APK
│
├── unpacked/                 ← Step 1: unpack
│   ├── lib/
│   │   └── arm64-v8a/
│   │       └── libil2cpp.so
│   └── assets/
│       └── bin/Data/Managed/Metadata/
│           └── global-metadata.dat
│
├── dump/                     ← Step 2: dump
│   ├── dump.cs
│   └── script.json
│
├── assets/                   ← Step 3: extract
│   ├── Assets/
│   │   ├── Textures/
│   │   ├── Models/
│   │   ├── Scenes/
│   │   └── Prefabs/
│   └── ProjectSettings/
│
├── Project/                  ← Step 4-6: impl
│   ├── Assets/
│   │   ├── Il2CppDump/
│   │   │   ├── dump.cs
│   │   │   └── script.json
│   │   └── Scripts/         ← 实现的代码
│   └── .opencode/
│       └── rag/
│           └── index.json   ← RAG 知识库
│
└── Final/                    ← Step 7: build
    ├── Assets/
    ├── ProjectSettings/
    └── Packages/
```

---

## 🔧 依赖工具

| 工具 | 用途 | 安装 |
|------|------|------|
| **Il2CppDumper** | 生成 dump.cs | 内置 |
| **AssetRipper** | 提取资源 | [下载](https://github.com/AssetRipper/AssetRipper/releases) |
| **IDA Pro** | 伪代码分析（可选） | 商业软件 |

### AssetRipper 安装
```bash
# 下载
wget https://github.com/AssetRipper/AssetRipper/releases/download/latest/AssetRipper_mac_x64.zip

# 解压
unzip AssetRipper_mac_x64.zip -d ~/UnPackTools/AssetRipper/

# 验证
ls ~/UnPackTools/AssetRipper/AssetRipper.GUI.Free
```

---

## 📊 提取的资源类型

| 类型 | 扩展名 | 说明 |
|------|--------|------|
| **纹理** | .png, .jpg, .tga | UI、角色、场景贴图 |
| **模型** | .fbx, .obj | 3D 模型 |
| **音频** | .wav, .mp3, .ogg | 背景音乐、音效 |
| **场景** | .unity | 场景文件 |
| **预制体** | .prefab | GameObject 预制体 |
| **材质** | .mat | 材质球 |
| **动画** | .anim | 动画剪辑 |
| **脚本对象** | .asset | ScriptableObject |

---

## ⏱️ 预计耗时

| 项目规模 | 类数量 | 资源数量 | 总耗时 |
|---------|--------|---------|--------|
| **小型** | <100 | <500 | ~2 小时 |
| **中型** | 100-500 | 500-2000 | ~1 天 |
| **大型** | 500-2000 | 2000-5000 | ~3 天 |
| **超大型** | >2000 | >5000 | ~1 周 |

**分解**：
- 解包：1-2 分钟
- Dump：2-5 分钟
- 资源提取：5-30 分钟
- 代码实现：60-70% 的时间
- 场景重建：5-10 分钟
- 引用修复：3-5 分钟
- 项目构建：2 分钟

---

## 🐛 常见问题

### Q: AssetRipper not found
```bash
# 检查安装
ls ~/UnPackTools/AssetRipper/

# 或手动指定
--assetRipperPath=/path/to/AssetRipper
```

### Q: dump.cs 解析失败
```bash
# 检查文件完整性
ls -lh dump.cs

# 重新生成
opencode run unity-dump --force
```

### Q: 资源提取不完整
```bash
# 手动运行 AssetRipper GUI
open ~/UnPackTools/AssetRipper/AssetRipper.GUI.Free
```

### Q: Unity 打不开项目
```bash
# 检查 Unity 版本
# 确保与游戏版本一致

# 重新修复引用
opencode run unity-reference-fixer ...
```

---

## 💡 专业技巧

### 1. 批量处理
```bash
# 使用循环批量实现类
for class in PlayerData ItemData ArrowController; do
  /impl-unity --class $class
done
```

### 2. 并行处理
```bash
# 同时运行多个工具（不同项目）
/impl-unity --class ClassA &
/impl-unity --class ClassB &
wait
```

### 3. 自动化脚本
```bash
#!/bin/bash
# auto_reverse.sh

APK=$1
OUT_DIR=~/Reverse/$(basename $APK .apk)

opencode run unity-unpack --filePath=$APK --outputDir=$OUT_DIR/unpacked
opencode run unity-dump --binaryPath=$OUT_DIR/unpacked/lib/*/libil2cpp.so \
  --metadataPath=$OUT_DIR/unpacked/assets/.../global-metadata.dat \
  --outputDir=$OUT_DIR/dump
opencode run unity-asset-extract \
  --inputPath=$OUT_DIR/unpacked \
  --outputDir=$OUT_DIR/assets

echo "✅ Automated extraction complete!"
```

---

## 📞 获取帮助

```bash
# 工具帮助
opencode run unity-asset-extract --help
/impl-unity --help

# 查看文档
cat .opencode/docs/UNITY_ASSET_TOOLS_GUIDE.md
cat .opencode/docs/UNITY_RAG_GUIDE.md

# 查看示例
cat .opencode/docs/UNITY_RAG_QUICKSTART.md
```

---

## 🎯 下一步

完成资源提取后：
1. 📖 阅读 [完整指南](./UNITY_ASSET_TOOLS_GUIDE.md)
2. 🚀 开始 [RAG 代码生成](./UNITY_RAG_QUICKSTART.md)
3. 🏗️ 构建 [完整项目](./UNITY_RAG_GUIDE.md)

---

**快速参考**  
版本: 2.0.0  
更新: 2026-05-20
