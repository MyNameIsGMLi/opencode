import { tool } from "@opencode-ai/plugin"
import * as path from "path"
import * as fs from "fs/promises"

export default tool({
  description:
    "Validate reversed C# code using Roslyn compiler. Ensures generated code is syntactically correct and can be compiled. Provides detailed error messages and compilation statistics.",

  args: {
    sourceFiles: tool.schema.array(tool.schema.string()).describe("Array of C# source file paths to validate"),
    outputDir: tool.schema.string().optional().describe("Output directory for validation report"),
    unityVersion: tool.schema.string().optional().describe("Unity version for DLL references (default: 2021.3)"),
  },

  async execute(args, ctx) {
    // 创建C#验证项目
    const validationDir = args.outputDir || "/tmp/unity_validation_" + Date.now()
    await fs.mkdir(validationDir, { recursive: true })

    // 创建.csproj文件
    const csprojContent = generateCsProj(args.unityVersion || "2021.3")
    const csprojPath = path.join(validationDir, "ValidationProject.csproj")
    await ctx.write(csprojPath, csprojContent)

    // 复制源文件到项目
    const sourceDir = path.join(validationDir, "Source")
    await fs.mkdir(sourceDir, { recursive: true })

    const copiedFiles: string[] = []
    for (const sourceFile of args.sourceFiles) {
      const fileName = path.basename(sourceFile)
      const targetPath = path.join(sourceDir, fileName)

      try {
        const content = await ctx.read(sourceFile)
        await ctx.write(targetPath, content)
        copiedFiles.push(targetPath)
      } catch (error) {
        return {
          output: `Error: Cannot read source file ${sourceFile}: ${error}`,
          metadata: { success: false, error: "File read error" },
        }
      }
    }

    // 运行Roslyn编译
    const compileResult = await compileWithRoslyn(validationDir, csprojPath, ctx)

    if (compileResult.success) {
      // 生成成功报告
      const report = generateSuccessReport(copiedFiles, compileResult)
      const reportPath = path.join(validationDir, "validation_report.txt")
      await ctx.write(reportPath, report)

      return {
        output: `✓ Validation successful!

Files validated: ${copiedFiles.length}
Total lines: ${compileResult.totalLines}
Compilation: Success
Warnings: ${compileResult.warnings}

Report saved to: ${reportPath}

All files are syntactically correct and compile successfully.`,

        metadata: {
          success: true,
          filesValidated: copiedFiles.length,
          totalLines: compileResult.totalLines,
          warnings: compileResult.warnings,
          reportPath: reportPath,
        },
      }
    } else {
      // 生成错误报告
      const report = generateErrorReport(copiedFiles, compileResult)
      const reportPath = path.join(validationDir, "validation_errors.txt")
      await ctx.write(reportPath, report)

      return {
        output: `✗ Validation failed

Files validated: ${copiedFiles.length}
Compilation errors: ${compileResult.errors.length}

Top errors:
${compileResult.errors
  .slice(0, 10)
  .map((e) => `- ${e}`)
  .join("\n")}

${compileResult.errors.length > 10 ? `\n... and ${compileResult.errors.length - 10} more errors` : ""}

Full report: ${reportPath}

Please fix these errors before proceeding.`,

        metadata: {
          success: false,
          filesValidated: copiedFiles.length,
          errorCount: compileResult.errors.length,
          errors: compileResult.errors,
          reportPath: reportPath,
        },
      }
    }
  },
})

function generateCsProj(unityVersion: string): string {
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.1</TargetFramework>
    <LangVersion>9.0</LangVersion>
    <Nullable>disable</Nullable>
    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
    <NoWarn>CS0108;CS0114;CS0628;CS0649;CS8603;CS8618;CS8625</NoWarn>
  </PropertyGroup>

  <ItemGroup>
    <!-- Unity Engine DLLs -->
    <Reference Include="UnityEngine.CoreModule">
      <HintPath>/Applications/Unity/Hub/Editor/${unityVersion}/Unity.app/Contents/Managed/UnityEngine/UnityEngine.CoreModule.dll</HintPath>
      <Private>False</Private>
    </Reference>
    <Reference Include="UnityEngine">
      <HintPath>/Applications/Unity/Hub/Editor/${unityVersion}/Unity.app/Contents/Managed/UnityEngine/UnityEngine.dll</HintPath>
      <Private>False</Private>
    </Reference>
    <Reference Include="UnityEngine.UI">
      <HintPath>/Applications/Unity/Hub/Editor/${unityVersion}/Unity.app/Contents/Managed/UnityEngine/UnityEngine.UI.dll</HintPath>
      <Private>False</Private>
    </Reference>
  </ItemGroup>

  <ItemGroup>
    <Compile Include="Source/**/*.cs" />
  </ItemGroup>
</Project>`
}

async function compileWithRoslyn(
  projectDir: string,
  csprojPath: string,
  ctx: any,
): Promise<{
  success: boolean
  errors: string[]
  warnings: number
  totalLines: number
}> {
  try {
    // 使用dotnet build编译
    const buildOutput = await ctx.bash(
      `cd "${projectDir}" && dotnet build "${csprojPath}" --nologo --verbosity quiet 2>&1`,
      { timeout: 120000 }, // 2分钟超时
    )

    // 解析编译输出
    const errors: string[] = []
    const warningMatches = buildOutput.match(/\d+ Warning\(s\)/g)
    const warnings = warningMatches ? parseInt(warningMatches[0]) : 0

    // 检查是否有错误
    if (buildOutput.includes("Build FAILED") || buildOutput.includes("error CS")) {
      // 提取错误信息
      const errorPattern = /error CS\d+:.*$/gm
      const errorMatches = buildOutput.match(errorPattern)
      if (errorMatches) {
        errors.push(...errorMatches)
      }
    }

    // 统计总行数
    const sourceFiles = await ctx.glob(path.join(projectDir, "Source/**/*.cs"))
    let totalLines = 0
    for (const file of sourceFiles) {
      const content = await ctx.read(file)
      totalLines += content.split("\n").length
    }

    return {
      success: errors.length === 0,
      errors,
      warnings,
      totalLines,
    }
  } catch (error) {
    // 编译失败
    return {
      success: false,
      errors: [`Compilation process failed: ${error}`],
      warnings: 0,
      totalLines: 0,
    }
  }
}

function generateSuccessReport(files: string[], result: any): string {
  return `Unity Reverse Engineering Validation Report
============================================

Status: ✓ SUCCESS
Date: ${new Date().toISOString()}

Files Validated: ${files.length}
Total Lines of Code: ${result.totalLines}
Compilation: Success
Warnings: ${result.warnings}

Validated Files:
${files.map((f, i) => `${i + 1}. ${path.basename(f)}`).join("\n")}

All files passed Roslyn compilation checks.
The generated C# code is syntactically correct and ready for use.
`
}

function generateErrorReport(files: string[], result: any): string {
  return `Unity Reverse Engineering Validation Report
============================================

Status: ✗ FAILED
Date: ${new Date().toISOString()}

Files Validated: ${files.length}
Compilation Errors: ${result.errors.length}
Warnings: ${result.warnings}

Validated Files:
${files.map((f, i) => `${i + 1}. ${path.basename(f)}`).join("\n")}

Compilation Errors:
${result.errors.map((e: string, i: number) => `${i + 1}. ${e}`).join("\n")}

Please review and fix these errors before using the generated code.
`
}
