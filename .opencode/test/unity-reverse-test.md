# Unity Reverse Engineering Test Suite

Test cases to verify the complete reverse engineering workflow.

## Test 1: Environment Check

**Purpose:** Verify all dependencies are installed

**Command:**

```bash
.opencode/scripts/check-unity-reverse-env.sh
```

**Expected Result:**

- ✓ All required tools found
- ✓ API key configured
- ✓ Il2CppDumper built
- Optional: IDA Pro and Unity Editor detected

**Pass Criteria:** 0 errors

---

## Test 2: Tool Availability

**Purpose:** Verify all OpenCode tools are registered

**Command:**

```
List all tools matching "unity-"
```

**Expected Result:**
Should show 6 tools:

- unity-unpack
- unity-dump
- unity-target-finder
- unity-reverse
- unity-validate
- unity-workflow-orchestrator

**Pass Criteria:** All 6 tools listed

---

## Test 3: APK Unpacking

**Purpose:** Test basic APK extraction

**Setup:**

```bash
# Download a small Unity game APK for testing
# Or use a test APK from examples/
```

**Command:**

```
Use unity-unpack on ./test-game.apk
```

**Expected Result:**

- ✓ Unpacked to test-game.apk_extracted/
- ✓ libil2cpp.so found
- ✓ global-metadata.dat found
- ✓ isUnityIl2cpp: true

**Pass Criteria:** All files extracted, metadata indicates Unity IL2CPP

---

## Test 4: IL2CPP Metadata Extraction

**Purpose:** Test Il2CppDumper integration

**Command:**

```
Use unity-dump with:
- binary: ./test-game_extracted/lib/arm64-v8a/libil2cpp.so
- metadata: ./test-game_extracted/assets/bin/Data/Managed/Metadata/global-metadata.dat
- output: ./test_dump
```

**Expected Result:**

- ✓ dump.cs generated
- ✓ script.json generated
- ✓ Statistics show classes and methods
- ✓ DummyDll folder created

**Pass Criteria:** All output files present, statistics > 0

---

## Test 5: Target Identification

**Purpose:** Test game code filtering

**Command:**

```
Use unity-target-finder on ./test_dump/dump.cs
```

**Expected Result:**

- ✓ Total classes parsed
- ✓ Third-party classes filtered
- ✓ Game classes identified
- ✓ Classes sorted by priority

**Pass Criteria:** Game classes > 0, third-party filtering works

---

## Test 6: Single Class Reverse

**Purpose:** Test AI-powered code generation for one class

**Setup:**

```bash
# Pick a simple class from targets.json
```

**Command:**

```
Use unity-reverse on class "Game.SimpleClass":
- dumpCs: ./test_dump/dump.cs
- scriptJson: ./test_dump/script.json
- outputDir: ./test_reversed
```

**Expected Result:**

- ✓ C# file generated
- ✓ File compiles (basic validation)
- ✓ All methods have implementations
- Success: true

**Pass Criteria:** File generated, basic syntax valid

---

## Test 7: Code Validation

**Purpose:** Test Roslyn compilation

**Command:**

```
Use unity-validate on files in ./test_reversed
```

**Expected Result:**

- ✓ Compilation attempted
- ✓ Errors/warnings reported
- ✓ Validation report generated

**Pass Criteria:** Validation runs (pass/fail depends on generated code quality)

---

## Test 8: Complete Workflow (Small Game)

**Purpose:** End-to-end test on a small game

**Setup:**

```bash
# Use a simple Unity casual game APK (~100-200 classes)
```

**Command:**

```
Use unity-workflow-orchestrator:
- inputFile: ./small-game.apk
- outputDir: ./small-game_reversed
- enableIda: false  # For faster testing
- batchSize: 20
```

**Expected Result:**

- ✓ All 5 stages complete
- ✓ Success rate ≥ 70% (without IDA)
- ✓ REVERSE_REPORT.md generated
- ✓ Reversed C# files created

**Pass Criteria:**

- Workflow completes
- Success rate > 70%
- Report generated

**Estimated Time:** 15-30 minutes

---

## Test 9: Complete Workflow (With IDA)

**Purpose:** Test with IDA Pro for maximum accuracy

**Prerequisites:** IDA Pro installed

**Command:**

```
Use unity-workflow-orchestrator:
- inputFile: ./small-game.apk
- outputDir: ./small-game_ida_reversed
- enableIda: true
- batchSize: 20
```

**Expected Result:**

- ✓ IDA analysis runs
- ✓ ida_analysis.json generated
- ✓ Success rate ≥ 85% (with IDA)

**Pass Criteria:**

- IDA analysis completes
- Success rate > 85%

**Estimated Time:** 45-60 minutes

---

## Test 10: XAPK Handling

**Purpose:** Test XAPK with OBB files

**Command:**

```
Use unity-unpack on ./game-with-obb.xapk
```

**Expected Result:**

- ✓ Main APK extracted
- ✓ OBB files extracted
- ✓ All components identified

**Pass Criteria:** XAPK properly unpacked with OBB

---

## Test 11: Error Handling

**Purpose:** Test graceful failure on invalid input

**Test Cases:**

### 11a: Non-Unity APK

```
Use unity-unpack on ./non-unity-app.apk
```

**Expected:** Warning that it's not Unity IL2CPP

### 11b: Corrupted File

```
Use unity-dump with invalid binary
```

**Expected:** Error message, workflow doesn't crash

### 11c: Missing API Key

```bash
unset ANTHROPIC_API_KEY
# Try to reverse a class
```

**Expected:** Clear error about missing API key

**Pass Criteria:** All errors handled gracefully with helpful messages

---

## Test 12: Checkpoint Recovery

**Purpose:** Test workflow resume from checkpoint

**Setup:**

```bash
# Start a workflow and interrupt it mid-way (Ctrl+C)
```

**Command:**

```
# Resume from checkpoint
Use unity-workflow-orchestrator with same outputDir
```

**Expected Result:**

- ✓ Detects existing checkpoint
- ✓ Resumes from last saved state
- ✓ Doesn't re-process completed classes

**Pass Criteria:** Resume works, no duplicate work

---

## Test 13: Validation with Unity DLLs

**Purpose:** Test Roslyn with actual Unity references

**Prerequisites:** Unity Editor installed

**Command:**

```
Use unity-validate:
- sourceFiles: ./test_reversed/*.cs
- unityVersion: "2021.3"
```

**Expected Result:**

- ✓ Unity DLLs found and loaded
- ✓ Compilation with Unity references
- ✓ Type checking against Unity APIs

**Pass Criteria:** Validation uses Unity DLLs successfully

---

## Test 14: Large Game Performance

**Purpose:** Test scalability on large codebase

**Setup:**

```bash
# Use a game with 1000+ classes
```

**Command:**

```
Use unity-workflow-orchestrator:
- inputFile: ./large-game.apk
- enableIda: true
- batchSize: 100
```

**Expected Result:**

- ✓ Completes within 4 hours
- ✓ Memory usage < 8GB
- ✓ Checkpoints created every 100 classes
- ✓ Success rate ≥ 80%

**Pass Criteria:**

- Completes successfully
- Checkpoints work
- Memory doesn't explode

---

## Test 15: Agent Interaction

**Purpose:** Test reverse-execute agent

**Command:**

```
@reverse-execute Reverse engineer ./test-game.apk step by step
```

**Expected Result:**

- ✓ Agent uses appropriate tools
- ✓ Reports progress at each stage
- ✓ Provides clear status updates

**Pass Criteria:** Agent successfully orchestrates workflow

---

## Test 16: Skill Invocation

**Purpose:** Test skill-based workflow

**Command:**

```
Use unity-reverse-workflow skill on ./test-game.apk
```

**Expected Result:**

- ✓ Skill loads and executes
- ✓ All stages run in sequence
- ✓ Final report generated

**Pass Criteria:** Skill completes workflow successfully

---

## Performance Benchmarks

Record these metrics for regression testing:

| Game Size | Classes  | Time (no IDA) | Time (with IDA) | Success Rate |
| --------- | -------- | ------------- | --------------- | ------------ |
| Small     | 100-300  | ~30 min       | ~60 min         | 85-90%       |
| Medium    | 300-800  | ~60 min       | ~120 min        | 80-85%       |
| Large     | 800-2000 | ~120 min      | ~240 min        | 75-80%       |

---

## Regression Tests

Run these before each release:

```bash
# Quick smoke test (5 min)
./test/smoke-test.sh

# Full test suite (2 hours)
./test/full-test.sh

# Performance benchmarks (4 hours)
./test/benchmark.sh
```

---

## Test Report Template

```markdown
# Test Run Report

**Date:** YYYY-MM-DD
**Version:** OpenCode vX.Y.Z
**Environment:** macOS/Linux

## Results

| Test              | Status | Notes            |
| ----------------- | ------ | ---------------- |
| Environment Check | ✓ Pass | All deps present |
| Tool Availability | ✓ Pass | 6/6 tools        |
| APK Unpacking     | ✓ Pass | -                |
| IL2CPP Dump       | ✓ Pass | -                |
| Target Finder     | ✓ Pass | Filtered 500/700 |
| Single Class      | ✓ Pass | Compiled OK      |
| Validation        | ✓ Pass | No errors        |
| Small Game        | ✓ Pass | 88% success      |
| With IDA          | ✓ Pass | 92% success      |
| XAPK              | ✓ Pass | -                |
| Error Handling    | ✓ Pass | -                |
| Checkpoint        | ✓ Pass | -                |
| Unity DLLs        | ✓ Pass | -                |
| Large Game        | ✓ Pass | 82% success      |
| Agent             | ✓ Pass | -                |
| Skill             | ✓ Pass | -                |

## Summary

- **Pass:** 16/16
- **Fail:** 0/16
- **Skip:** 0/16

✓ All tests passed
```

---

## Running Tests

```bash
# Check environment first
.opencode/scripts/check-unity-reverse-env.sh

# Run individual test
opencode "Run test 3: APK Unpacking"

# Run all tests
opencode "Run full Unity reverse engineering test suite"
```

---

## CI/CD Integration

```yaml
# .github/workflows/test-unity-reverse.yml
name: Unity Reverse Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v2
      - name: Setup .NET
        uses: actions/setup-dotnet@v1
      - name: Check Environment
        run: .opencode/scripts/check-unity-reverse-env.sh
      - name: Build Il2CppDumper
        run: cd packages/opencode/unity-reverse-tools/scripts && ./setup-il2cppdumper.sh
      - name: Run Tests
        run: ./test/smoke-test.sh
```
