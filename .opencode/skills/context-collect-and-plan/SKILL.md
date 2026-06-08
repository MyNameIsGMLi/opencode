---
name: context-collect-and-plan
description: Use when the user invokes /DO command. Classify information sources into up to 4 categories, dispatch parallel Gemini Flash Tasks for each category simultaneously, merge results, then use Claude Sonnet to analyze and generate an implementation plan.
---

# Context Collect and Plan (/DO)

## Overview

Three-stage workflow triggered by `/DO`:
1. **Classify** — categorize needed information sources (seconds)
2. **Parallel Tasks** — dispatch multiple Gemini Flash Tasks simultaneously, one per category
3. **Merge + Plan** — merge all Task outputs, then Claude Sonnet analyzes and generates plan

Core principle: **Classify → Parallelize → Merge → Think.** Never collect everything serially.

## Information Source Categories

| Label | Covers | When to include |
|-------|--------|-----------------|
| `STRUCT` | Directory structure, class/function definitions, module layout | Almost always |
| `IMPL` | Core file contents, method implementations, key logic | When changing behavior |
| `TEST_CFG` | Tests, config files, schema, serialized data | When touching tested or configured code |
| `DEPS` | Who calls this, what this calls, interfaces, events/callbacks | When changing signatures or APIs |

Only dispatch Tasks for categories that are relevant. A simple bug fix may only need `IMPL` + `DEPS`.

## Workflow

```
/DO <task>
    ↓
[Stage 0] Classify: which of STRUCT/IMPL/TEST_CFG/DEPS are needed?
    ↓
[Stage 1] Dispatch ALL needed Tasks in PARALLEL (Gemini Flash × N)
    Each Task: focused on its category only, aggressive parallel tool use

    🌟 Unity 逆向极致优化：如果是实现或修改 C# 类，可直接调用 unity-rag-retriever 工具（传入 projectDir 和 className），作为 STRUCT 和 DEPS 的最高精度收集器，而无需在 100 万行的 dump.cs 中用正则盲搜。

    ↓
[Stage 2] Merge: collect all Task outputs, deduplicate, structure
    ↓
[Stage 3] Plan: Claude Sonnet analyzes merged context → implementation plan
    ↓
[Output] Present plan, wait for user approval
```

## Dispatching Tasks

Use the Task tool to dispatch each category simultaneously in a **single message** (true parallelism):

```
# Single message with multiple Task calls:
Task 1: model=google/gemini-flash-latest, prompt=[STRUCT task prompt]
Task 2: model=google/gemini-flash-latest, prompt=[IMPL task prompt]
Task 3: model=google/gemini-flash-latest, prompt=[TEST_CFG task prompt]
Task 4: model=google/gemini-flash-latest, prompt=[DEPS task prompt]
```

Each Task prompt must:
- State its category label (e.g., `[STRUCT]`)
- State the task being analyzed
- List exactly what to collect for that category
- Request file:line precision in all outputs
- Use parallel tools aggressively within the Task

## Merge Rules

After all Tasks complete:
- Deduplicate file references across Tasks
- Group by category with clear headers
- Aggregate all risks/warnings from all Tasks
- Keep code snippets with file:line refs intact

## Plan Format

Every implementation step must include:
- What to do (action)
- Where to do it (`file:line`)
- Why (rationale from collected context)

## Key Rules

- **Dispatch all Tasks in one message** — true parallelism, not sequential
- **Classify first** — don't dispatch Tasks you don't need
- **Never analyze in Tasks** — Tasks collect, Claude Sonnet thinks
- **Present plan before executing** — always wait for user approval
- **All references need file:line** — no vague "in the codebase" statements
