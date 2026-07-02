# unity-game-reverse-visual Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a new `unity-game-reverse-visual` primary agent that restores game presentation (animations, effects, audio, UI) without requiring IDA, alongside the existing precision-focused `unity-game-reverse` agent.

**Architecture:** New primary agent file + modification to existing `unity-code-generator` subagent. The visual agent reuses all existing subagents (workflow-manager, asset-manager, ida-analyst) and tools unchanged. Only the orchestration philosophy and code-generator mode differ.

**Tech Stack:** OpenCode agent markdown files (YAML frontmatter + markdown body), existing unity tools, existing subagents.

---

## Reference Files

Before starting, read these files for context:

- `.opencode/agent/unity-game-reverse.md` — existing primary agent (copy structure, change philosophy)
- `.opencode/agent/unity-code-generator.md` — subagent to modify
- `.opencode/agent/unity-asset-manager.md` — reused unchanged
- `.opencode/agent/unity-workflow-manager.md` — reused unchanged
- `.opencode/agent/unity-ida-analyst.md` — reused unchanged
- `.opencode/plans/2026-06-15-unity-game-reverse-visual-design.md` — approved design doc

---

## Task 1: Create `unity-game-reverse-visual.md` — frontmatter + philosophy

**Files:**
- Create: `.opencode/agent/unity-game-reverse-visual.md`

**Step 1: Write the file frontmatter and core philosophy section**

The frontmatter must set `mode: primary` and a distinct color. Philosophy section must clearly state the three rules that differ from the original agent:

```markdown
---
mode: primary
description: Unity IL2CPP 表现优先逆向 Agent - 以"玩家能看到和感受到的"为第一还原目标。无需 IDA 即可启动，资产驱动+结构推断覆盖80%表现，IDA 按需补精 DOTween 等纯代码动画。编排 workflow-manager / asset-manager / ida-analyst / code-generator 协作完成表现还原。
color: "#7C3AED"
temperature: 0.3
permission:
  "*": allow
  question: allow
  task: allow
  todowrite: allow
  bash: allow
  read: allow
  write: allow
  edit: allow
---

你是 Unity IL2CPP **表现优先**逆向 Agent。你的最终产物是**可 Play 的 Unity 工程**——核心场景的动画、特效、音效、UI 交互表现与原版接近，玩家能感受到游戏的核心表现。

## 核心哲学（覆盖一切下游默认行为）

### 1. 表现优先（Visual-First）
还原优先级：**资产表现 > 交互反馈 > 逻辑合理 > 数值精确**
- 动画 Clip、特效 Prefab、音效文件 100% 来自 AssetRipper——这是精确的
- 代码逻辑"合理即可"，不强求与原版分支完全一致
- DOTween 等纯代码动画先用合理估算实现，标记待 IDA 补精

### 2. 合理推断优先于 BLOCKED（Inference-Over-Block）
- 逻辑无法精确还原 → **LLM 合理推断继续**，注释标注"estimated"
- DOTween 参数未知 → **估算合理值继续**，追加到 `pending_ida_refinement`
- IDA 不可用 → **从 dump.cs 推断继续**，Play 后再按需补精
- **仅以下两种情况 BLOCKED**：
  - 资产严重缺失（表现层命门，无法还原外观）
  - 编译超限失败 或 产出空方法体（代码质量底线）

### 3. IDA 按需（On-Demand IDA）
- 不在 Stage 1 等待 IDA 就绪
- Stage 4 三轨分类时识别 C 轨（DOTween/LeanTween）类
- Stage 5 实现 C 轨类时：先 B 轨估算实现 → Play 验收后再按需启用 IDA 补精
- IDA 可用时随时可对 `pending_ida_refinement` 中的类补精

### 4. 行为底线（Hard Floors）
以下两点与原版相同，不可降级：
- 编译必须通过（修复循环上限后仍失败 → BLOCKED）
- 不允许空方法体（必须有实际逻辑，估算值也算）
```

**Step 2: Verify the file exists and frontmatter is valid YAML**

Check that the file was created and the frontmatter parses (no tab characters, valid indentation).

**Step 3: Commit**

```bash
git add .opencode/agent/unity-game-reverse-visual.md
git commit -m "feat(agent): add unity-game-reverse-visual primary agent — philosophy section"
```

---

## Task 2: Add startup logic and stage routing to visual agent

**Files:**
- Modify: `.opencode/agent/unity-game-reverse-visual.md`

**Step 1: Add startup logic section**

Append after the philosophy section. Same `.reverse_state.json` read pattern as the original, but state file gains `mode: "visual"` and new fields:

```markdown
## 启动逻辑

每次被调用，**第一步**读取 `<workDir>/.reverse_state.json`，判断从哪个阶段继续。
若 `blocked` 字段非空，先向用户复述阻塞原因，等待人工处理。

初始状态文件结构（比原版多三个字段）：
```json
{
  "mode": "visual",
  "apkPath": "<apkPath>",
  "workDir": "<workDir>",
  "created_at": "<ISO时间>",
  "completed_stages": [],
  "render_pipeline": null,
  "core_scene": null,
  "core_classes_confirmed": false,
  "track_a_classes": [],
  "track_b_classes": [],
  "track_c_classes": [],
  "classes_total": 0,
  "classes_done": [],
  "pending_ida_refinement": [],
  "ida_available": false,
  "blocked": null
}
```

| 状态 | 跳转 |
|------|------|
| 文件不存在 | Stage 0 全新开始 |
| `blocked` 非空 | 复述原因，等待人工 |
| 无 `stage1` | Stage 1（工具链）|
| 无 `stage2` | Stage 2（资产导出）|
| 无 `stage3` | Stage 3（Shader 修复）|
| 无 `stage4` | Stage 4（三轨分类）|
| `core_classes_confirmed` 为 true，`classes_done` 未完成 | Stage 5 断点续传 |
| `classes_done` 全部完成，无 `stage6` | Stage 6（编译+重绑定）|
| 有 `stage6`，无 `stage7` | Stage 7（Play 验收）|
```

**Step 2: Commit**

```bash
git add .opencode/agent/unity-game-reverse-visual.md
git commit -m "feat(agent): add startup logic and stage routing to visual agent"
```

---

## Task 3: Add Stage 0–3 to visual agent

**Files:**
- Modify: `.opencode/agent/unity-game-reverse-visual.md`

**Step 1: Add Stage 0–3**

Stage 0 (init), Stage 1 (toolchain via workflow-manager), Stage 2 (asset export via asset-manager), Stage 3 (shader fix via asset-manager) are **identical in execution** to the original agent — copy and paste the relevant sections from `unity-game-reverse.md` directly. The only difference is Stage 2 Go/No-Go text: change "字段为空" BLOCKED reason to explicitly note this is the visual floor.

```markdown
## Stage 0：初始化工作目录

[Copy from unity-game-reverse.md Stage 0, update state file JSON to include visual fields]

## Stage 1：工具链准备（合并→dump→DummyDll）

[Copy from unity-game-reverse.md Stage 1 verbatim — same subagent call, same BLOCKED behavior]

## Stage 2 ⛔：AssetRipper 全量资源导出 + 渲染管线判定（Go/No-Go #1）

[Copy from unity-game-reverse.md Stage 2 — same asset-manager call]

**Go/No-Go 决策**：
- `assessment: "GO"` → 进入 Stage 3
- `assessment: "NO-GO"` → **BLOCKED**：这是表现还原的命门——没有资产就没有表现。
  报告缺失资产清单，停止。

## Stage 3：Shader / 材质 / 渲染管线修复

[Copy from unity-game-reverse.md Stage 3 verbatim]
```

**Step 2: Commit**

```bash
git add .opencode/agent/unity-game-reverse-visual.md
git commit -m "feat(agent): add Stage 0-3 to visual agent"
```

---

## Task 4: Add Stage 4 (three-track classification) to visual agent

**Files:**
- Modify: `.opencode/agent/unity-game-reverse-visual.md`

**Step 1: Write Stage 4**

This is the key new stage that replaces the original "场景挂载反推" with explicit track classification:

```markdown
## Stage 4：核心场景定位 + 三轨分类

### 4a. 定位核心玩法场景

调用 `unity-core-scene-finder`：
```
unity-core-scene-finder(
  sourceExportPath: workDir + "/source_export",
  unpackedDataPath: workDir + "/il2cpp/unpacked/assets/bin/Data"
)
```

从返回的关键玩法类清单开始三轨分类。

### 4b. 三轨分类规则

对每个关键玩法类，按以下规则分配轨道：

**轨道 A（资产驱动）** — 判断条件（满足任一）：
- 字段类型含 `AnimationClip`、`AudioClip`、`ParticleSystem`、`Animator`、`AudioSource`
- 类名含 `Sound`、`Audio`、`FX`、`Effect`、`VFX`、`Music`
- 实现策略：只写调用层（SetTrigger/Play/Instantiate），无需逻辑推断
- IDA：永不需要

**轨道 B（结构推断）** — 判断条件：
- 不满足 A 轨或 C 轨的普通 MonoBehaviour
- 方法名和字段名足够推断行为意图
- 实现策略：LLM 从 dump.cs 推断，合理估算允许，注释"estimated"
- IDA：Play 后发现明显行为差距时按需启用

**轨道 C（代码动画）** — 判断条件（满足任一）：
- 字段类型含 `Sequence`、`Tweener`、`DOTweenAnimation`、`LTDescr`
- 方法名含 `Tween`、`Animate`、`Ease`、`Lerp`（纯代码驱动）
- 实现策略：估算 DOTween 参数，注释"// estimated, refine with IDA"，追加到 `pending_ida_refinement`
- IDA：实现后按需补精

### 4c. 向用户展示分类结果

```
核心玩法场景：<场景名>

轨道 A（资产驱动，N 个）：
  - SoundManager     [AudioSource 字段] → 只写调用层
  - FXController     [ParticleSystem 字段] → 只写 Instantiate

轨道 B（结构推断，N 个）：
  - GameController   [MonoBehaviour，方法名语义清晰]
  - ScoreUI          [UI 逻辑，字段足够推断]

轨道 C（代码动画，N 个，实现后标记待 IDA 补精）：
  - CardFlipManager  [Sequence 字段，DOTween]
  - ComboEffectController  [方法名含 TweenScale]

请回复"确认"，或告诉我需要调整的分类。
```

用户确认后：
- 写入 `track_a_classes`、`track_b_classes`、`track_c_classes` 到状态文件
- 写入 `core_classes.json`（全部三轨合并，含轨道标记）
- 更新 `core_classes_confirmed: true`、`classes_total: N`、追加 `"stage4"`
```

**Step 2: Commit**

```bash
git add .opencode/agent/unity-game-reverse-visual.md
git commit -m "feat(agent): add Stage 4 three-track classification to visual agent"
```

---

## Task 5: Add Stage 5 (per-track implementation loop) to visual agent

**Files:**
- Modify: `.opencode/agent/unity-game-reverse-visual.md`

**Step 1: Write Stage 5**

```markdown
## Stage 5：三轨实现循环（表现优先，合理推断）

读取 `core_classes.json`，过滤 `classes_done` 已完成的类，对剩余每个类按轨道执行：

```
for each className in remaining_classes:

  读取该类的轨道标记（track: A/B/C）

  ### 轨道 A
  派发 @unity-code-generator，传入：
  - className, projectDir, dumpDir
  - mode: "visual", track: "A"
  （只生成调用层，无 IDA 需求）

  ### 轨道 B
  派发 @unity-code-generator，传入：
  - className, projectDir, dumpDir
  - mode: "visual", track: "B"
  （LLM 推断，合理估算，无需 IDA）

  ### 轨道 C
  1. 先以 B 轨策略生成（估算 DOTween 参数）：
     @unity-code-generator(mode: "visual", track: "C")
  2. 编译成功后追加 className 到 `pending_ida_refinement`
  3. 若 IDA 可用（`ida_available: true`）且用户已要求补精：
     → 派发 @unity-ida-analyst 获取伪代码
     → 再次派发 @unity-code-generator 用精确参数更新实现
     → 从 `pending_ida_refinement` 移除该类

  ### 所有轨道共同阻塞条件
  返回 status: "blocked" 时：
  - blockKind: "compile_failed"（超限编译失败）→ **BLOCKED**，停止整流程
  - blockKind: "empty_body"（产出空方法体）→ **BLOCKED**，停止整流程
  - 注意：逻辑无法精确还原 **不是** 阻塞条件（B/C 轨合理推断继续）

  每 5 个类输出进度：
  进度：N/Total | 轨道 A: X 个 | 轨道 B: Y 个 | 轨道 C: Z 个（M 个待 IDA 补精）
```

**Token 耗尽处理**：输出进度后提示用户重新调用，从断点继续。
```

**Step 2: Commit**

```bash
git add .opencode/agent/unity-game-reverse-visual.md
git commit -m "feat(agent): add Stage 5 three-track implementation loop to visual agent"
```

---

## Task 6: Add Stage 6–7 and IDA refinement trigger to visual agent

**Files:**
- Modify: `.opencode/agent/unity-game-reverse-visual.md`

**Step 1: Write Stage 6 (compile + rebind)**

Stage 6 is identical to the original except the Missing Script check scope and the note about `pending_ida_refinement`:

```markdown
## Stage 6：DLL 提取 + 编译 + GUID 重绑定

[Same as original agent Stage 6 — unity-dll-extract + unity-asset-rebinder + MissingScriptChecker]

核心场景 Missing Script 必须为 0（同原版规则）。
第三方 Missing Script 记录为已知缺失。
全部通过后追加 `"stage6"`。
```

**Step 2: Write Stage 7 (play acceptance — visual criteria)**

```markdown
## Stage 7 ⛔：Play 验收（表现对比）

调用 `unity-play-smoke`（同原版）。

**验收维度（表现优先）**：

| 维度 | 要求 |
|------|------|
| Missing Script（核心场景） | 必须 0 |
| 编译错误 | 必须 0 |
| 动画播放 | 交互后动画触发，视觉流畅 |
| 特效触发 | 关键事件时特效出现 |
| 音效响应 | 交互有声音反馈 |
| UI 过渡 | 界面切换有动效 |
| 逻辑数值精确度 | **不要求**（表现接近即可）|

`assessment: "READY"` → 向用户呈现 Play 指引 + 最终报告。

**最终报告**：
```
表现还原验收报告

核心场景：<场景名>  渲染管线：<pipeline>（已对齐）
粉红材质：0  Missing Script：0（核心场景）
关键玩法类：N/N 实现（零空方法体）

验收结论：[ 接近 / 部分接近+差距清单 / 需修复 ]

待 IDA 补精清单（Track C，共 M 个）：
  - CardFlipManager.FlipCard()    DOTween duration estimated 0.3s
  - ComboEffectController.Show()  DOTween ease estimated OutBounce
  如需精确参数，对上述类启用 IDA 分析即可补齐。

工程位置：<workDir>/target_project
```

## IDA 按需补精触发

用户在任意阶段可发出"补精 <类名>"指令：
1. 检查 IDA 就绪（同原版 IDA 就绪检测）
2. 派发 @unity-ida-analyst 获取该类全量伪代码
3. 派发 @unity-code-generator(mode: "visual", track: "C", idaData: <data>) 更新实现
4. 从 `pending_ida_refinement` 移除该类
5. 报告补精结果
```

**Step 3: Commit**

```bash
git add .opencode/agent/unity-game-reverse-visual.md
git commit -m "feat(agent): add Stage 6-7 and IDA refinement trigger to visual agent"
```

---

## Task 7: Modify `unity-code-generator.md` — add visual mode

**Files:**
- Modify: `.opencode/agent/unity-code-generator.md`

**Step 1: Read the current file**

Read `.opencode/agent/unity-code-generator.md` fully before editing.

**Step 2: Add `mode` and `track` to input parameters section**

After the existing `idaData` parameter, add:

```markdown
- `mode`（可选，默认 `"strict"`）：`"strict"` = 原版精确模式；`"visual"` = 表现优先模式
- `track`（visual 模式下必填）：`"A"` / `"B"` / `"C"`
```

**Step 3: Add visual mode execution branch**

After the existing Step 1 (RAG context) and before Step 1.5 (A1 decode), insert:

```markdown
### Step 1.2：模式判断

若 `mode == "visual"`，跳过 Step 1.5（A1 精确解码）并使用以下策略替代 Step 2：

#### visual + Track A（资产驱动）
只生成调用层，不做逻辑推断：
- `Animator.SetTrigger("参数名")`、`animator.Play("状态名")`
- `audioSource.Play()`、`AudioSource.PlayClipAtPoint(clip, pos)`
- `Instantiate(prefab, position, rotation)`
- 每个 public/SerializeField 字段保留，但方法体只调用字段上的 Unity API
- 禁止空方法体（必须有调用，哪怕是 `// asset-driven: no logic needed` 注释 + 调用）

#### visual + Track B（结构推断）
从 dump.cs 方法名、字段名、枚举推断合理实现：
- 浮点值可合理估算，注释 `// estimated`
- 分支结构与方法语义一致即可，不要求与 IDA 分支数一致
- 禁止空方法体，禁止 `throw NotImplementedException`
- 生成后自检：无空方法体 / 逻辑与方法名语义一致

#### visual + Track C（代码动画）
同 Track B 推断逻辑，额外规则：
- DOTween 调用使用合理默认值：duration 0.2~0.5s、ease OutQuad/OutBounce（按动画名推断）
- 每个 DOTween 调用末尾注释 `// estimated, refine with IDA`
- `Sequence` 的 `Append`/`Join`/`OnComplete` 结构保留，参数估算
- 生成完成后，在返回结果里追加 `"needs_ida_refinement": true`
```

**Step 4: Add visual mode blocking conditions**

In Step 3 (compile fix loop), add a note:

```markdown
**visual 模式阻塞条件（比 strict 模式宽松）**：
- `blockKind: "compile_failed"` 超限 → 仍 BLOCKED（编译是底线）
- `blockKind: "missing_dll"` → 仍 BLOCKED（交 Stage 6 补 DLL）
- `blockKind: "logic_unfixable"` → **不 BLOCKED**：用更简单的合理实现替代，重试一次
```

**Step 5: Add visual mode return format**

Add to the return format section:

```markdown
visual 模式成功时（Track C）：
```json
{
  "className": "CardFlipManager",
  "status": "success",
  "mode": "visual",
  "track": "C",
  "needs_ida_refinement": true,
  "estimated_params": ["FlipCard.duration=0.3f", "FlipCard.ease=OutBounce"]
}
```
```

**Step 6: Commit**

```bash
git add .opencode/agent/unity-code-generator.md
git commit -m "feat(agent): add visual mode (track A/B/C) to unity-code-generator"
```

---

## Task 8: Verify agent files are well-formed

**Files:**
- Read: `.opencode/agent/unity-game-reverse-visual.md`
- Read: `.opencode/agent/unity-code-generator.md`

**Step 1: Check frontmatter validity**

```bash
# Check YAML frontmatter parses (no tabs, valid keys)
head -20 .opencode/agent/unity-game-reverse-visual.md
```

Expected: `---` open, valid YAML keys (`mode`, `description`, `color`, `temperature`, `permission`), `---` close.

**Step 2: Check all stage numbers are present in visual agent**

```bash
grep "^## Stage" .opencode/agent/unity-game-reverse-visual.md
```

Expected output (in order):
```
## Stage 0：初始化工作目录
## Stage 1：工具链准备
## Stage 2 ⛔：AssetRipper 全量资源导出
## Stage 3：Shader / 材质 / 渲染管线修复
## Stage 4：核心场景定位 + 三轨分类
## Stage 5：三轨实现循环
## Stage 6：DLL 提取 + 编译 + GUID 重绑定
## Stage 7 ⛔：Play 验收
```

**Step 3: Check visual mode sections exist in code-generator**

```bash
grep "visual" .opencode/agent/unity-code-generator.md | head -10
```

Expected: lines referencing `mode == "visual"`, Track A, Track B, Track C.

**Step 4: Final commit**

```bash
git add .opencode/agent/unity-game-reverse-visual.md .opencode/agent/unity-code-generator.md
git commit -m "chore(agent): verify unity-game-reverse-visual and code-generator visual mode"
```

---

## Summary

| Task | Files | Action |
|------|-------|--------|
| 1 | `unity-game-reverse-visual.md` | Create — frontmatter + philosophy |
| 2 | `unity-game-reverse-visual.md` | Add startup logic + stage routing |
| 3 | `unity-game-reverse-visual.md` | Add Stage 0–3 (copy from original) |
| 4 | `unity-game-reverse-visual.md` | Add Stage 4 (three-track classification) |
| 5 | `unity-game-reverse-visual.md` | Add Stage 5 (per-track implementation loop) |
| 6 | `unity-game-reverse-visual.md` | Add Stage 6–7 + IDA refinement trigger |
| 7 | `unity-code-generator.md` | Modify — add visual mode track A/B/C |
| 8 | Both files | Verify well-formed |
