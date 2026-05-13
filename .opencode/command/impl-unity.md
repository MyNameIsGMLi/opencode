---
title: Implement Unity Classes from IL2CPP Dump
description: AI-powered C# code reconstruction from Unity IL2CPP dump.cs with IDA Pro integration
---

# Implement Unity Classes from IL2CPP Dump

Load the `unity-implement-from-dump` skill and execute the workflow to reconstruct complete C# implementations from IL2CPP dump files.

## Usage

```bash
/impl-unity [--class ClassName] [--progress] [--rebuild-cache]
```

## Parameters

- `--class ClassName`: Implement a specific class (optional, otherwise implements all pending classes)
- `--progress`: Show implementation progress statistics
- `--rebuild-cache`: Force rebuild of dump cache (fixes parsing issues)

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
# Show progress
/impl-unity --progress

# Implement all pending classes
/impl-unity

# Implement specific class
/impl-unity --class ArrowController

# Rebuild cache after dump.cs changes
/impl-unity --rebuild-cache
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
- Research notes: `<project>/.opencode/reverse_research/<ClassName>.md`
- Progress tracking: `<project>/.opencode/unity-implement-progress.json`
- Cache: `<project>/.opencode/dump_cache.json`
