# Unity Reverse Engineering Agent Redesign

Date: 2026-06-15

## Background

The existing `unity-game-reverse` and `unity-game-reverse-visual` agents have three fundamental design flaws:

1. **Mixed responsibilities** — assets, logic, and DLLs all handled in one flow, causing cascade failures
2. **Wrong DLL strategy** — framework DLLs (Crescive/Loom) should come as C# source from AssetRipper export, not stripped IL2CPP DLLs from DummyDll
3. **Missing UPM package detection** — Cinemachine, Splines etc. packed as DLLs in APK but not in manifest, causing Missing Script → white screen

## New Architecture

Three information sources, three distinct responsibilities:

```
AssetRipper → Asset Layer   → unity-asset-restore  (Phase 1)
dump.cs     → Logic Layer   → unity-logic-rebuild   (Phase 2)
IDA         → Detail Layer  → unity-ida-analyst     (Phase 3, on-demand)
```

---

## Agent 1: `unity-asset-restore`

**Goal**: A Unity project that opens correctly — scenes render, no pink materials, no Missing Script — with zero game logic code.

**Mode**: `primary`

### Stage 1: Unpack + AssetRipper Export

Call `unity-assetripper-export`:
- Input: APK/IPA path
- DummyDll path from Il2CppDumper (for MonoBehaviour field data)
- Output: `workDir/source_export/ExportedProject`

### Stage 2: Asset Integrity Check

Call `unity-asset-assess`:
- Verify scene count, prefab count, material count, animation count
- Check `fields_populated` (DummyDll was passed correctly)
- GO: all counts > 0, fields populated
- NO-GO → BLOCKED, report what's missing

### Stage 3: UPM Package Detection + Installation

This is the critical stage that was missing from the old design.

**3a. Scan scene script GUIDs vs known packages**

Scan all scene/prefab files for MonoBehaviour script GUIDs. Cross-reference against a known database of Unity package script GUIDs. Identify which packages are referenced but not installed.

**3b. Classify packages**

Two categories:
- **Unity official** (`com.unity.*`): Write directly to `Packages/manifest.json`. Unity Editor auto-downloads on next refresh.
- **Third-party**: Output a "required imports" list to the user. Wait for user confirmation before proceeding.

Known Unity official packages to detect:
```
com.unity.cinemachine        → CinemachineBrain, CinemachineVirtualCamera
com.unity.splines            → SplineContainer, SplineExtrude
com.unity.addressables       → AssetReference, AddressableAssetGroup
com.unity.localization       → LocalizedString, LocalizeStringEvent
com.unity.timeline           → Timeline, PlayableDirector
com.unity.mathematics        → float2, float3, quaternion
com.unity.collections        → NativeArray, NativeList
com.unity.burst              → [BurstCompile]
com.unity.inputsystem        → InputAction, PlayerInput
com.unity.textmeshpro        → TextMeshPro, TMP_Text (usually already included)
```

Known third-party packages to detect (output import list, do NOT install):
```
DOTween / DOTween Pro         → DG.Tweening namespace
Odin Inspector / Sirenix      → Sirenix.* namespace
UniTask                       → Cysharp.Threading.Tasks namespace
Coffee.UIEffect               → Coffee.UIExtensions namespace  
Coffee.UIParticle             → Coffee.UIExtensions namespace
BrunoMikoski.AnimationSequencer → BrunoMikoski.* namespace
Obi (rope/fluid/cloth)        → Obi namespace
Nakama                        → Nakama namespace
MessagePack                   → MessagePack namespace
```

**3c. User confirmation for third-party**

Present:
```
检测到以下第三方包被场景引用，需要手动导入：
  - DOTween Pro      → Asset Store: https://assetstore.unity.com/packages/tools/animation/dotween-hotween-v2-27676
  - Odin Inspector   → Asset Store: https://assetstore.unity.com/packages/tools/utilities/odin-inspector-and-serializer-89041
  - Coffee.UIEffect  → GitHub: https://github.com/mob-sakai/UIEffect
  ...

Unity 官方包已自动写入 manifest.json（Editor 刷新后自动安装）：
  - com.unity.cinemachine: 3.1.3
  - com.unity.splines: 2.6.1
  ...

请导入上述第三方包后回复"继续"，或回复"跳过"忽略这些包（相关组件会显示为 Missing Script）。
```

### Stage 4: Render Pipeline Alignment + Shader Fix

Call `unity-shader-fix`:
- Align GraphicsSettings to detected pipeline (BuiltIn/URP/HDRP)
- Replace missing/pink shaders with equivalent built-in shaders
- Verify 0 pink materials

### Stage 5: Script Placeholder + GUID Redirect

**This replaces the old "copy Crescive/Loom source + DLL extract" approach.**

Every MonoBehaviour reference in scenes/prefabs needs a script, but we don't implement logic in Phase 1.

**5a. Scan all script GUIDs**

Scan every `.unity` and `.prefab` file under `Assets/`. Collect every unique `m_Script: {guid: ...}` reference. Map each GUID to the class name (from AssetRipper's `*.cs.meta` files or `dump.cs`).

**5b. Generate placeholder scripts**

For each referenced class that has no real implementation yet:
- Generate a minimal `public class ClassName : MonoBehaviour { }` file
- Place under `Assets/Scripts/Placeholders/`
- The `.meta` file uses the **same GUID** as referenced in the scene/prefab

This means scenes/prefabs bind correctly without any logic at all.

**5c. Verify 0 Missing Script**

Run `unity-editor-compile` (reads Editor.log if Editor is open). Confirm:
- 0 compile errors
- 0 Missing Script in core scene

### Stage 6: Accept

Call `unity-play-smoke`:
- Core scene loads without crash
- 0 Missing Script
- Renders correctly (not white/black)

Output acceptance report:
```
资源层验收报告

工程: <workDir>/target_project
核心场景: <scene>  渲染: BuiltIn（已对齐）
材质: 748 个，粉红: 0
Missing Script: 0（占位脚本已覆盖全部引用）
编译错误: 0

Unity 官方包（已安装）: com.unity.cinemachine, com.unity.splines, ...
第三方包（需用户导入）: DOTween Pro, Odin Inspector, ...

下一步: 运行 @unity-logic-rebuild 实现游戏逻辑
```

### State File: `.asset_restore_state.json`

```json
{
  "apkPath": "...",
  "workDir": "...",
  "completed_stages": [],
  "render_pipeline": null,
  "core_scene": null,
  "unity_packages_added": [],
  "third_party_packages_pending": [],
  "placeholder_count": 0,
  "blocked": null
}
```

---

## Agent 2: `unity-logic-rebuild`

**Goal**: Replace placeholder scripts with real logic implementations. The project becomes runnable with correct game behavior.

**Mode**: `primary`

**Prerequisite**: `unity-asset-restore` must be complete (`.asset_restore_state.json` has `stage6` in `completed_stages`).

### Stage 1: Logic Analysis (dump.cs)

**1a. Class dependency graph**

Parse dump.cs to build:
- Class → base class / interfaces
- Class → field types (other classes it depends on)
- Class → method call targets (approximate from method names and parameter types)

Output: `workDir/logic_graph.json`

**1b. Classify classes**

Two categories:
- **Framework classes** (Crescive.*, Loom.*, game's own SDK): Have C# source in AssetRipper export → copy source, do not reimplement
- **Game logic classes**: Need to be implemented from dump.cs structure

Within game logic classes, two sub-types:
- **Pure logic** (no MonoBehaviour fields referencing Unity visual assets): Data processing, state machines, calculators
- **Presentation logic** (MonoBehaviour with Animator/AudioSource/ParticleSystem fields): Bridge between logic and Phase 1 assets

**1c. Logic document output**

Generate `workDir/logic_analysis.md`:
- Module structure diagram (Mermaid)
- Class responsibility descriptions
- Key interaction flows (e.g. "tap → PixelGridController → ShooterQueueController → ProjectileController")
- Known unknowns (methods that will need IDA for detail)

Present to user, wait for confirmation before proceeding.

### Stage 2: Framework Layer Restore

**2a. Copy AssetRipper C# source**

For all classes identified as "framework":
```bash
for dir in Crescive.* Loom.*; do cp -R source_export/…/Scripts/$dir target/Assets/Scripts/$dir; done
```

**2b. Fix generic erasure**

Call `unity-dump-framework-gen`:
- Extracts generic versions (Getter<T>, Var<T>, BaseLevelCreator<,>) directly from dump.cs
- Removes conflicting non-generic versions from AssetRipper export
- No dependency on any other project

**2c. Framework compile check**

`unity-editor-compile` → must be 0 errors before proceeding to game logic.

### Stage 3: Game Logic Implementation

**Implementation order**: topological sort (dependencies first), then:
1. Interfaces and abstract base classes (exact dump.cs signatures)
2. Pure logic classes
3. Presentation logic classes (connect to Phase 1 assets)

**Per-class rules**:

- Read dump.cs class definition (fields, method signatures, inheritance)
- Understand what the class *does* (not just what methods it has)
- Implement based on logical intent:
  - Method named `OnTap` → handle tap input
  - Field `AudioSource sfxSource` + method `PlayHitSound` → play audio
- For `abstract` method overrides: use **exact** dump.cs signatures (return type, parameters)
- No empty method bodies (must have real logic or `return default`)
- Every 10 classes: incremental compile check

**Presentation logic connecting to Phase 1 assets**:

Phase 1 placed all assets (AnimationClip, AudioClip, ParticleSystem, Prefab) in the project. Phase 2 connects them:
- `animator.SetTrigger("Hit")` — uses the AnimationClip from Phase 1
- `audioSource.Play()` — uses the AudioClip from Phase 1
- `Instantiate(explosionPrefab)` — uses the Prefab from Phase 1

### Stage 4: GUID Redirect (Placeholder → Real Implementation)

Phase 1 created placeholder scripts with the original GUIDs. Phase 2 has now created real implementations with new GUIDs.

Update `.meta` files of the real implementations to use the **original GUIDs** from the scene references. This makes scenes/prefabs automatically bind to real logic without any manual work.

This replaces the need for `unity-asset-rebinder` in the logic flow.

### Stage 5: Compile + Run Acceptance

`unity-editor-compile` → 0 errors  
`unity-play-smoke` on core scene → READY

Output:
```
逻辑层验收报告

编译错误: 0
Missing Script: 0
关键玩法类: N/N 已实现

待 IDA 精化（可选）:
  - ConveyorController.CalculateSpeed()  — 速度曲线逻辑未知
  - PixelGridController.CheckMatch()     — 匹配算法细节未知

运行 @unity-ida-analyst 对上述方法精化，或直接 Play 验收当前实现。
```

### State File: `.logic_rebuild_state.json`

```json
{
  "workDir": "...",
  "completed_stages": [],
  "framework_copied": false,
  "classes_total": 0,
  "classes_done": [],
  "pending_ida_detail": [],
  "blocked": null
}
```

---

## Agent 3: `unity-ida-analyst` (Existing, Unchanged)

On-demand, conversation-driven. User says "I want to understand ConveyorController.CalculateSpeed" → IDA gets the pseudocode → AI supplements the existing implementation.

---

## New Tools Required

### `unity-script-placeholder` (New)

Scan all `.unity` and `.prefab` files under `Assets/`, collect every `m_Script` GUID, generate minimal `MonoBehaviour` placeholder `.cs` + `.meta` files with matching GUIDs.

Args:
- `projectPath`: target Unity project
- `dumpCsPath`: optional, for resolving class names from GUIDs
- `sourceExportPath`: optional, for resolving class names from AssetRipper export meta files

### `unity-upm-detector` (New)

Scan scene/prefab script GUIDs against a known database of Unity package component GUIDs. Output two lists: Unity official packages to install, third-party packages to prompt for.

Also scans C# script `using` directives for known third-party namespace prefixes (DOTween, Cysharp, Sirenix, Coffee, etc.).

---

## Migration

| Old | New |
|-----|-----|
| `unity-game-reverse.md` | Deprecated (replace with asset-restore + logic-rebuild) |
| `unity-game-reverse-visual.md` | Deprecated (replace with asset-restore + logic-rebuild) |
| `unity-workflow-manager.md` | Keep (used by asset-restore Stage 1) |
| `unity-asset-manager.md` | Keep (used by asset-restore Stage 2, 4) |
| `unity-code-generator.md` | Keep (used by logic-rebuild Stage 3) |
| `unity-ida-analyst.md` | Keep (Phase 3, unchanged) |

---

## Files to Create / Modify

| File | Action |
|------|--------|
| `.opencode/agent/unity-asset-restore.md` | Create (new primary agent) |
| `.opencode/agent/unity-logic-rebuild.md` | Create (new primary agent) |
| `.opencode/tool/unity-script-placeholder.ts` | Create (new tool) |
| `.opencode/tool/unity-upm-detector.ts` | Create (new tool) |
| `.opencode/agent/unity-game-reverse.md` | Deprecate (add notice) |
| `.opencode/agent/unity-game-reverse-visual.md` | Deprecate (add notice) |
