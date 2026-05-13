---
title: Fix Unity Compilation Errors
description: Automated Unity C# compilation error fixing with iterative feedback loop
---

# Fix Unity Compilation Errors

Load the `unity-compile-fix` skill and automatically fix compilation errors in Unity C# scripts through iterative compilation and AI-powered error resolution.

## Usage

```bash
/fix-unity [--max-iterations N] [--focus-file FilePath]
```

## Parameters

- `--max-iterations N`: Maximum fix iterations (default: 10)
- `--focus-file FilePath`: Focus on a specific file with errors (optional)

## What It Does

1. Loads the `unity-compile-fix` skill
2. Triggers Unity Editor compilation (requires Unity Editor running)
3. Parses compilation errors from Unity Console logs
4. Groups errors by file and type (syntax, type, reference, etc.)
5. Applies AI-powered fixes to resolve errors
6. Re-compiles and verifies fixes
7. Repeats until all errors resolved or max iterations reached

## Requirements

- Unity Editor must be running and focused on the project
- Unity project must be open in the editor
- Compilation must be triggerable (not in play mode)

## Example

```bash
# Fix all compilation errors (max 10 iterations)
/fix-unity

# Fix with custom iteration limit
/fix-unity --max-iterations 20

# Fix errors in specific file
/fix-unity --focus-file Assets/Scripts/ArrowController.cs
```

## How It Works

1. **Trigger Compilation**: Focuses Unity Editor window and waits for compilation
2. **Parse Errors**: Extracts errors from Unity Console (Editor.log or Console output)
3. **Categorize**: Groups errors by:
   - Syntax errors (missing semicolons, braces)
   - Type errors (missing types, wrong signatures)
   - Reference errors (missing using statements, undefined members)
   - Missing dependencies (assets, packages)
4. **Apply Fixes**: Uses AI to generate contextual fixes based on:
   - Error messages
   - Surrounding code context
   - Unity API patterns
   - Project conventions
5. **Verify**: Re-compiles and checks if errors resolved
6. **Iterate**: Repeats until clean or max iterations

## Common Error Types Fixed

- Missing `using` statements
- Incorrect method signatures
- Type mismatches (int vs float, string vs object)
- Missing semicolons, braces, parentheses
- Undefined variables or members
- Wrong namespace declarations
- Asset reference issues
- Generic type constraints

## Output

- Fixed files are edited in-place
- Compilation log: `<project>/Library/unity-compile-fix.log`
- Progress tracking with error count per iteration
- Final summary: errors fixed, errors remaining, iterations used

## Notes

- Unity Editor must stay focused during compilation checks
- Manual intervention needed if iteration limit reached without full resolution
- Some errors (missing assets, package dependencies) require manual setup
- Works best with Unity 2019.4+ (console log format compatibility)
