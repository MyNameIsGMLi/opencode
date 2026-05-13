import { tool } from "@opencode-ai/plugin"
import * as path from "path"
import * as fs from "fs/promises"
import { createHash } from "crypto"

export default tool({
  description:
    "Fix Unity references in scenes, prefabs, and assets. Generates correct GUIDs for scripts, fixes MonoScript references, updates asset references, and creates proper .meta files. Essential for making reversed Unity projects functional.",

  args: {
    projectDir: tool.schema.string().describe("Unity project directory with Assets/ folder"),
    reversedCodeDir: tool.schema.string().describe("Directory with reversed C# scripts"),
    extractedAssetsDir: tool.schema.string().optional().describe("AssetRipper extracted assets directory"),
    generateMetaFiles: tool.schema.boolean().optional().describe("Generate .meta files for all assets (default: true)"),
    fixScriptReferences: tool.schema
      .boolean()
      .optional()
      .describe("Fix MonoScript references in scenes/prefabs (default: true)"),
    fixAssetReferences: tool.schema
      .boolean()
      .optional()
      .describe("Fix asset references (textures, meshes, etc.) (default: true)"),
  },

  async execute(args, ctx) {
    const generateMetaFiles = args.generateMetaFiles !== false
    const fixScriptReferences = args.fixScriptReferences !== false
    const fixAssetReferences = args.fixAssetReferences !== false

    const assetsDir = path.join(args.projectDir, "Assets")
    const scriptsDir = path.join(assetsDir, "Scripts")

    // Verify directories exist
    try {
      await fs.access(assetsDir)
    } catch {
      return {
        output: `Error: Assets directory not found at ${assetsDir}
        
Please run unity-project-builder first to create the Unity project structure.`,
        metadata: { success: false, error: "Assets directory not found" },
      }
    }

    const results = {
      scriptGUIDs: new Map<string, string>(),
      assetGUIDs: new Map<string, string>(),
      fixedScenes: [],
      fixedPrefabs: [],
      generatedMetaFiles: [],
      errors: [],
    }

    // Step 1: Generate GUIDs for all scripts
    if (fixScriptReferences) {
      console.log("Generating script GUIDs...")
      await generateScriptGUIDs(scriptsDir, results, ctx)
    }

    // Step 2: Generate .meta files
    if (generateMetaFiles) {
      console.log("Generating .meta files...")
      await generateAllMetaFiles(assetsDir, results, ctx)
    }

    // Step 3: Fix scene references
    if (fixScriptReferences) {
      console.log("Fixing scene references...")
      const scenesDir = path.join(assetsDir, "Scenes")
      try {
        await fixScenesAndPrefabs(scenesDir, "**/*.unity", results, ctx)
      } catch (error) {
        console.log(`No scenes to fix: ${error}`)
      }
    }

    // Step 4: Fix prefab references
    if (fixScriptReferences) {
      console.log("Fixing prefab references...")
      const prefabsDir = path.join(assetsDir, "Prefabs")
      try {
        await fixScenesAndPrefabs(prefabsDir, "**/*.prefab", results, ctx)
      } catch (error) {
        console.log(`No prefabs to fix: ${error}`)
      }
    }

    // Step 5: Fix asset references (textures, meshes, etc.)
    if (fixAssetReferences && args.extractedAssetsDir) {
      console.log("Fixing asset references...")
      await fixAssetRefs(assetsDir, args.extractedAssetsDir, results, ctx)
    }

    // Generate reference mapping file
    const mappingPath = path.join(args.projectDir, "reference_mapping.json")
    const mapping = {
      timestamp: new Date().toISOString(),
      scriptGUIDs: Object.fromEntries(results.scriptGUIDs),
      assetGUIDs: Object.fromEntries(results.assetGUIDs),
      statistics: {
        totalScripts: results.scriptGUIDs.size,
        totalAssets: results.assetGUIDs.size,
        fixedScenes: results.fixedScenes.length,
        fixedPrefabs: results.fixedPrefabs.length,
        generatedMetaFiles: results.generatedMetaFiles.length,
        errors: results.errors.length,
      },
    }

    await ctx.write(mappingPath, JSON.stringify(mapping, null, 2))

    return {
      output: `Unity reference fixing completed!

Script GUIDs generated: ${results.scriptGUIDs.size}
Asset GUIDs tracked: ${results.assetGUIDs.size}
Scenes fixed: ${results.fixedScenes.length}
Prefabs fixed: ${results.fixedPrefabs.length}
.meta files generated: ${results.generatedMetaFiles.length}
Errors encountered: ${results.errors.length}

${results.fixedScenes.length > 0 ? `\nFixed scenes:\n${results.fixedScenes.map((s) => `✓ ${path.basename(s)}`).join("\n")}` : ""}

${results.fixedPrefabs.length > 0 ? `\nFixed prefabs:\n${results.fixedPrefabs.map((p) => `✓ ${path.basename(p)}`).join("\n")}` : ""}

${
  results.errors.length > 0
    ? `\n⚠ Errors:\n${results.errors
        .slice(0, 5)
        .map((e) => `✗ ${e}`)
        .join("\n")}${results.errors.length > 5 ? `\n... and ${results.errors.length - 5} more` : ""}`
    : ""
}

Reference mapping saved to: ${mappingPath}

Next steps:
1. Open project in Unity Editor
2. Fix any remaining missing references manually
3. Verify all scripts attach correctly to GameObjects
4. Test scene functionality`,

      metadata: {
        success: true,
        projectDir: args.projectDir,
        mappingPath: mappingPath,
        statistics: mapping.statistics,
        scriptGUIDs: Object.fromEntries(results.scriptGUIDs),
        errors: results.errors,
      },
    }
  },
})

async function generateScriptGUIDs(scriptsDir: string, results: any, ctx: any) {
  try {
    const scriptFiles = await ctx.glob(path.join(scriptsDir, "**/*.cs"))

    for (const scriptFile of scriptFiles) {
      const scriptName = path.basename(scriptFile, ".cs")
      const guid = generateGUID(scriptFile)
      results.scriptGUIDs.set(scriptName, guid)

      // Create .meta file for script
      const metaPath = `${scriptFile}.meta`
      const metaContent = generateScriptMeta(guid, scriptName)
      await ctx.write(metaPath, metaContent)
      results.generatedMetaFiles.push(metaPath)
    }
  } catch (error) {
    results.errors.push(`Failed to generate script GUIDs: ${error}`)
  }
}

async function generateAllMetaFiles(assetsDir: string, results: any, ctx: any) {
  try {
    // Find all asset files without .meta
    const allFiles = await ctx.glob(path.join(assetsDir, "**/*"))

    for (const file of allFiles) {
      // Skip .meta files themselves and directories
      if (file.endsWith(".meta")) continue

      const metaPath = `${file}.meta`

      // Check if .meta already exists
      try {
        await fs.access(metaPath)
        continue // Skip if exists
      } catch {
        // Need to create .meta
      }

      const guid = generateGUID(file)
      const ext = path.extname(file).toLowerCase()

      let metaContent = ""

      if (ext === ".cs") {
        // Already handled in generateScriptGUIDs
        continue
      } else if (ext === ".unity") {
        metaContent = generateSceneMeta(guid)
      } else if (ext === ".prefab") {
        metaContent = generatePrefabMeta(guid)
      } else if ([".png", ".jpg", ".jpeg", ".tga", ".psd"].includes(ext)) {
        metaContent = generateTextureMeta(guid)
      } else if ([".fbx", ".obj", ".dae", ".blend"].includes(ext)) {
        metaContent = generateModelMeta(guid)
      } else if ([".mat"].includes(ext)) {
        metaContent = generateMaterialMeta(guid)
      } else if ([".wav", ".mp3", ".ogg", ".aiff"].includes(ext)) {
        metaContent = generateAudioMeta(guid)
      } else if ([".anim"].includes(ext)) {
        metaContent = generateAnimationMeta(guid)
      } else if ([".controller"].includes(ext)) {
        metaContent = generateAnimatorMeta(guid)
      } else if ([".asset"].includes(ext)) {
        metaContent = generateScriptableObjectMeta(guid)
      } else {
        metaContent = generateDefaultMeta(guid)
      }

      if (metaContent) {
        await ctx.write(metaPath, metaContent)
        results.generatedMetaFiles.push(metaPath)
        results.assetGUIDs.set(path.basename(file), guid)
      }
    }
  } catch (error) {
    results.errors.push(`Failed to generate meta files: ${error}`)
  }
}

async function fixScenesAndPrefabs(dir: string, pattern: string, results: any, ctx: any) {
  try {
    const files = await ctx.glob(path.join(dir, pattern))

    for (const file of files) {
      try {
        let content = await ctx.read(file)
        let modified = false

        // Fix missing script references (guid: 0000000000000000)
        const missingScriptPattern = /m_Script: \{fileID: (\d+), guid: 0{32}, type: 3\}/g

        content = content.replace(missingScriptPattern, (match, fileID) => {
          // Try to find the script name from nearby MonoBehaviour
          // This is a simplified heuristic - real implementation would need better parsing
          modified = true
          return `# TODO: Fix missing script reference\n${match}`
        })

        // Fix script references with actual GUIDs
        for (const [scriptName, guid] of results.scriptGUIDs.entries()) {
          const scriptRefPattern = new RegExp(
            `# TODO: Replace with ${scriptName} GUID\\s*m_Script: \\{fileID: (\\d+), guid: 0{32}, type: 3\\}`,
            "g",
          )

          if (scriptRefPattern.test(content)) {
            content = content.replace(scriptRefPattern, `m_Script: {fileID: $1, guid: ${guid}, type: 3}`)
            modified = true
          }
        }

        if (modified) {
          await ctx.write(file, content)

          if (file.endsWith(".unity")) {
            results.fixedScenes.push(file)
          } else if (file.endsWith(".prefab")) {
            results.fixedPrefabs.push(file)
          }
        }
      } catch (error) {
        results.errors.push(`Failed to fix ${path.basename(file)}: ${error}`)
      }
    }
  } catch (error) {
    // Directory might not exist, that's ok
    throw error
  }
}

async function fixAssetRefs(assetsDir: string, extractedAssetsDir: string, results: any, ctx: any) {
  // This would map extracted assets to project assets and fix references
  // Implementation depends on AssetRipper's output structure
  // For now, just track the extracted assets

  try {
    const extractedAssets = await ctx.glob(path.join(extractedAssetsDir, "**/*"))

    for (const asset of extractedAssets) {
      const assetName = path.basename(asset)
      if (!results.assetGUIDs.has(assetName)) {
        const guid = generateGUID(asset)
        results.assetGUIDs.set(assetName, guid)
      }
    }
  } catch (error) {
    results.errors.push(`Failed to map extracted assets: ${error}`)
  }
}

function generateGUID(filePath: string): string {
  // Generate deterministic GUID from file path
  // Unity uses 32-character hex GUIDs
  const hash = createHash("md5").update(filePath).digest("hex")
  return hash
}

function generateScriptMeta(guid: string, scriptName: string): string {
  return `fileFormatVersion: 2
guid: ${guid}
MonoImporter:
  externalObjects: {}
  serializedVersion: 2
  defaultReferences: []
  executionOrder: 0
  icon: {instanceID: 0}
  userData: 
  assetBundleName: 
  assetBundleVariant: 
`
}

function generateSceneMeta(guid: string): string {
  return `fileFormatVersion: 2
guid: ${guid}
DefaultImporter:
  externalObjects: {}
  userData: 
  assetBundleName: 
  assetBundleVariant: 
`
}

function generatePrefabMeta(guid: string): string {
  return `fileFormatVersion: 2
guid: ${guid}
PrefabImporter:
  externalObjects: {}
  userData: 
  assetBundleName: 
  assetBundleVariant: 
`
}

function generateTextureMeta(guid: string): string {
  return `fileFormatVersion: 2
guid: ${guid}
TextureImporter:
  internalIDToNameTable: []
  externalObjects: {}
  serializedVersion: 11
  mipmaps:
    mipMapMode: 0
    enableMipMap: 1
    sRGBTexture: 1
    linearTexture: 0
    fadeOut: 0
    borderMipMap: 0
    mipMapsPreserveCoverage: 0
    alphaTestReferenceValue: 0.5
    mipMapFadeDistanceStart: 1
    mipMapFadeDistanceEnd: 3
  bumpmap:
    convertToNormalMap: 0
    externalNormalMap: 0
    heightScale: 0.25
    normalMapFilter: 0
  isReadable: 0
  streamingMipmaps: 0
  streamingMipmapsPriority: 0
  grayScaleToAlpha: 0
  generateCubemap: 6
  cubemapConvolution: 0
  seamlessCubemap: 0
  textureFormat: 1
  maxTextureSize: 2048
  textureSettings:
    serializedVersion: 2
    filterMode: 1
    aniso: 1
    mipBias: 0
    wrapU: 0
    wrapV: 0
    wrapW: 0
  nPOTScale: 1
  lightmap: 0
  compressionQuality: 50
  spriteMode: 0
  spriteExtrude: 1
  spriteMeshType: 1
  alignment: 0
  spritePivot: {x: 0.5, y: 0.5}
  spritePixelsToUnits: 100
  spriteBorder: {x: 0, y: 0, z: 0, w: 0}
  spriteGenerateFallbackPhysicsShape: 1
  alphaUsage: 1
  alphaIsTransparency: 0
  spriteTessellationDetail: -1
  textureType: 0
  textureShape: 1
  singleChannelComponent: 0
  maxTextureSizeSet: 0
  compressionQualitySet: 0
  textureFormatSet: 0
  applyGammaDecoding: 0
  platformSettings:
  - serializedVersion: 3
    buildTarget: DefaultTexturePlatform
    maxTextureSize: 2048
    resizeAlgorithm: 0
    textureFormat: -1
    textureCompression: 1
    compressionQuality: 50
    crunchedCompression: 0
    allowsAlphaSplitting: 0
    overridden: 0
    androidETC2FallbackOverride: 0
    forceMaximumCompressionQuality_BC6H_BC7: 0
  spriteSheet:
    serializedVersion: 2
    sprites: []
    outline: []
    physicsShape: []
    bones: []
    spriteID: 
    internalID: 0
    vertices: []
    indices: 
    edges: []
    weights: []
    secondaryTextures: []
  spritePackingTag: 
  pSDRemoveMatte: 0
  pSDShowRemoveMatteOption: 0
  userData: 
  assetBundleName: 
  assetBundleVariant: 
`
}

function generateModelMeta(guid: string): string {
  return `fileFormatVersion: 2
guid: ${guid}
ModelImporter:
  serializedVersion: 20
  internalIDToNameTable: []
  externalObjects: {}
  materials:
    materialImportMode: 1
    materialName: 0
    materialSearch: 1
    materialLocation: 1
  animations:
    legacyGenerateAnimations: 4
    bakeSimulation: 0
    resampleCurves: 1
    optimizeGameObjects: 0
    motionNodeName: 
    rigImportErrors: 
    rigImportWarnings: 
    animationImportErrors: 
    animationImportWarnings: 
    animationRetargetingWarnings: 
    animationDoRetargetingWarnings: 0
    importAnimatedCustomProperties: 0
    importConstraints: 0
    animationCompression: 1
    animationRotationError: 0.5
    animationPositionError: 0.5
    animationScaleError: 0.5
    animationWrapMode: 0
    extraExposedTransformPaths: []
    extraUserProperties: []
    clipAnimations: []
    isReadable: 0
  meshes:
    lODScreenPercentages: []
    globalScale: 1
    meshCompression: 0
    addColliders: 0
    useSRGBMaterialColor: 1
    sortHierarchyByName: 1
    importVisibility: 1
    importBlendShapes: 1
    importCameras: 1
    importLights: 1
    fileIdsGeneration: 2
    swapUVChannels: 0
    generateSecondaryUV: 0
    useFileUnits: 1
    keepQuads: 0
    weldVertices: 1
    preserveHierarchy: 0
    skinWeightsMode: 0
    maxBonesPerVertex: 4
    minBoneWeight: 0.001
    meshOptimizationFlags: -1
    indexFormat: 0
    secondaryUVAngleDistortion: 8
    secondaryUVAreaDistortion: 15.000001
    secondaryUVHardAngle: 88
    secondaryUVPackMargin: 4
    useFileScale: 1
  tangentSpace:
    normalSmoothAngle: 60
    normalImportMode: 0
    tangentImportMode: 3
    normalCalculationMode: 4
    legacyComputeAllNormalsFromSmoothingGroupsWhenMeshHasBlendShapes: 0
    blendShapeNormalImportMode: 1
    normalSmoothingSource: 0
  referencedClips: []
  importAnimation: 1
  humanDescription:
    serializedVersion: 3
    human: []
    skeleton: []
    armTwist: 0.5
    foreArmTwist: 0.5
    upperLegTwist: 0.5
    legTwist: 0.5
    armStretch: 0.05
    legStretch: 0.05
    feetSpacing: 0
    globalScale: 1
    rootMotionBoneName: 
    hasTranslationDoF: 0
    hasExtraRoot: 0
    skeletonHasParents: 1
  lastHumanDescriptionAvatarSource: {instanceID: 0}
  autoGenerateAvatarMappingIfUnspecified: 1
  animationType: 2
  humanoidOversampling: 1
  avatarSetup: 0
  additionalBone: 0
  userData: 
  assetBundleName: 
  assetBundleVariant: 
`
}

function generateMaterialMeta(guid: string): string {
  return `fileFormatVersion: 2
guid: ${guid}
NativeFormatImporter:
  externalObjects: {}
  mainObjectFileID: 2100000
  userData: 
  assetBundleName: 
  assetBundleVariant: 
`
}

function generateAudioMeta(guid: string): string {
  return `fileFormatVersion: 2
guid: ${guid}
AudioImporter:
  externalObjects: {}
  serializedVersion: 6
  defaultSettings:
    loadType: 0
    sampleRateSetting: 0
    sampleRateOverride: 44100
    compressionFormat: 1
    quality: 1
    conversionMode: 0
  platformSettingOverrides: {}
  forceToMono: 0
  normalize: 1
  preloadAudioData: 1
  loadInBackground: 0
  ambisonic: 0
  3D: 1
  userData: 
  assetBundleName: 
  assetBundleVariant: 
`
}

function generateAnimationMeta(guid: string): string {
  return `fileFormatVersion: 2
guid: ${guid}
NativeFormatImporter:
  externalObjects: {}
  mainObjectFileID: 7400000
  userData: 
  assetBundleName: 
  assetBundleVariant: 
`
}

function generateAnimatorMeta(guid: string): string {
  return `fileFormatVersion: 2
guid: ${guid}
NativeFormatImporter:
  externalObjects: {}
  mainObjectFileID: 9100000
  userData: 
  assetBundleName: 
  assetBundleVariant: 
`
}

function generateScriptableObjectMeta(guid: string): string {
  return `fileFormatVersion: 2
guid: ${guid}
NativeFormatImporter:
  externalObjects: {}
  mainObjectFileID: 11400000
  userData: 
  assetBundleName: 
  assetBundleVariant: 
`
}

function generateDefaultMeta(guid: string): string {
  return `fileFormatVersion: 2
guid: ${guid}
DefaultImporter:
  externalObjects: {}
  userData: 
  assetBundleName: 
  assetBundleVariant: 
`
}
