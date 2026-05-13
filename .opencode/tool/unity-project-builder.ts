import { tool } from "@opencode-ai/plugin"
import * as path from "path"
import * as fs from "fs/promises"

export default tool({
  description:
    "Build a complete runnable Unity project from reversed code and extracted assets. Creates proper Unity project structure (Assets/, ProjectSettings/, Packages/), integrates scripts and assets, generates assembly definitions, configures project settings, and produces a project ready to open in Unity Editor.",

  args: {
    outputDir: tool.schema.string().describe("Output directory for Unity project"),
    reversedCodeDir: tool.schema.string().describe("Directory with reversed C# scripts"),
    extractedAssetsDir: tool.schema.string().optional().describe("AssetRipper extracted assets directory"),
    rebuiltScenesDir: tool.schema.string().optional().describe("Directory with rebuilt scenes"),
    unityVersion: tool.schema
      .string()
      .optional()
      .describe("Target Unity version (e.g., '2021.3.0f1', default: '2021.3.0f1')"),
    projectName: tool.schema.string().optional().describe("Project name (default: 'ReversedGame')"),
    createAsmdef: tool.schema.boolean().optional().describe("Create assembly definition files (default: true)"),
    includeReadme: tool.schema.boolean().optional().describe("Include README with instructions (default: true)"),
  },

  async execute(args, ctx) {
    const unityVersion = args.unityVersion || "2021.3.0f1"
    const projectName = args.projectName || "ReversedGame"
    const createAsmdef = args.createAsmdef !== false
    const includeReadme = args.includeReadme !== false

    await fs.mkdir(args.outputDir, { recursive: true })

    const results = {
      createdDirectories: [],
      copiedScripts: 0,
      copiedAssets: 0,
      copiedScenes: 0,
      generatedFiles: [],
      errors: [],
    }

    console.log(`Building Unity project: ${projectName}`)
    console.log(`Target Unity version: ${unityVersion}`)

    // Step 1: Create Unity project structure
    console.log("Creating Unity project structure...")
    await createProjectStructure(args.outputDir, results, ctx)

    // Step 2: Copy reversed scripts
    console.log("Copying reversed scripts...")
    await copyReversedScripts(args.reversedCodeDir, args.outputDir, results, ctx)

    // Step 3: Copy extracted assets
    if (args.extractedAssetsDir) {
      console.log("Copying extracted assets...")
      await copyExtractedAssets(args.extractedAssetsDir, args.outputDir, results, ctx)
    }

    // Step 4: Copy rebuilt scenes
    if (args.rebuiltScenesDir) {
      console.log("Copying rebuilt scenes...")
      await copyRebuiltScenes(args.rebuiltScenesDir, args.outputDir, results, ctx)
    }

    // Step 5: Generate assembly definition
    if (createAsmdef) {
      console.log("Generating assembly definition...")
      await generateAsmdef(args.outputDir, projectName, results, ctx)
    }

    // Step 6: Generate project settings
    console.log("Generating project settings...")
    await generateProjectSettings(args.outputDir, projectName, unityVersion, results, ctx)

    // Step 7: Generate packages manifest
    console.log("Generating packages manifest...")
    await generatePackagesManifest(args.outputDir, results, ctx)

    // Step 8: Generate README
    if (includeReadme) {
      console.log("Generating README...")
      await generateReadme(args.outputDir, projectName, unityVersion, results, ctx)
    }

    // Step 9: Generate project manifest
    const manifestPath = path.join(args.outputDir, "project_manifest.json")
    const manifest = {
      projectName: projectName,
      unityVersion: unityVersion,
      timestamp: new Date().toISOString(),
      structure: {
        directories: results.createdDirectories,
        scripts: results.copiedScripts,
        assets: results.copiedAssets,
        scenes: results.copiedScenes,
      },
      generatedFiles: results.generatedFiles,
      errors: results.errors,
    }

    await ctx.write(manifestPath, JSON.stringify(manifest, null, 2))

    return {
      output: `Unity project built successfully! 🎮

Project: ${projectName}
Unity Version: ${unityVersion}
Location: ${args.outputDir}

Structure created:
${results.createdDirectories.map((d) => `✓ ${d}`).join("\n")}

Content:
✓ Scripts: ${results.copiedScripts}
✓ Assets: ${results.copiedAssets}
✓ Scenes: ${results.copiedScenes}

Generated files:
${results.generatedFiles.map((f) => `✓ ${path.basename(f)}`).join("\n")}

${results.errors.length > 0 ? `\n⚠ Warnings/Errors: ${results.errors.length}\n${results.errors.slice(0, 3).join("\n")}${results.errors.length > 3 ? `\n... and ${results.errors.length - 3} more` : ""}` : ""}

Next steps:
1. Open Unity Hub
2. Click "Add" → "Add project from disk"
3. Select: ${args.outputDir}
4. Unity will import and compile the project
5. Check Console for any compilation errors
6. Open Scenes/SampleScene.unity to test
7. Fix any remaining missing references in Inspector

📄 See ${path.join(args.outputDir, "README.md")} for detailed instructions.

Project manifest: ${manifestPath}`,

      metadata: {
        success: true,
        projectDir: args.outputDir,
        projectName: projectName,
        unityVersion: unityVersion,
        statistics: {
          directories: results.createdDirectories.length,
          scripts: results.copiedScripts,
          assets: results.copiedAssets,
          scenes: results.copiedScenes,
          generatedFiles: results.generatedFiles.length,
          errors: results.errors.length,
        },
        manifestPath: manifestPath,
      },
    }
  },
})

async function createProjectStructure(projectDir: string, results: any, ctx: any) {
  const directories = [
    "Assets",
    "Assets/Scripts",
    "Assets/Scenes",
    "Assets/Prefabs",
    "Assets/Materials",
    "Assets/Textures",
    "Assets/Models",
    "Assets/Audio",
    "Assets/Animations",
    "Assets/Resources",
    "Assets/StreamingAssets",
    "ProjectSettings",
    "Packages",
    "Logs",
  ]

  for (const dir of directories) {
    const fullPath = path.join(projectDir, dir)
    await fs.mkdir(fullPath, { recursive: true })
    results.createdDirectories.push(dir)
  }
}

async function copyReversedScripts(reversedCodeDir: string, projectDir: string, results: any, ctx: any) {
  try {
    const scriptFiles = await ctx.glob(path.join(reversedCodeDir, "**/*.cs"))
    const scriptsDir = path.join(projectDir, "Assets", "Scripts")

    for (const scriptFile of scriptFiles) {
      const relativePath = path.relative(reversedCodeDir, scriptFile)
      const destPath = path.join(scriptsDir, relativePath)

      // Create directory if needed
      await fs.mkdir(path.dirname(destPath), { recursive: true })

      // Copy script
      const content = await ctx.read(scriptFile)
      await ctx.write(destPath, content)
      results.copiedScripts++
    }
  } catch (error) {
    results.errors.push(`Failed to copy scripts: ${error}`)
  }
}

async function copyExtractedAssets(extractedAssetsDir: string, projectDir: string, results: any, ctx: any) {
  try {
    // Map asset types to Unity directories
    const assetMappings = {
      Texture2D: "Assets/Textures",
      Sprite: "Assets/Textures",
      Material: "Assets/Materials",
      Mesh: "Assets/Models",
      AudioClip: "Assets/Audio",
      AnimationClip: "Assets/Animations",
      Prefab: "Assets/Prefabs",
    }

    // Copy assets based on type
    for (const [assetType, destDir] of Object.entries(assetMappings)) {
      try {
        const assetDir = path.join(extractedAssetsDir, assetType)
        const assets = await ctx.glob(path.join(assetDir, "**/*"))

        for (const asset of assets) {
          const fileName = path.basename(asset)
          const destPath = path.join(projectDir, destDir, fileName)

          try {
            const content = await ctx.read(asset)
            await ctx.write(destPath, content)
            results.copiedAssets++
          } catch (error) {
            // Skip if can't read (might be directory)
          }
        }
      } catch (error) {
        // Asset type directory might not exist
      }
    }
  } catch (error) {
    results.errors.push(`Failed to copy assets: ${error}`)
  }
}

async function copyRebuiltScenes(rebuiltScenesDir: string, projectDir: string, results: any, ctx: any) {
  try {
    const sceneFiles = await ctx.glob(path.join(rebuiltScenesDir, "**/*.unity"))
    const scenesDir = path.join(projectDir, "Assets", "Scenes")

    for (const sceneFile of sceneFiles) {
      const fileName = path.basename(sceneFile)
      const destPath = path.join(scenesDir, fileName)

      const content = await ctx.read(sceneFile)
      await ctx.write(destPath, content)
      results.copiedScenes++
    }
  } catch (error) {
    results.errors.push(`Failed to copy scenes: ${error}`)
  }
}

async function generateAsmdef(projectDir: string, projectName: string, results: any, ctx: any) {
  const asmdefPath = path.join(projectDir, "Assets", "Scripts", `${projectName}.asmdef`)

  const asmdef = {
    name: projectName,
    rootNamespace: projectName,
    references: [],
    includePlatforms: [],
    excludePlatforms: [],
    allowUnsafeCode: true,
    overrideReferences: false,
    precompiledReferences: [],
    autoReferenced: true,
    defineConstraints: [],
    versionDefines: [],
    noEngineReferences: false,
  }

  await ctx.write(asmdefPath, JSON.stringify(asmdef, null, 2))
  results.generatedFiles.push(asmdefPath)
}

async function generateProjectSettings(
  projectDir: string,
  projectName: string,
  unityVersion: string,
  results: any,
  ctx: any,
) {
  const projectSettingsDir = path.join(projectDir, "ProjectSettings")

  // ProjectSettings.asset
  const projectSettingsPath = path.join(projectSettingsDir, "ProjectSettings.asset")
  const projectSettings = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!129 &1
PlayerSettings:
  m_ObjectHideFlags: 0
  serializedVersion: 23
  productGUID: ${generateProjectGUID()}
  AndroidProfiler: 0
  AndroidFilterTouchesWhenObscured: 0
  AndroidEnableSustainedPerformanceMode: 0
  defaultScreenOrientation: 4
  targetDevice: 2
  useOnDemandResources: 0
  accelerometerFrequency: 60
  companyName: ReversedProject
  productName: ${projectName}
  defaultCursor: {fileID: 0}
  cursorHotspot: {x: 0, y: 0}
  m_SplashScreenBackgroundColor: {r: 0.13725491, g: 0.12156863, b: 0.1254902, a: 1}
  m_ShowUnitySplashScreen: 1
  m_ShowUnitySplashLogo: 1
  m_SplashScreenOverlayOpacity: 1
  m_SplashScreenAnimation: 1
  m_SplashScreenLogoStyle: 1
  m_SplashScreenDrawMode: 0
  m_SplashScreenBackgroundAnimationZoom: 1
  m_SplashScreenLogoAnimationZoom: 1
  m_SplashScreenBackgroundLandscapeAspect: 1
  m_SplashScreenBackgroundPortraitAspect: 1
  m_AndroidEnableTango: 0
  m_AndroidEnableBanner: 1
  androidGamepadSupportLevel: 0
  AndroidValidateAppBundleSize: 1
  AndroidAppBundleSizeToValidate: 150
  m_BuildTargetIcons: []
  m_BuildTargetPlatformIcons: []
  m_BuildTargetBatching: []
  m_BuildTargetGraphicsJobs: []
  m_BuildTargetGraphicsJobMode: []
  m_BuildTargetGraphicsAPIs: []
  m_BuildTargetVRSettings: []
  openGLRequireES31: 0
  openGLRequireES31AEP: 0
  openGLRequireES32: 0
  m_TemplateCustomTags: {}
  mobileMTRendering:
    Android: 1
    iPhone: 1
    tvOS: 1
  m_BuildTargetGroupLightmapEncodingQuality: []
  m_BuildTargetGroupLightmapSettings: []
  playModeTestRunnerEnabled: 0
  runPlayModeTestAsEditModeTest: 0
  actionOnDotNetUnhandledException: 1
  enableInternalProfiler: 0
  logObjCUncaughtExceptions: 1
  enableCrashReportAPI: 0
  cameraUsageDescription: 
  microphoneUsageDescription: 
  switchNetLibKey: 
  switchSocketMemoryPoolSize: 6144
  switchSocketAllocatorPoolSize: 128
  switchSocketConcurrencyLimit: 14
  switchScreenResolutionBehavior: 2
  switchUseCPUProfiler: 0
  switchApplicationID: 0x01004b9000490000
  switchNSODependencies: 
  switchTitleNames_0: 
  switchTitleNames_1: 
  switchTitleNames_2: 
  switchTitleNames_3: 
  switchTitleNames_4: 
  switchTitleNames_5: 
  switchTitleNames_6: 
  switchTitleNames_7: 
  switchTitleNames_8: 
  switchTitleNames_9: 
  switchTitleNames_10: 
  switchTitleNames_11: 
  switchTitleNames_12: 
  switchTitleNames_13: 
  switchTitleNames_14: 
  switchPublisherNames_0: 
  switchPublisherNames_1: 
  switchPublisherNames_2: 
  switchPublisherNames_3: 
  switchPublisherNames_4: 
  switchPublisherNames_5: 
  switchPublisherNames_6: 
  switchPublisherNames_7: 
  switchPublisherNames_8: 
  switchPublisherNames_9: 
  switchPublisherNames_10: 
  switchPublisherNames_11: 
  switchPublisherNames_12: 
  switchPublisherNames_13: 
  switchPublisherNames_14: 
  switchIcons_0: {fileID: 0}
  switchIcons_1: {fileID: 0}
  switchIcons_2: {fileID: 0}
  switchIcons_3: {fileID: 0}
  switchIcons_4: {fileID: 0}
  switchIcons_5: {fileID: 0}
  switchIcons_6: {fileID: 0}
  switchIcons_7: {fileID: 0}
  switchIcons_8: {fileID: 0}
  switchIcons_9: {fileID: 0}
  switchIcons_10: {fileID: 0}
  switchIcons_11: {fileID: 0}
  switchIcons_12: {fileID: 0}
  switchIcons_13: {fileID: 0}
  switchIcons_14: {fileID: 0}
  switchSmallIcons_0: {fileID: 0}
  switchSmallIcons_1: {fileID: 0}
  switchSmallIcons_2: {fileID: 0}
  switchSmallIcons_3: {fileID: 0}
  switchSmallIcons_4: {fileID: 0}
  switchSmallIcons_5: {fileID: 0}
  switchSmallIcons_6: {fileID: 0}
  switchSmallIcons_7: {fileID: 0}
  switchSmallIcons_8: {fileID: 0}
  switchSmallIcons_9: {fileID: 0}
  switchSmallIcons_10: {fileID: 0}
  switchSmallIcons_11: {fileID: 0}
  switchSmallIcons_12: {fileID: 0}
  switchSmallIcons_13: {fileID: 0}
  switchSmallIcons_14: {fileID: 0}
  switchManualHTML: 
  switchAccessibleURLs: 
  switchLegalInformation: 
  switchMainThreadStackSize: 1048576
  switchPresenceGroupId: 
  switchLogoHandling: 0
  switchReleaseVersion: 0
  switchDisplayVersion: 1.0.0
  switchStartupUserAccount: 0
  switchTouchScreenUsage: 0
  switchSupportedLanguagesMask: 0
  switchLogoType: 0
  switchApplicationErrorCodeCategory: 
  switchUserAccountSaveDataSize: 0
  switchUserAccountSaveDataJournalSize: 0
  switchApplicationAttribute: 0
  switchCardSpecSize: -1
  switchCardSpecClock: -1
  switchRatingsMask: 0
  switchRatingsInt_0: 0
  switchRatingsInt_1: 0
  switchRatingsInt_2: 0
  switchRatingsInt_3: 0
  switchRatingsInt_4: 0
  switchRatingsInt_5: 0
  switchRatingsInt_6: 0
  switchRatingsInt_7: 0
  switchRatingsInt_8: 0
  switchRatingsInt_9: 0
  switchRatingsInt_10: 0
  switchRatingsInt_11: 0
  switchRatingsInt_12: 0
  switchLocalCommunicationIds_0: 
  switchLocalCommunicationIds_1: 
  switchLocalCommunicationIds_2: 
  switchLocalCommunicationIds_3: 
  switchLocalCommunicationIds_4: 
  switchLocalCommunicationIds_5: 
  switchLocalCommunicationIds_6: 
  switchLocalCommunicationIds_7: 
  switchParentalControl: 0
  switchAllowsScreenshot: 1
  switchAllowsVideoCapturing: 1
  switchAllowsRuntimeAddOnContentInstall: 0
  switchDataLossConfirmation: 0
  switchUserAccountLockEnabled: 0
  switchSystemResourceMemory: 16777216
  switchSupportedNpadStyles: 22
  switchNativeFsCacheSize: 32
  switchIsHoldTypeHorizontal: 0
  switchSupportedNpadCount: 8
  switchSocketConfigEnabled: 0
  switchTcpInitialSendBufferSize: 32
  switchTcpInitialReceiveBufferSize: 64
  switchTcpAutoSendBufferSizeMax: 256
  switchTcpAutoReceiveBufferSizeMax: 256
  switchUdpSendBufferSize: 9
  switchUdpReceiveBufferSize: 42
  switchSocketBufferEfficiency: 4
  switchSocketInitializeEnabled: 1
  switchNetworkInterfaceManagerInitializeEnabled: 1
  switchPlayerConnectionEnabled: 1
  ps4NPAgeRating: 12
  ps4ParentalLevel: 11
  ps4ContentID: ED1633-NPXX51362_00-0000000000000000
  ps4Category: 0
  ps4MasterVersion: 01.00
  ps4AppVersion: 01.00
  ps4AppType: 0
  ps4ParamSfxPath: 
  ps4VideoOutPixelFormat: 0
  ps4VideoOutInitialWidth: 1920
  ps4VideoOutBaseModeInitialWidth: 1920
  ps4VideoOutReprojectionRate: 120
  ps4PronunciationXMLPath: 
  ps4PronunciationSIGPath: 
  ps4BackgroundImagePath: 
  ps4StartupImagePath: 
  ps4StartupImagesFolder: 
  ps4IconImagesFolder: 
  ps4SaveDataImagePath: 
  ps4SdkOverride: 
  ps4BGMPath: 
  ps4ShareFilePath: 
  ps4ShareOverlayImagePath: 
  ps4PrivacyGuardImagePath: 
  ps4ExtraSceSysFile: 
  ps4NPtitleDatPath: 
  ps4RemotePlayKeyAssignment: -1
  ps4RemotePlayKeyMappingDir: 
  ps4PlayTogetherPlayerCount: 0
  ps4EnterButtonAssignment: 1
  ps4ApplicationParam1: 0
  ps4ApplicationParam2: 0
  ps4ApplicationParam3: 0
  ps4ApplicationParam4: 0
  ps4DownloadDataSize: 0
  ps4GarlicHeapSize: 2048
  ps4ProGarlicHeapSize: 2560
  playerPrefsMaxSize: 32768
  ps4Passcode: frAQBc8Wsa1xVPfvJcrgRYwTiizs2trQ
  ps4pnSessions: 1
  ps4pnPresence: 1
  ps4pnFriends: 1
  ps4pnGameCustomData: 1
  playerPrefsSupport: 0
  enableApplicationExit: 0
  resetTempFolder: 1
  restrictedAudioUsageRights: 0
  ps4UseResolutionFallback: 0
  ps4ReprojectionSupport: 0
  ps4UseAudio3dBackend: 0
  ps4UseLowGarlicFragmentationMode: 1
  ps4SocialScreenEnabled: 0
  ps4ScriptOptimizationLevel: 0
  ps4Audio3dVirtualSpeakerCount: 14
  ps4attribCpuUsage: 0
  ps4PatchPkgPath: 
  ps4PatchLatestPkgPath: 
  ps4PatchChangeinfoPath: 
  ps4PatchDayOne: 0
  ps4attribUserManagement: 0
  ps4attribMoveSupport: 0
  ps4attrib3DSupport: 0
  ps4attribShareSupport: 0
  ps4attribExclusiveVR: 0
  ps4disableAutoHideSplash: 0
  ps4videoRecordingFeaturesUsed: 0
  ps4contentSearchFeaturesUsed: 0
  ps4CompatibilityPS5: 0
  ps4GPU800MHz: 1
  ps4attribEyeToEyeDistanceSettingVR: 0
  ps4IncludedModules: []
  ps4attribVROutputEnabled: 0
  monoEnv: 
  splashScreenBackgroundSourceLandscape: {fileID: 0}
  splashScreenBackgroundSourcePortrait: {fileID: 0}
  blurSplashScreenBackground: 1
  spritePackerPolicy: 
  webGLMemorySize: 16
  webGLExceptionSupport: 1
  webGLNameFilesAsHashes: 0
  webGLDataCaching: 1
  webGLDebugSymbols: 0
  webGLEmscriptenArgs: 
  webGLModulesDirectory: 
  webGLTemplate: APPLICATION:Default
  webGLAnalyzeBuildSize: 0
  webGLUseEmbeddedResources: 0
  webGLCompressionFormat: 1
  webGLWasmArithmeticExceptions: 0
  webGLLinkerTarget: 1
  webGLThreadsSupport: 0
  webGLDecompressionFallback: 0
  scriptingDefineSymbols: {}
  additionalCompilerArguments: {}
  platformArchitecture: {}
  scriptingBackend: {}
  il2cppCompilerConfiguration: {}
  managedStrippingLevel: {}
  incrementalIl2cppBuild: {}
  allowUnsafeCode: 1
  useDeterministicCompilation: 1
  enableRoslynAnalyzers: 1
  additionalIl2CppArgs: 
  scriptingRuntimeVersion: 1
  gcIncremental: 0
  assemblyVersionValidation: 1
  gcWBarrierValidation: 0
  apiCompatibilityLevelPerPlatform: {}
  m_RenderingPath: 1
  m_MobileRenderingPath: 1
  metroPackageName: ${projectName}
  metroPackageVersion: 
  metroCertificatePath: 
  metroCertificatePassword: 
  metroCertificateSubject: 
  metroCertificateIssuer: 
  metroCertificateNotAfter: 0000000000000000
  metroApplicationDescription: ${projectName}
  wsaImages: {}
  m_BuildTargetBatching: []
  m_BuildTargetGraphicsJobs: []
  m_BuildTargetGraphicsJobMode: []
  m_BuildTargetGraphicsAPIs: []
  m_BuildTargetVRSettings: []
  openGLRequireES31: 0
  openGLRequireES31AEP: 0
  openGLRequireES32: 0
  m_TemplateCustomTags: {}
  mobileMTRendering:
    Android: 1
    iPhone: 1
    tvOS: 1
  m_BuildTargetGroupLightmapEncodingQuality: []
  m_BuildTargetGroupLightmapSettings: []
  m_BuildTargetNormalMapEncoding: []
  playModeTestRunnerEnabled: 0
  runPlayModeTestAsEditModeTest: 0
  actionOnDotNetUnhandledException: 1
  enableInternalProfiler: 0
  logObjCUncaughtExceptions: 1
  enableCrashReportAPI: 0
  cameraUsageDescription: 
  microphoneUsageDescription: 
  bluetoothUsageDescription: 
  macOSURLSchemes: []
  appleDeveloperTeamID: 
  iOSManualSigningProvisioningProfileID: 
  tvOSManualSigningProvisioningProfileID: 
  iOSManualSigningProvisioningProfileType: 0
  tvOSManualSigningProvisioningProfileType: 0
  appleEnableAutomaticSigning: 0
  iOSRequireARKit: 0
  iOSAutomaticallyDetectAndAddCapabilities: 1
  appleEnableProMotion: 0
  clonedFromGUID: c0afd0d1d80e3634a9dac47e8a0426ea
  templatePackageId: com.unity.template.3d@5.0.4
  templateDefaultScene: Assets/Scenes/SampleScene.unity
  useCustomMainManifest: 0
  useCustomLauncherManifest: 0
  useCustomMainGradleTemplate: 0
  useCustomLauncherGradleManifest: 0
  useCustomBaseGradleTemplate: 0
  useCustomGradlePropertiesTemplate: 0
  useCustomProguardFile: 0
  AndroidTargetArchitectures: 3
  AndroidTargetDevices: 0
  AndroidSplashScreenScale: 0
  androidSplashScreen: {fileID: 0}
  AndroidKeystoreName: 
  AndroidKeyaliasName: 
  AndroidBuildApkPerCpuArchitecture: 0
  AndroidTVCompatibility: 0
  AndroidIsGame: 1
  AndroidEnableTango: 0
  androidEnableBanner: 1
  androidUseLowAccuracyLocation: 0
  androidUseCustomKeystore: 0
  m_AndroidBanners:
  - width: 320
    height: 180
    banner: {fileID: 0}
  androidGamepadSupportLevel: 0
  chromeosInputEmulation: 1
  AndroidValidateAppBundleSize: 1
  AndroidAppBundleSizeToValidate: 150
  m_BuildTargetIcons: []
  m_BuildTargetPlatformIcons: []
  m_BuildTargetBatching:
  - m_BuildTarget: Standalone
    m_StaticBatching: 1
    m_DynamicBatching: 0
  - m_BuildTarget: tvOS
    m_StaticBatching: 1
    m_DynamicBatching: 0
  - m_BuildTarget: Android
    m_StaticBatching: 1
    m_DynamicBatching: 0
  - m_BuildTarget: iPhone
    m_StaticBatching: 1
    m_DynamicBatching: 0
  - m_BuildTarget: WebGL
    m_StaticBatching: 0
    m_DynamicBatching: 0
  metroInputSource: 0
  dynUnityVersion: ${unityVersion}
  m_HolographicTrackingLossScreen: {fileID: 0}
  defaultScreenWidth: 1920
  defaultScreenHeight: 1080
  defaultScreenWidthWeb: 960
  defaultScreenHeightWeb: 600
  m_StereoRenderingPath: 0
  m_ActiveColorSpace: 0
  m_MTRendering: 1
  mipStripping: 0
  numberOfMipsStripped: 0
  m_StackTraceTypes: 010000000100000001000000010000000100000001000000
  iosShowActivityIndicatorOnLoading: -1
  androidShowActivityIndicatorOnLoading: -1
  iosUseCustomAppBackgroundBehavior: 0
  iosAllowHTTPDownload: 1
  allowedAutorotateToPortrait: 1
  allowedAutorotateToPortraitUpsideDown: 1
  allowedAutorotateToLandscapeRight: 1
  allowedAutorotateToLandscapeLeft: 1
  useOSAutorotation: 1
  use32BitDisplayBuffer: 1
  preserveFramebufferAlpha: 0
  disableDepthAndStencilBuffers: 0
  androidStartInFullscreen: 1
  androidRenderOutsideSafeArea: 1
  androidUseSwappy: 1
  androidBlitType: 0
  androidResizableWindow: 0
  androidDefaultWindowWidth: 1920
  androidDefaultWindowHeight: 1080
  androidMinimumWindowWidth: 400
  androidMinimumWindowHeight: 300
  androidFullscreenMode: 1
  defaultIsNativeResolution: 1
  macRetinaSupport: 1
  runInBackground: 1
  captureSingleScreen: 0
  muteOtherAudioSources: 0
  Prepare IOS For Recording: 0
  Force IOS Speakers When Recording: 0
  deferSystemGesturesMode: 0
  hideHomeButton: 0
  submitAnalytics: 1
  usePlayerLog: 1
  bakeCollisionMeshes: 0
  forceSingleInstance: 0
  useFlipModelSwapchain: 1
  resizableWindow: 0
  useMacAppStoreValidation: 0
  macAppStoreCategory: public.app-category.games
  gpuSkinning: 1
  xboxPIXTextureCapture: 0
  xboxEnableAvatar: 0
  xboxEnableKinect: 0
  xboxEnableKinectAutoTracking: 0
  xboxEnableFitness: 0
  visibleInBackground: 1
  allowFullscreenSwitch: 1
  fullscreenMode: 1
  xboxSpeechDB: 0
  xboxEnableHeadOrientation: 0
  xboxEnableGuest: 0
  xboxEnablePIXSampling: 0
  metalFramebufferOnly: 0
  xboxOneResolution: 0
  xboxOneSResolution: 0
  xboxOneXResolution: 3
  xboxOneMonoLoggingLevel: 0
  xboxOneLoggingLevel: 1
  xboxOneDisableEsram: 0
  xboxOneEnableTypeOptimization: 0
  xboxOnePresentImmediateThreshold: 0
  switchQueueCommandMemory: 0
  switchQueueControlMemory: 16384
  switchQueueComputeMemory: 262144
  switchNVNShaderPoolsGranularity: 33554432
  switchNVNDefaultPoolsGranularity: 16777216
  switchNVNOtherPoolsGranularity: 16777216
  vulkanNumSwapchainBuffers: 3
  vulkanEnableSetSRGBWrite: 0
  vulkanEnablePreTransform: 0
  vulkanEnableLateAcquireNextImage: 0
  vulkanEnableCommandBufferRecycling: 1
  m_SupportedAspectRatios:
    4:3: 1
    5:4: 1
    16:10: 1
    16:9: 1
    Others: 1
  bundleVersion: 0.1.0
  preloadedAssets: []
  metroInputSource: 0
  wsaTransparentSwapchain: 0
  m_HolographicPauseOnTrackingLoss: 1
  xboxOneDisableKinectGpuReservation: 1
  xboxOneEnable7thCore: 1
  vrSettings:
    enable360StereoCapture: 0
  isWsaHolographicRemotingEnabled: 0
  enableFrameTimingStats: 0
  enableOpenGLProfilerGPURecorders: 1
  useHDRDisplay: 0
  D3DHDRBitDepth: 0
  m_ColorGamuts: 00000000
  targetPixelDensity: 30
  resolutionScalingMode: 0
  androidSupportedAspectRatio: 1
  androidMaxAspectRatio: 2.1
  applicationIdentifier:
    Standalone: com.ReversedProject.${projectName}
  buildNumber:
    Standalone: 0
    iPhone: 0
    tvOS: 0
  overrideDefaultApplicationIdentifier: 0
  AndroidBundleVersionCode: 1
  AndroidMinSdkVersion: 22
  AndroidTargetSdkVersion: 0
  AndroidPreferredInstallLocation: 1
  aotOptions: 
  stripEngineCode: 1
  iPhoneStrippingLevel: 0
  iPhoneScriptCallOptimization: 0
  ForceInternetPermission: 0
  ForceSDCardPermission: 0
  CreateWallpaper: 0
  APKExpansionFiles: 0
  keepLoadedShadersAlive: 0
  StripUnusedMeshComponents: 1
  VertexChannelCompressionMask: 4054
  iPhoneSdkVersion: 988
  iOSTargetOSVersionString: 11.0
  tvOSSdkVersion: 0
  tvOSRequireExtendedGameController: 0
  tvOSTargetOSVersionString: 11.0
  uIPrerenderedIcon: 0
  uIRequiresPersistentWiFi: 0
  uIRequiresFullScreen: 1
  uIStatusBarHidden: 1
  uIExitOnSuspend: 0
  uIStatusBarStyle: 0
  appleTVSplashScreen: {fileID: 0}
  appleTVSplashScreen2x: {fileID: 0}
  tvOSSmallIconLayers: []
  tvOSSmallIconLayers2x: []
  tvOSLargeIconLayers: []
  tvOSLargeIconLayers2x: []
  tvOSTopShelfImageLayers: []
  tvOSTopShelfImageLayers2x: []
  tvOSTopShelfImageWideLayers: []
  tvOSTopShelfImageWideLayers2x: []
  iOSLaunchScreenType: 0
  iOSLaunchScreenPortrait: {fileID: 0}
  iOSLaunchScreenLandscape: {fileID: 0}
  iOSLaunchScreenBackgroundColor:
    serializedVersion: 2
    rgba: 0
  iOSLaunchScreenFillPct: 100
  iOSLaunchScreenSize: 100
  iOSLaunchScreenCustomXibPath: 
  iOSLaunchScreeniPadType: 0
  iOSLaunchScreeniPadImage: {fileID: 0}
  iOSLaunchScreeniPadBackgroundColor:
    serializedVersion: 2
    rgba: 0
  iOSLaunchScreeniPadFillPct: 100
  iOSLaunchScreeniPadSize: 100
  iOSLaunchScreeniPadCustomXibPath: 
  iOSUseLaunchScreenStoryboard: 0
  iOSLaunchScreenCustomStoryboardPath: 
  iOSDeviceRequirements: []
  iOSURLSchemes: []
  macOSURLSchemes: []
  iOSBackgroundModes: 0
  iOSMetalForceHardShadows: 0
  metalEditorSupport: 1
  metalAPIValidation: 1
  iOSRenderExtraFrameOnPause: 0
  iosCopyPluginsCodeInsteadOfSymlink: 0
  appleDeveloperTeamID: 
  iOSManualSigningProvisioningProfileID: 
  tvOSManualSigningProvisioningProfileID: 
  iOSManualSigningProvisioningProfileType: 0
  tvOSManualSigningProvisioningProfileType: 0
  appleEnableAutomaticSigning: 0
  iOSRequireARKit: 0
  iOSAutomaticallyDetectAndAddCapabilities: 1
  appleEnableProMotion: 0
  shaderPrecisionModel: 0
  clonedFromGUID: c0afd0d1d80e3634a9dac47e8a0426ea
  templatePackageId: com.unity.template.3d@5.0.4
  templateDefaultScene: Assets/Scenes/SampleScene.unity
  useCustomMainManifest: 0
  useCustomLauncherManifest: 0
  useCustomMainGradleTemplate: 0
  useCustomLauncherGradleManifest: 0
  useCustomBaseGradleTemplate: 0
  useCustomGradlePropertiesTemplate: 0
  useCustomProguardFile: 0
`

  await ctx.write(projectSettingsPath, projectSettings)
  results.generatedFiles.push(projectSettingsPath)

  // EditorSettings.asset
  const editorSettingsPath = path.join(projectSettingsDir, "EditorSettings.asset")
  const editorSettings = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!159 &1
EditorSettings:
  m_ObjectHideFlags: 0
  serializedVersion: 11
  m_ExternalVersionControlSupport: Visible Meta Files
  m_SerializationMode: 2
  m_LineEndingsForNewScripts: 0
  m_DefaultBehaviorMode: 0
  m_PrefabRegularEnvironment: {fileID: 0}
  m_PrefabUIEnvironment: {fileID: 0}
  m_SpritePackerMode: 0
  m_SpritePackerPaddingPower: 1
  m_EtcTextureCompressorBehavior: 1
  m_EtcTextureFastCompressor: 1
  m_EtcTextureNormalCompressor: 2
  m_EtcTextureBestCompressor: 4
  m_ProjectGenerationIncludedExtensions: txt;xml;fnt;cd;asmdef;asmref;rsp
  m_ProjectGenerationRootNamespace: 
  m_CollabEditorSettings:
    inProgressEnabled: 1
  m_EnableTextureStreamingInEditMode: 1
  m_EnableTextureStreamingInPlayMode: 1
  m_AsyncShaderCompilation: 1
  m_CachingShaderPreprocessor: 1
  m_PrefabModeAllowAutoSave: 1
  m_EnterPlayModeOptionsEnabled: 0
  m_EnterPlayModeOptions: 3
  m_GameObjectNamingDigits: 1
  m_GameObjectNamingScheme: 0
  m_AssetNamingUsesSpace: 1
  m_UseLegacyProbeSampleCount: 0
  m_SerializeInlineMappingsOnOneLine: 1
  m_DisableCookiesInLightmapper: 1
  m_AssetPipelineMode: 1
  m_CacheServerMode: 0
  m_CacheServerEndpoint: 
  m_CacheServerNamespacePrefix: default
  m_CacheServerEnableDownload: 1
  m_CacheServerEnableUpload: 1
  m_CacheServerEnableAuth: 0
  m_CacheServerEnableTls: 0
`

  await ctx.write(editorSettingsPath, editorSettings)
  results.generatedFiles.push(editorSettingsPath)
}

async function generatePackagesManifest(projectDir: string, results: any, ctx: any) {
  const packagesDir = path.join(projectDir, "Packages")
  const manifestPath = path.join(packagesDir, "manifest.json")

  const manifest = {
    dependencies: {
      "com.unity.collab-proxy": "2.0.0",
      "com.unity.feature.development": "1.0.1",
      "com.unity.ide.rider": "3.0.18",
      "com.unity.ide.visualstudio": "2.0.17",
      "com.unity.ide.vscode": "1.2.5",
      "com.unity.test-framework": "1.1.31",
      "com.unity.textmeshpro": "3.0.6",
      "com.unity.timeline": "1.6.4",
      "com.unity.ugui": "1.0.0",
      "com.unity.visualscripting": "1.8.0",
      "com.unity.modules.ai": "1.0.0",
      "com.unity.modules.androidjni": "1.0.0",
      "com.unity.modules.animation": "1.0.0",
      "com.unity.modules.assetbundle": "1.0.0",
      "com.unity.modules.audio": "1.0.0",
      "com.unity.modules.cloth": "1.0.0",
      "com.unity.modules.director": "1.0.0",
      "com.unity.modules.imageconversion": "1.0.0",
      "com.unity.modules.imgui": "1.0.0",
      "com.unity.modules.jsonserialize": "1.0.0",
      "com.unity.modules.particlesystem": "1.0.0",
      "com.unity.modules.physics": "1.0.0",
      "com.unity.modules.physics2d": "1.0.0",
      "com.unity.modules.screencapture": "1.0.0",
      "com.unity.modules.terrain": "1.0.0",
      "com.unity.modules.terrainphysics": "1.0.0",
      "com.unity.modules.tilemap": "1.0.0",
      "com.unity.modules.ui": "1.0.0",
      "com.unity.modules.uielements": "1.0.0",
      "com.unity.modules.umbra": "1.0.0",
      "com.unity.modules.unityanalytics": "1.0.0",
      "com.unity.modules.unitywebrequest": "1.0.0",
      "com.unity.modules.unitywebrequestassetbundle": "1.0.0",
      "com.unity.modules.unitywebrequestaudio": "1.0.0",
      "com.unity.modules.unitywebrequesttexture": "1.0.0",
      "com.unity.modules.unitywebrequestwww": "1.0.0",
      "com.unity.modules.vehicles": "1.0.0",
      "com.unity.modules.video": "1.0.0",
      "com.unity.modules.vr": "1.0.0",
      "com.unity.modules.wind": "1.0.0",
      "com.unity.modules.xr": "1.0.0",
    },
  }

  await ctx.write(manifestPath, JSON.stringify(manifest, null, 2))
  results.generatedFiles.push(manifestPath)

  // packages-lock.json
  const packagesLockPath = path.join(packagesDir, "packages-lock.json")
  const packagesLock = {
    dependencies: {},
  }

  // Add dependencies from manifest
  for (const [pkg, version] of Object.entries(manifest.dependencies)) {
    packagesLock.dependencies[pkg] = {
      version: version,
      depth: 0,
      source: "registry",
      dependencies: {},
      url: "https://packages.unity.com",
    }
  }

  await ctx.write(packagesLockPath, JSON.stringify(packagesLock, null, 2))
  results.generatedFiles.push(packagesLockPath)
}

async function generateReadme(projectDir: string, projectName: string, unityVersion: string, results: any, ctx: any) {
  const readmePath = path.join(projectDir, "README.md")
  const readme = `# ${projectName}

This Unity project was generated from reversed IL2CPP code using AI-powered reconstruction.

## Project Information

- **Unity Version**: ${unityVersion}
- **Generated**: ${new Date().toISOString()}
- **Source**: Reversed from IL2CPP binary

## Opening the Project

1. Open Unity Hub
2. Click "Add" → "Add project from disk"
3. Select this directory: \`${projectDir}\`
4. Unity will import and compile the project (may take several minutes)

## Expected Issues

Due to the nature of reverse engineering, you may encounter:

1. **Compilation Errors**: Some scripts may have type inference issues
   - Check the Console window for errors
   - Fix type mismatches manually

2. **Missing References**: Some scene/prefab references may be broken
   - Select objects in the Hierarchy
   - Re-assign missing scripts in the Inspector
   - Fix texture/material references

3. **Missing Assets**: Not all assets may have been extracted
   - Placeholder assets may need replacement
   - Check for pink/missing textures

4. **Runtime Errors**: Some game logic may not work correctly
   - Check for null reference exceptions
   - Verify game manager initialization

## Project Structure

\`\`\`
Assets/
├── Scenes/         # Game scenes
├── Scripts/        # Reversed C# code
├── Prefabs/        # Game prefabs
├── Materials/      # Materials
├── Textures/       # Textures and sprites
├── Models/         # 3D models
├── Audio/          # Audio clips
└── Animations/     # Animation clips

ProjectSettings/    # Unity project settings
Packages/           # Package dependencies
\`\`\`

## Testing the Project

1. Open \`Assets/Scenes/SampleScene.unity\`
2. Press Play to test
3. Check Console for errors
4. Fix issues as they arise

## Code Accuracy

The reversed code has an estimated accuracy of 80-95% depending on:
- Original code complexity
- IL2CPP optimization level
- Availability of IDA Pro analysis

## Next Steps

1. ✅ Fix compilation errors
2. ✅ Restore missing references
3. ✅ Test core functionality
4. ✅ Replace placeholder assets
5. ✅ Implement missing game logic

## Support

This project was generated automatically. Some manual fixes will be required.
Refer to Unity documentation for help with specific issues.

## Legal Notice

This reversed project is for educational and research purposes only.
Ensure you have the legal right to reverse engineer the original application.
`

  await ctx.write(readmePath, readme)
  results.generatedFiles.push(readmePath)
}

function generateProjectGUID(): string {
  // Generate a random 32-character hex GUID
  const chars = "0123456789abcdef"
  let guid = ""
  for (let i = 0; i < 32; i++) {
    guid += chars[Math.floor(Math.random() * 16)]
  }
  return guid
}
