---
title: Open IL2CPP Binary in IDA Pro
description: Launch IDA Pro to analyze Unity IL2CPP binaries with automatic path detection
---

Open the specified IL2CPP binary file in IDA Pro for deep analysis. If a directory is provided, automatically locate libil2cpp.so within it.

## Instructions

1. **Find IDA Pro installation**:
   - Search for IDA Pro in `/Applications/` (macOS)
   - Try common patterns: `IDA Professional 9.x`, `IDA Pro 7.x`, etc.
   - Use `mdfind` or `find` to locate the application

2. **Locate IL2CPP binary** (if directory provided):
   - Search for `libil2cpp.so` in common Android paths:
     - `lib/armeabi-v7a/libil2cpp.so` (32-bit ARM)
     - `lib/arm64-v8a/libil2cpp.so` (64-bit ARM)
   - Search recursively in APK extraction directories

3. **Launch IDA Pro**:
   - Use `open -a` command on macOS
   - Switch to the binary's directory first for cleaner database paths
   - Example: `cd <binary-dir> && open -a "/Applications/IDA Professional 9.2.app" libil2cpp.so`

4. **Handle prompts**:
   - If database exists, inform user about overwrite prompt
   - Recommend "Yes" for clean re-analysis
   - Check if IDA process is running with `ps aux | grep -i ida`

## Example Implementation

When user runs `/ida <path>`, execute:
- Find IDA Pro in `/Applications/`
- If path is directory, find libil2cpp.so
- Launch: `cd <dir> && open -a <ida-path> <binary>`
- Wait 3 seconds and verify IDA is running
- Report status to user

## Usage

```bash
/ida <path-to-libil2cpp.so-or-directory>
```

## Parameters

- `<path>`: Path to libil2cpp.so file or directory containing it (required)

## What It Does

1. Detects IDA Pro installation on macOS (IDA Professional 9.x, IDA Pro 7.x, etc.)
2. Locates libil2cpp.so if a directory is provided
3. Launches IDA Pro with the IL2CPP binary
4. Handles existing database prompts automatically

## Requirements

- IDA Pro installed in `/Applications/` (macOS)
- IL2CPP binary from Unity game (typically `libil2cpp.so` for Android ARM)

## Example

```bash
# Open specific libil2cpp.so file
/ida /Users/ggm/UnPackAPP/MyGame/lib/armeabi-v7a/libil2cpp.so

# Auto-detect libil2cpp.so in APK extraction directory
/ida "/Users/ggm/UnPackAPP/Arrows – Puzzle Escape_0.17.0_APKPure"

# Open from Unity project dump directory
/ida /Users/ggm/UnPackAPP/arrows_unity_project
```

## How It Works

1. **Find IDA Pro**: Searches for IDA installations:
   - `/Applications/IDA Professional 9.x.app`
   - `/Applications/IDA Pro 7.x.app`
   - Other common locations

2. **Locate Binary**: If directory provided, searches for:
   - `lib/armeabi-v7a/libil2cpp.so` (Android ARM 32-bit)
   - `lib/arm64-v8a/libil2cpp.so` (Android ARM 64-bit)
   - Other common IL2CPP binary locations

3. **Launch IDA**: Opens IDA Pro with the binary file
   - For fresh analysis: Will prompt for processor type (select ARM)
   - For existing database: Will prompt to overwrite (recommend "Yes" for clean analysis)

## Integration with Il2CppDumper

After IDA loads the binary, you can import Il2CppDumper results:

1. In IDA, run: **File → Script File**
2. Select: `Il2CppDumper/ida_with_struct_py3.py`
3. When prompted, load: `script.json` from your dump directory

This will restore all class names, method names, and structures in IDA.

## Supported Platforms

- **macOS**: Full support with automatic IDA detection
- **Windows**: Searches `C:\Program Files\IDA*\ida64.exe`
- **Linux**: Searches `/opt/ida*/ida64`

## Notes

- IDA may take several minutes to analyze large IL2CPP binaries
- Database files (`.idb`, `.i64`) are created in the same directory as the binary
- Use "Yes" when prompted to overwrite existing database for clean re-analysis
- For ARM binaries, IDA will auto-detect the processor type
