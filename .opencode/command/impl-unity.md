---
title: Implement Unity Classes from IL2CPP Dump
description: AI-powered C# code reconstruction from Unity IL2CPP dump.cs with IDA Pro integration
---

# Implement Unity Classes from IL2CPP Dump

Load the `unity-implement-from-dump` skill and execute the workflow to reconstruct complete C# implementations from IL2CPP dump files.

## Usage

```bash
/impl-unity [--class ClassName] [--progress] [--rebuild-cache] [--analyze ModulePath] [--analyze-all] [-help]
```

## Parameters

- `--class ClassName`: 实现指定的 C# 类（若不指定则自动处理下一个）。
- `--progress`: 查看整体工程和各模块的实现进度统计。
- `--rebuild-cache`: 强制重新解析 dump.cs 并更新缓存（在 dump 文件变动后使用）。
- `--analyze ModulePath`: 深度分析指定模块的职责（例如 Gameplay/Arrow），产出分析报告至 `implExport/`。
- `--analyze-all`: 批量分析工程内所有模块，产出全量分析报告至 `implExport/`。
- `-help`: 显示此帮助信息，列出所有可用命令及其说明。

## What It Does

1. Loads the `unity-implement-from-dump` skill
2. Parses `dump.cs` and `script.json` to extract class stubs and method signatures
3. Applies universal filtering rules to exclude Unity engine, system libraries, and third-party SDKs
4. Classifies classes into tiers (A: auto-generate, B: template-fill, C: custom logic)
5. Integrates with IDA Pro RPC (`http://localhost:7734`) for deep code analysis
6. Generates complete C# implementations with zero stubs/TODOs
7. Tracks progress in `.opencode/unity-implement-progress.json`

## Requirements

- Unity IL2CPP dump files: `dump.cs`, `script.json`
- IDA Pro with RPC server running (optional but recommended for 95%+ accuracy)
- Project structure: `<project>/Assets/Il2CppDump/`

## Example

```bash
# 显示帮助信息
/impl-unity -help

# 查看进度
/impl-unity --progress

# 实现特定类
/impl-unity --class ArrowController

# 分析模块职责
/impl-unity --analyze Gameplay/Arrow

# 分析所有模块
/impl-unity --analyze-all
```

## Configuration

Project-specific filters in `.opencode/filter.json`:

```json
{
  "skip_assemblies": [
    "AdRules.*",
    "Metrics.dll",
    "ContentTracking.dll"
  ],
  "skip_classes": [
    "TrackingService",
    "MetricTracker",
    "IapService"
  ]
}
```

## Output

- Implemented classes: `<project>/Assets/Scripts/`
- Research notes (MD docs): `<project>/implExport/<ClassName>.md`
- Progress tracking: `<project>/.opencode/unity-implement-progress.json`
- Cache: `<project>/.opencode/dump_cache.json`
