# unity-game-reverse-visual Agent Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix four design defects in `unity-game-reverse-visual.md` that caused 68 compile errors in the PixelFlow test, then retest and verify.

**Architecture:** Four targeted edits to `.opencode/agent/unity-game-reverse-visual.md` — Stage 4 adds dependency graph analysis and a new "Interface/Base" pre-track, Stage 5 adds incremental compile every 10 classes and per-track ordering. No changes to subagents or tools.

**Tech Stack:** OpenCode agent markdown files only.

---

## Defects Being Fixed

| # | Defect | Root Cause | Fix |
|---|--------|-----------|-----|
| 1 | Track B ignores interface dependencies | Classes with `IAttachmentSource` etc. were inferred without knowing the interface contract | Stage 4: detect interfaces/abstract bases, create pre-track P (Precise) |
| 2 | No dependency ordering in Stage 5 | All 97 B-track classes generated in arbitrary order | Stage 5: run unity-target-finder to get topological order before implementing |
| 3 | Inference allowed on compile-dependency types | Interface/abstract base stubs were incomplete causing downstream CS1061 | Stage 4/5: interfaces and abstract bases use dump.cs exact signatures, no inference |
| 4 | Batch compile too late (Stage 6) | Errors found after all 108 classes written | Stage 5: incremental compile every 10 classes |

---

## Task 1: Add Pre-Track P (Precise) to Stage 4

**Files:**
- Modify: `.opencode/agent/unity-game-reverse-visual.md`

**Step 1: Read the Stage 4 section**

Read `.opencode/agent/unity-game-reverse-visual.md` lines 203–263 to understand current three-track classification.

**Step 2: Insert Pre-Track P definition**

In Stage 4, section `### 4b. 三轨分类规则`, find the line:

```
对每个关键玩法类，按以下规则分配轨道（优先级：C > A > B）：
```

Replace it with:

```
对每个关键玩法类，按以下规则分配轨道（优先级：P > C > A > B）：

**前置轨道 P（精确签名，最高优先级）** — 满足任一条件：
- 类型是 `interface`（dump.cs 中 `public interface`）
- 类型是抽象基类（`public abstract class`）
- 被其他关键玩法类的字段/方法参数直接引用（依赖图入度 > 2）
- 实现策略：**严格按 dump.cs 方法签名生成**，不允许推断缺省实现，每个方法体抛出 `NotImplementedException` 或返回默认值（接口）/调用 base（抽象类），禁止遗漏任何成员
- IDA：不需要，但不允许简化签名
- **必须在所有其他轨道之前实现完毕**
```

**Step 3: Add P-track state field**

In Stage 4 section `用户确认后：`, after the line about `track_c_classes`, add:

```
- 写入 `track_p_classes` 到状态文件（接口/抽象基类，最先实现）
- `core_classes.json` 中每条记录的 `track` 字段新增 `"P"` 值
```

**Step 4: Add P-track to state JSON**

In `## 启动逻辑` section, in the state file JSON block, after `"track_c_classes": [],` add:

```json
"track_p_classes": [],
```

**Step 5: Add P-track to Stage 4c display template**

In the user confirmation dialog template (section `### 4c`), after the Track C example block, add:

```
前置轨道 P（精确签名，共 N 个，最先实现）：
  - IAttachmentSource  [interface，被 5 个类引用]
  - AttachablesSystem  [abstract class，被 3 个类引用]
```

**Step 6: Commit**

```bash
cd /Users/ggm/SelfProjects/PrivateOpenCode/opencode
git add .opencode/agent/unity-game-reverse-visual.md
git commit -m "fix(agent): add pre-track P for interfaces and abstract bases to visual agent"
```

---

## Task 2: Add Dependency Analysis to Stage 4a

**Files:**
- Modify: `.opencode/agent/unity-game-reverse-visual.md`

**Step 1: Read Stage 4a section**

Read the `### 4a. 定位核心玩法场景` section (around lines 207–217).

**Step 2: Add dependency graph step**

After the `unity-core-scene-finder` call block and before `从返回的关键玩法类清单开始三轨分类`, insert:

```markdown
### 4a-2. 依赖图分析（P 轨识别）

在三轨分类前，对关键玩法类清单做依赖分析，识别 P 轨候选：

```bash
# 从 dump.cs 提取接口和抽象基类
python3 -c "
import re, json
dump = open('<dumpCsPath>').read()
classes = []

# 找接口
for m in re.finditer(r'// Namespace: (.*?)\npublic interface (\w+)', dump):
    classes.append({'name': m.group(2), 'namespace': m.group(1), 'track': 'P', 'reason': 'interface'})

# 找抽象基类
for m in re.finditer(r'// Namespace: (.*?)\npublic abstract class (\w+)', dump):
    classes.append({'name': m.group(2), 'namespace': m.group(1), 'track': 'P', 'reason': 'abstract_class'})

# 过滤只保留关键玩法类清单中的
core_names = set([c['name'] for c in json.load(open('<workDir>/core_classes.json'))])
p_classes = [c for c in classes if c['name'] in core_names]
print(json.dumps(p_classes, indent=2))
" > <workDir>/track_p_candidates.json
```

将 `track_p_candidates.json` 中的类从三轨候选中提升为 P 轨。
```

**Step 3: Commit**

```bash
cd /Users/ggm/SelfProjects/PrivateOpenCode/opencode
git add .opencode/agent/unity-game-reverse-visual.md
git commit -m "fix(agent): add dependency graph analysis step to Stage 4a for P-track detection"
```

---

## Task 3: Add P-Track and Ordered Execution to Stage 5

**Files:**
- Modify: `.opencode/agent/unity-game-reverse-visual.md`

**Step 1: Read Stage 5 section**

Read `.opencode/agent/unity-game-reverse-visual.md` lines 265–318.

**Step 2: Add ordering step before the implementation loop**

At the START of Stage 5, before the `### 轨道 A 处理流程` section, insert:

```markdown
### 前置步骤：依赖顺序排列

在实现任何类之前，先用 `unity-target-finder` 获取拓扑顺序：

```
unity-target-finder(
  dumpCsPath: dumpDir + "/dump.cs",
  outputPath: workDir + "/ordered_classes.json"
)
```

按以下顺序实现：
1. **P 轨全部类**（接口/抽象基类，严格按签名，最先完成）
2. **A 轨全部类**（资产调用层）
3. **C 轨全部类**（DOTween 估算）
4. **B 轨类**（按 unity-target-finder 返回的拓扑顺序，被依赖的先实现）

### 轨道 P 处理流程

派发 `@unity-code-generator`，传入：
- `className`、`projectDir`、`dumpDir`
- `mode: "visual"`、`track: "P"`

**P 轨严格规则**：
- 接口：每个方法返回默认值（`return default;`），**不允许省略任何方法**
- 抽象基类：每个抽象方法提供 `throw new NotImplementedException();` 实现，非抽象方法调用 base
- 禁止推断、禁止简化签名、禁止遗漏成员
- P 轨编译失败 → **立即 BLOCKED**（不走重试逻辑），必须修复后才能继续
```

**Step 3: Add incremental compile every 10 classes**

After the existing progress report block (around line 310, `每完成 5 个类`), change it to:

```markdown
每完成 10 个类，执行一次增量编译检查：

```
unity-editor-compile(
  projectPath: projectDir,
  timeout: 120
)
```

- 0 错误 → 继续
- 有错误 → 立即修复当前批次后再继续（不跨批次积累错误）
- 超过 3 次修复仍有同类错误 → **BLOCKED**，报告错误清单，停止

进度报告格式（每 10 个类）：
```
进度：N/Total | P轨: X/Xp | A轨: Y/Ya | B轨: Z/Zb | C轨: W/Wc
增量编译：✅ 0 错误（或 ❌ N 个错误）
```
```

**Step 4: Add P-track to code-generator visual mode note**

In `.opencode/agent/unity-code-generator.md`, in the `### Step 1.2：模式判断` section, add Track P:

Find the line `#### visual + Track A（资产驱动）` and insert BEFORE it:

```markdown
#### visual + Track P（精确签名）
严格按 dump.cs 签名生成，不推断：
- 接口：所有方法 `return default;`，不省略任何成员
- 抽象基类：所有抽象方法 `throw new NotImplementedException();`，非抽象方法调用 base
- 禁止任何推断，禁止遗漏方法
- 编译失败不走重试，直接返回 `status: "blocked"`

```

**Step 5: Commit**

```bash
cd /Users/ggm/SelfProjects/PrivateOpenCode/opencode
git add .opencode/agent/unity-game-reverse-visual.md .opencode/agent/unity-code-generator.md
git commit -m "fix(agent): add P-track ordered execution and incremental compile to Stage 5"
```

---

## Task 4: Verify both files are well-formed

**Files:**
- Read: `.opencode/agent/unity-game-reverse-visual.md`
- Read: `.opencode/agent/unity-code-generator.md`

**Step 1: Check stage headings still intact**

```bash
grep "^## Stage" /Users/ggm/SelfProjects/PrivateOpenCode/opencode/.opencode/agent/unity-game-reverse-visual.md
```

Expected: all 8 stages present.

**Step 2: Check P-track mentions**

```bash
grep -n "track.*P\|P 轨\|Track P\|track_p" /Users/ggm/SelfProjects/PrivateOpenCode/opencode/.opencode/agent/unity-game-reverse-visual.md | head -15
```

Expected: lines in Stage 4b, Stage 5, state JSON block.

```bash
grep -n "Track P\|track.*P" /Users/ggm/SelfProjects/PrivateOpenCode/opencode/.opencode/agent/unity-code-generator.md | head -10
```

Expected: Track P section in Step 1.2.

**Step 3: Check incremental compile mention**

```bash
grep -n "增量编译\|incremental.*compile\|unity-editor-compile" /Users/ggm/SelfProjects/PrivateOpenCode/opencode/.opencode/agent/unity-game-reverse-visual.md | head -10
```

Expected: lines in Stage 5.

**Step 4: Final commit**

```bash
cd /Users/ggm/SelfProjects/PrivateOpenCode/opencode
git add .opencode/agent/unity-game-reverse-visual.md .opencode/agent/unity-code-generator.md
git commit -m "chore(agent): verify visual agent and code-generator after P-track fixes" --allow-empty
```

---

## Task 5: Retest with PixelFlow IPA

**This task is manual verification — run the visual agent on the existing PixelFlow data.**

The test should use the **already-extracted data** from the previous run (dump.cs, DummyDll, source_export all exist) to save time. Only Stage 4 and Stage 5 need to re-run since that's where the defects were.

**Setup:**

```bash
# Clean up previous visual reverse attempt
rm -rf /Users/ggm/UnPackAPP/APKIPA/PixelFlow_visual_reverse/

# The agent will re-create it from Stage 0 but skip Stage 1 (dump exists) and Stage 2-3 (source_export exists)
```

**Expected outcomes after fix:**
1. Stage 4 identifies interfaces/abstract classes as P-track
2. Stage 5 implements P-track first
3. Incremental compile every 10 classes catches errors early
4. Stage 6 compile result: 0 errors (vs 867 before)
5. Stage 7 assessment: READY

**Report back:**
- Stage 4: how many P-track classes identified
- Stage 5: first incremental compile result (after 10 classes)
- Stage 6: final compile error count
- Stage 7: assessment result

---

## Summary

| Task | File | Change |
|------|------|--------|
| 1 | `unity-game-reverse-visual.md` | Add pre-track P definition to Stage 4b + state JSON |
| 2 | `unity-game-reverse-visual.md` | Add dependency graph analysis to Stage 4a-2 |
| 3 | `unity-game-reverse-visual.md` + `unity-code-generator.md` | Add P-track ordered execution + incremental compile to Stage 5 |
| 4 | Both files | Verify well-formed |
| 5 | Manual | Retest with PixelFlow IPA |
