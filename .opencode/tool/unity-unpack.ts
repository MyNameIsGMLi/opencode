import { tool } from "@opencode-ai/plugin"
import * as path from "path"
import * as fs from "fs/promises"
import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)

async function runCommand(ctx: any, command: string): Promise<string> {
  if (ctx.bash && typeof ctx.bash === "function") {
    return await ctx.bash(command)
  }
  const { stdout, stderr } = await execAsync(command)
  return stdout + stderr
}

export default tool({
  description:
    "Intelligently unpack APK/IPA/XAPK files for Unity reverse engineering. Supports Android APK, iOS IPA, and Android XAPK formats. Automatically detects file type and extracts IL2CPP binaries, metadata, and assets.",

  args: {
    filePath: tool.schema.string().describe("Path to APK/IPA/XAPK file to unpack"),
    outputDir: tool.schema
      .string()
      .optional()
      .describe("Output directory for extracted files (defaults to <filename>_extracted)"),
  },

  async execute(args, ctx) {
    const inputPath = path.resolve(args.filePath)
    const ext = path.extname(inputPath).toLowerCase()
    const basename = path.basename(inputPath, ext)
    const outputDir = args.outputDir || path.join(path.dirname(inputPath), `${basename}_extracted`)

    // 验证输入文件存在
    try {
      await fs.access(inputPath)
    } catch (error) {
      return {
        output: `Error: File not found - ${inputPath}`,
        metadata: { success: false, error: "File not found" },
      }
    }

    // 创建输出目录
    await fs.mkdir(outputDir, { recursive: true })

    let result: any = {}

    switch (ext) {
      case ".apk":
        result = await unpackAPK(inputPath, outputDir, ctx)
        break

      case ".xapk":
        result = await unpackXAPK(inputPath, outputDir, ctx)
        break

      case ".ipa":
        result = await unpackIPA(inputPath, outputDir, ctx)
        break

      default:
        return {
          output: `Error: Unsupported file format '${ext}'. Supported: .apk, .ipa, .xapk`,
          metadata: { success: false, error: "Unsupported format" },
        }
    }

    return result
  },
})

async function unpackAPK(inputPath: string, outputDir: string, ctx: any) {
  const output = await runCommand(
    ctx,
    `unzip -q "${inputPath}" -d "${outputDir}" 2>&1 || echo "unzip completed with warnings"`,
  )

  // 定位IL2CPP相关文件
  const il2cppPaths = [
    path.join(outputDir, "lib/arm64-v8a/libil2cpp.so"),
    path.join(outputDir, "lib/armeabi-v7a/libil2cpp.so"),
  ]

  let il2cppPath = null
  for (const p of il2cppPaths) {
    try {
      await fs.access(p)
      il2cppPath = p
      break
    } catch {}
  }

  const metadataPath = path.join(outputDir, "assets/bin/Data/Managed/Metadata/global-metadata.dat")
  const assetsPath = path.join(outputDir, "assets")

  // 验证关键文件
  const hasMetadata = await fileExists(metadataPath)
  const hasAssets = await fileExists(assetsPath)

  return {
    output: `APK extracted successfully to ${outputDir}
    
Files found:
- IL2CPP Binary: ${il2cppPath || "NOT FOUND"}
- Metadata: ${hasMetadata ? metadataPath : "NOT FOUND"}
- Assets: ${hasAssets ? assetsPath : "NOT FOUND"}

${!il2cppPath ? "\n⚠️ Warning: No IL2CPP binary found. This may not be a Unity IL2CPP game." : ""}
${!hasMetadata ? "\n⚠️ Warning: global-metadata.dat not found." : ""}`,

    metadata: {
      success: true,
      type: "apk",
      outputDir: outputDir,
      il2cpp: il2cppPath,
      metadata: hasMetadata ? metadataPath : null,
      assets: hasAssets ? assetsPath : null,
      isUnityIl2cpp: !!(il2cppPath && hasMetadata),
    },
  }
}

async function unpackXAPK(inputPath: string, outputDir: string, ctx: any) {
  const tempDir = `${outputDir}_temp`
  await fs.mkdir(tempDir, { recursive: true })

  // XAPK本身就是一个ZIP
  await runCommand(ctx, `unzip -q "${inputPath}" -d "${tempDir}" 2>&1 || echo "unzip completed"`)

  // 查找主APK和OBB文件
  const files = await fs.readdir(tempDir)
  const apkFiles = files.filter((f) => f.endsWith(".apk"))
  const obbFiles = files.filter((f) => f.endsWith(".obb"))

  // 找到主APK（通常是最大的或名为base.apk）
  let mainApk = apkFiles.find((f) => f === "base.apk" || f.includes("base"))
  if (!mainApk && apkFiles.length > 0) {
    // 如果没有base.apk，选择第一个非config的APK
    mainApk = apkFiles.find((f) => !f.includes("config")) || apkFiles[0]
  }

  if (!mainApk) {
    return {
      output: `Error: No APK found in XAPK file`,
      metadata: { success: false, error: "No APK in XAPK" },
    }
  }

  // 解压主APK
  const mainApkPath = path.join(tempDir, mainApk)
  await runCommand(ctx, `unzip -q "${mainApkPath}" -d "${outputDir}" 2>&1 || echo "unzip completed"`)

  // 解压所有 config APK（包含 split 的 so 库）
  const configApks = apkFiles.filter((f) => f.includes("config") || f.includes("split"))
  for (const configApk of configApks) {
    const configPath = path.join(tempDir, configApk)
    await runCommand(ctx, `unzip -qo "${configPath}" -d "${outputDir}" 2>&1 || echo "config apk extracted"`)
  }

  // 处理OBB文件
  if (obbFiles.length > 0) {
    const obbDir = path.join(outputDir, "obb")
    await fs.mkdir(obbDir, { recursive: true })

    for (const obb of obbFiles) {
      const obbPath = path.join(tempDir, obb)
      // OBB文件也是ZIP格式
      await runCommand(
        ctx,
        `unzip -q "${obbPath}" -d "${obbDir}/${path.basename(obb, ".obb")}" 2>&1 || echo "obb extracted"`,
      )
    }
  }

  // 清理临时目录
  await fs.rm(tempDir, { recursive: true, force: true })

  // 定位IL2CPP文件（同APK）
  const il2cppPaths = [
    path.join(outputDir, "lib/arm64-v8a/libil2cpp.so"),
    path.join(outputDir, "lib/armeabi-v7a/libil2cpp.so"),
  ]

  let il2cppPath = null
  for (const p of il2cppPaths) {
    try {
      await fs.access(p)
      il2cppPath = p
      break
    } catch {}
  }

  const metadataPath = path.join(outputDir, "assets/bin/Data/Managed/Metadata/global-metadata.dat")
  const assetsPath = path.join(outputDir, "assets")

  const hasMetadata = await fileExists(metadataPath)
  const hasAssets = await fileExists(assetsPath)

  return {
    output: `XAPK extracted successfully to ${outputDir}

Main APK: ${mainApk}
OBB files: ${obbFiles.length} found

Files found:
- IL2CPP Binary: ${il2cppPath || "NOT FOUND"}
- Metadata: ${hasMetadata ? metadataPath : "NOT FOUND"}
- Assets: ${hasAssets ? assetsPath : "NOT FOUND"}
- OBB Data: ${obbFiles.length > 0 ? path.join(outputDir, "obb") : "None"}

${!il2cppPath ? "\n⚠️ Warning: No IL2CPP binary found." : ""}
${!hasMetadata ? "\n⚠️ Warning: global-metadata.dat not found." : ""}`,

    metadata: {
      success: true,
      type: "xapk",
      outputDir: outputDir,
      il2cpp: il2cppPath,
      metadata: hasMetadata ? metadataPath : null,
      assets: hasAssets ? assetsPath : null,
      obb: obbFiles.length > 0 ? path.join(outputDir, "obb") : null,
      isUnityIl2cpp: !!(il2cppPath && hasMetadata),
    },
  }
}

async function unpackIPA(inputPath: string, outputDir: string, ctx: any) {
  const tempDir = `${outputDir}_temp`
  await fs.mkdir(tempDir, { recursive: true })

  // 解压IPA
  await runCommand(ctx, `unzip -q "${inputPath}" -d "${tempDir}" 2>&1 || echo "unzip completed"`)

  // 找到Payload目录中的.app
  const payloadDir = path.join(tempDir, "Payload")
  const payloadExists = await fileExists(payloadDir)

  if (!payloadExists) {
    return {
      output: `Error: Invalid IPA structure - Payload directory not found`,
      metadata: { success: false, error: "Invalid IPA" },
    }
  }

  const payloadContents = await fs.readdir(payloadDir)
  const appDir = payloadContents.find((f) => f.endsWith(".app"))

  if (!appDir) {
    return {
      output: `Error: No .app bundle found in IPA`,
      metadata: { success: false, error: "No app bundle" },
    }
  }

  // 复制.app到输出目录
  const appPath = path.join(payloadDir, appDir)
  const targetPath = path.join(outputDir, appDir)
  await runCommand(ctx, `cp -r "${appPath}" "${targetPath}"`)

  // 清理临时目录
  await fs.rm(tempDir, { recursive: true, force: true })

  // 定位IL2CPP文件（iOS位置不同）
  const il2cppPaths = [
    path.join(targetPath, "Frameworks/UnityFramework.framework/UnityFramework"),
    path.join(targetPath, appDir.replace(".app", "")), // 主可执行文件
  ]

  let il2cppPath = null
  for (const p of il2cppPaths) {
    try {
      await fs.access(p)
      il2cppPath = p
      break
    } catch {}
  }

  const metadataPaths = [
    path.join(targetPath, "Data/Managed/Metadata/global-metadata.dat"),
    path.join(targetPath, "Data/Raw/Metadata/global-metadata.dat"),
  ]

  let metadataPath = null
  for (const p of metadataPaths) {
    try {
      await fs.access(p)
      metadataPath = p
      break
    } catch {}
  }

  const assetsPath = path.join(targetPath, "Data")
  const hasAssets = await fileExists(assetsPath)

  return {
    output: `IPA extracted successfully to ${outputDir}

App Bundle: ${appDir}

Files found:
- IL2CPP Binary: ${il2cppPath || "NOT FOUND"}
- Metadata: ${metadataPath || "NOT FOUND"}
- Assets: ${hasAssets ? assetsPath : "NOT FOUND"}

${!il2cppPath ? "\n⚠️ Warning: No IL2CPP binary found. May need decryption if from App Store." : ""}
${!metadataPath ? "\n⚠️ Warning: global-metadata.dat not found." : ""}`,

    metadata: {
      success: true,
      type: "ipa",
      outputDir: outputDir,
      appBundle: targetPath,
      il2cpp: il2cppPath,
      metadata: metadataPath,
      assets: hasAssets ? assetsPath : null,
      isUnityIl2cpp: !!(il2cppPath && metadataPath),
    },
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}
