---
title: Rebind Unity Assets (GUID Mapping + Asset Copy)
description: Fix Missing Script errors and copy non-script assets from AssetRipper exported project to target Unity project
---

当收到 /rebind-unity-assets 命令时，调用 unity-asset-rebinder 工具。

将参数原样传递给工具，不做任何转换。

## 用途

从 AssetRipper 导出的源 Unity 项目中，修复 Missing Script 并将非脚本资源复制到目标工程。

## 核心原理

AssetRipper 导出的 prefab/scene YAML 文件中，`m_Script.guid` 是原始游戏的 GUID，但目标工程的 `.cs.meta` 文件的 GUID 是 Unity 重新导入时生成的新 GUID，两者不一致导致 Missing Script。

本工具通过 `export2ripper_full.json`（由 ExportRipperExtended.cs 生成）提供的 `prefabPath + localFileID → className` 映射，精确识别每个 MonoBehaviour 对应的类名，然后将目标工程的 `.cs.meta` GUID 更新为原始游戏 GUID，从而消除 Missing Script。

## 参数说明

### 必填参数
- `--targetProjectPath <path>`: 目标 Unity 工程路径（接收重绑定后资源的工程）

### 源项目（至少提供其一）
- `--sourceProjectPath <path>`: AssetRipper 已导出的源 Unity 项目路径
  - 不填则从 `targetProjectPath/.opencode/unity-config.json` 的 `sourceProjectPath` 字段读取
- `--apkPath <path>`: APK/IPA/XAPK 文件路径（提供时先运行 AssetRipper 导出）

### GUID 映射 JSON
- `--exportJsonPath <path>`: export2ripper_full.json 路径
  - 默认：`sourceProjectPath/export2ripper_full.json`
- `--reExportJson`: 重新运行 ExportRipperExtended.cs 生成新 JSON（需要 Unity Editor）
  - 默认 false（使用已有 JSON）

### 工具路径（可选，有自动探测）
- `--assetRipperPath <path>`: AssetRipper 可执行文件路径
- `--unityVersion <version>`: 用于 ExportRipperExtended 的 Unity 版本
- `--unityEditorPath <path>`: Unity 可执行文件完整路径

### 资源复制控制
- `--extraExcludePaths <paths...>`: 额外排除目录（追加到默认：Scripts/, Editor/, Il2CppDump/）
- `--overwriteExisting`: 覆盖目标工程已有文件（默认 true）
- `--copyAssetsOnly`: 只复制资源，不修改 .meta（默认 false）
- `--rebindMetaOnly`: 只修改 .meta，不复制资源（默认 false）

### 增量模式
- `--incrementalClassName <ClassName>`: 仅重绑定指定类的 .meta（不复制资源）
  - 由 unity-rag-learn 学习成功后自动触发

### 行为控制
- `--dryRun`: 预览模式，只显示将要做什么（不实际修改文件）
- `--verbose`: 显示详细日志
- `--reportPath <path>`: 报告输出路径（默认：targetProjectPath/rebinding_report.json）

## 使用方式

### 首次完整导出 + 重绑定

```bash
/rebind-unity-assets \
  --sourceProjectPath /path/to/AssetRipper/exported \
  --targetProjectPath /path/to/target/unity/project
```

### 配置持久化后简化命令

在 `targetProjectPath/.opencode/unity-config.json` 中配置：
```json
{
  "sourceProjectPath": "/path/to/AssetRipper/exported",
  "assetRipperPath": "/path/to/AssetRipper"
}
```

然后只需：
```bash
/rebind-unity-assets --targetProjectPath /path/to/target/unity/project
```

### 从 APK 重新导出并重绑定

```bash
/rebind-unity-assets \
  --apkPath /path/to/game.apk \
  --sourceProjectPath /path/to/output \
  --targetProjectPath /path/to/target/unity/project
```

### 重新生成 export JSON（脚本有更新时）

```bash
/rebind-unity-assets \
  --targetProjectPath /path/to/target \
  --reExportJson \
  --rebindMetaOnly
```

### 预览模式（确认将要做什么）

```bash
/rebind-unity-assets \
  --targetProjectPath /path/to/target \
  --dryRun \
  --verbose
```

## 工作流程

### 完整工作流（首次）

```
1. /impl-unity --init              # 初始化 RAG
2. /impl-unity --class Foo         # 生成脚本（会自动触发增量重绑定）
3. /rebind-unity-assets ...        # 全量重绑定 + 资源复制
4. 打开 Unity 项目验证
```

### 后续迭代（已有资源，继续生成代码）

```
1. /impl-unity --class Bar         # 生成脚本（自动增量重绑定 .meta）
2. /rebind-unity-assets --rebindMetaOnly  # 批量更新所有新生成类的 .meta
```

## ExportRipperExtended.cs

此工具依赖 `export2ripper_full.json`，该文件需要在源 Unity 项目（AssetRipper 导出的项目）中运行 ExportRipperExtended.cs 生成。

**手动运行方式**：
- 在 Unity Editor 中打开源项目
- 点击菜单 `Tools > ExportRipper Extended`
- 点击 `Export to Project Root` 按钮

**自动运行方式**（使用 `--reExportJson`）：
- 工具自动将内嵌的 ExportRipperExtended.cs 注入源项目的 Assets/Editor/ 目录
- 通过 Unity `-batchmode -executeMethod ExportRipperExtended.BatchExport` 自动运行
- 运行完成后清理注入的脚本文件

## 报告说明

工具运行后生成 `rebinding_report.json`，包含：

| 字段 | 说明 |
|------|------|
| `scriptMetaUpdates` | 成功更新的 .meta 文件列表（含旧/新 GUID） |
| `pendingScripts` | 已识别但脚本尚未生成的类（下次运行时自动处理） |
| `unmappedGuids` | 无法识别的 GUID（第三方插件/未导出脚本，需手动处理） |
| `assetsCopied` | 各类型资源复制统计 |
| `missingExternalRefs` | 外部资源引用缺失列表（Sprite/Font/Material） |

## 后台实现

命令调用：
```
/rebind-unity-assets → unity-asset-rebinder 工具
```

代码生成自动触发增量重绑定：
```
/impl-unity --class Foo
  → unity-rag-learn (compileSuccess=true)
    → unity-asset-rebinder (incrementalClassName=Foo, rebindMetaOnly=true)
```
