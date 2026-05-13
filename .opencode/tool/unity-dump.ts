import { tool } from "@opencode-ai/plugin"
import * as path from "path"
import * as fs from "fs/promises"

export default tool({
  description:
    "Run Il2CppDumper to extract metadata and generate C# stubs from Unity IL2CPP binaries. Produces dump.cs, script.json, DummyDll files, and optionally runs IDA Pro analysis for deep code logic extraction.",

  args: {
    binaryPath: tool.schema.string().describe("Path to IL2CPP binary (libil2cpp.so or UnityFramework)"),
    metadataPath: tool.schema.string().describe("Path to global-metadata.dat file"),
    outputDir: tool.schema.string().optional().describe("Output directory for dump files (defaults to ./il2cpp_dump)"),
    runIdaAnalysis: tool.schema
      .boolean()
      .optional()
      .describe("Run IDA Pro deep analysis (requires IDA Pro installed, default: true)"),
    idaPath: tool.schema.string().optional().describe("Path to IDA Pro executable (default: auto-detect)"),
  },

  async execute(args, ctx) {
    // 验证输入文件
    try {
      await fs.access(args.binaryPath)
      await fs.access(args.metadataPath)
    } catch (error) {
      return {
        output: `Error: Input files not found.\nBinary: ${args.binaryPath}\nMetadata: ${args.metadataPath}`,
        metadata: { success: false, error: "Input files not found" },
      }
    }

    const outputDir = args.outputDir || path.join(process.cwd(), "il2cpp_dump")
    await fs.mkdir(outputDir, { recursive: true })

    // Il2CppDumper路径
    const dumperPath = path.join(
      process.cwd(),
      "packages/opencode/unity-reverse-tools/external/Il2CppDumper/Il2CppDumper",
    )

    // 检查Il2CppDumper是否存在
    const dumperExists = await fileExists(dumperPath)
    if (!dumperExists) {
      return {
        output: `Error: Il2CppDumper not found at ${dumperPath}\nPlease build Il2CppDumper first.`,
        metadata: { success: false, error: "Il2CppDumper not found" },
      }
    }

    // 运行Il2CppDumper
    const dumpOutput = await ctx.bash(
      `"${dumperPath}" "${args.binaryPath}" "${args.metadataPath}" "${outputDir}"`,
      { timeout: 300000 }, // 5分钟超时
    )

    // 验证输出文件
    const expectedFiles = {
      dumpCs: path.join(outputDir, "dump.cs"),
      scriptJson: path.join(outputDir, "script.json"),
      dummyDll: path.join(outputDir, "DummyDll"),
      stringLiteral: path.join(outputDir, "stringliteral.json"),
      il2cppH: path.join(outputDir, "il2cpp.h"),
      idaPy: path.join(outputDir, "ida_with_struct_py3.py"),
    }

    const fileStatus: Record<string, boolean> = {}
    for (const [key, filePath] of Object.entries(expectedFiles)) {
      fileStatus[key] = await fileExists(filePath)
    }

    const allCoreFilesExist = fileStatus.dumpCs && fileStatus.scriptJson

    if (!allCoreFilesExist) {
      return {
        output: `Il2CppDumper completed but core files are missing:
${dumpOutput}

File status:
- dump.cs: ${fileStatus.dumpCs ? "✓" : "✗"}
- script.json: ${fileStatus.scriptJson ? "✓" : "✗"}
- DummyDll: ${fileStatus.dummyDll ? "✓" : "✗"}`,
        metadata: {
          success: false,
          error: "Core output files missing",
          outputDir: outputDir,
          fileStatus: fileStatus,
        },
      }
    }

    let idaAnalysisPath: string | null = null

    // 可选：运行IDA Pro深度分析
    if (args.runIdaAnalysis !== false) {
      const idaResult = await runIdaAnalysis(args.binaryPath, outputDir, expectedFiles.idaPy, args.idaPath, ctx)

      if (idaResult.success) {
        idaAnalysisPath = idaResult.analysisPath
      }
    }

    // 分析dump.cs获取统计信息
    const stats = await analyzeDumpCs(expectedFiles.dumpCs)

    return {
      output: `Il2CppDumper completed successfully!

Output directory: ${outputDir}

Generated files:
- dump.cs: ✓ (${stats.totalClasses} classes, ${stats.totalMethods} methods)
- script.json: ✓
- DummyDll: ${fileStatus.dummyDll ? "✓" : "✗"}
- stringliteral.json: ${fileStatus.stringLiteral ? "✓" : "✗"}
- il2cpp.h: ${fileStatus.il2cppH ? "✓" : "✗"}
- IDA scripts: ${fileStatus.idaPy ? "✓" : "✗"}

${idaAnalysisPath ? `\nIDA Analysis: ✓ (${idaAnalysisPath})` : "\nIDA Analysis: Not run (set runIdaAnalysis: true to enable)"}

Statistics:
- Total namespaces: ${stats.namespaces.length}
- Total classes: ${stats.totalClasses}
- Total methods: ${stats.totalMethods}
- String literals: ${stats.stringLiterals}

Next steps:
1. Use unity-target-finder to identify game code classes
2. Use unity-reverse to reconstruct C# code with AI`,

      metadata: {
        success: true,
        outputDir: outputDir,
        files: {
          dumpCs: expectedFiles.dumpCs,
          scriptJson: expectedFiles.scriptJson,
          dummyDll: fileStatus.dummyDll ? expectedFiles.dummyDll : null,
          stringLiteral: fileStatus.stringLiteral ? expectedFiles.stringLiteral : null,
          il2cppH: fileStatus.il2cppH ? expectedFiles.il2cppH : null,
          idaPy: fileStatus.idaPy ? expectedFiles.idaPy : null,
          idaAnalysis: idaAnalysisPath,
        },
        statistics: stats,
      },
    }
  },
})

async function runIdaAnalysis(
  binaryPath: string,
  outputDir: string,
  idaScriptPath: string,
  idaPath: string | undefined,
  ctx: any,
): Promise<{ success: boolean; analysisPath: string | null }> {
  // 检查IDA脚本是否存在
  if (!(await fileExists(idaScriptPath))) {
    return { success: false, analysisPath: null }
  }

  // 自动检测IDA Pro
  const idaPaths = idaPath
    ? [idaPath]
    : [
        "/Applications/IDA Pro 8.3/ida64.app/Contents/MacOS/ida64", // macOS
        "/Applications/IDA Pro 8.4/ida64.app/Contents/MacOS/ida64",
        "/Applications/IDA Pro/ida64.app/Contents/MacOS/ida64",
        "/usr/local/bin/ida64", // Linux
        "C:\\Program Files\\IDA Pro 8.3\\ida64.exe", // Windows
        "C:\\Program Files\\IDA Pro\\ida64.exe",
      ]

  let idaExecutable: string | null = null
  for (const p of idaPaths) {
    if (await fileExists(p)) {
      idaExecutable = p
      break
    }
  }

  if (!idaExecutable) {
    // IDA not found, skip analysis
    return { success: false, analysisPath: null }
  }

  // 创建增强的IDA分析脚本
  const analysisScriptPath = path.join(outputDir, "deep_analysis.py")
  const analysisScript = `# -*- coding: utf-8 -*-
import idaapi
import idautils
import idc
import ida_auto
import ida_xref
import json
import os

# 等待IDA自动分析完成
ida_auto.auto_wait()

# 首先加载Il2CppDumper生成的脚本
exec(open('${idaScriptPath.replace(/\\/g, "\\\\")}').read())

print("[+] Il2CppDumper script loaded")

# 深度分析：提取方法逻辑信息
analysis = {}
total_funcs = 0

for func_ea in idautils.Functions():
    func_name = idc.get_func_name(func_ea)
    
    # 只分析有意义的函数名（跳过sub_xxx）
    if func_name.startswith('sub_'):
        continue
    
    total_funcs += 1
    
    # 提取调用的方法
    called_methods = []
    for xref in idautils.CodeRefsFrom(func_ea, 1):
        target_name = idc.get_func_name(xref)
        if target_name and not target_name.startswith('sub_'):
            called_methods.append(target_name)
    
    # 提取使用的字符串
    strings_used = []
    for item_ea in idautils.FuncItems(func_ea):
        for xref in idautils.DataRefsFrom(item_ea):
            str_val = idc.get_strlit_contents(xref)
            if str_val:
                try:
                    strings_used.append(str_val.decode('utf-8', errors='ignore'))
                except:
                    pass
    
    # 提取访问的字段（数据引用）
    accessed_fields = []
    for item_ea in idautils.FuncItems(func_ea):
        for xref in idautils.DataRefsFrom(item_ea):
            # 尝试获取变量名
            name = idc.get_name(xref)
            if name and not name.startswith('unk_') and not name.startswith('off_'):
                accessed_fields.append(name)
    
    # 分析控制流
    func_end = idc.get_func_attr(func_ea, idc.FUNCATTR_END)
    func_size = func_end - func_ea
    
    # 简单的控制流分析（检测是否有循环、条件分支）
    has_loop = False
    has_switch = False
    branch_count = 0
    
    for item_ea in idautils.FuncItems(func_ea):
        mnem = idc.print_insn_mnem(item_ea)
        if mnem in ['b', 'bl', 'bne', 'beq', 'blt', 'bgt', 'jmp', 'je', 'jne']:
            branch_count += 1
            # 检测后向跳转（循环）
            target = idc.get_operand_value(item_ea, 0)
            if target < item_ea:
                has_loop = True
        elif mnem in ['tbb', 'tbh', 'switch']:
            has_switch = True
    
    control_flow = 'linear'
    if has_switch:
        control_flow = 'switch'
    elif has_loop:
        control_flow = 'loop'
    elif branch_count > 2:
        control_flow = 'complex_branch'
    elif branch_count > 0:
        control_flow = 'if_else'
    
    analysis[func_name] = {
        'address': hex(func_ea),
        'size': func_size,
        'called_methods': list(set(called_methods))[:20],  # 限制数量
        'strings': list(set(strings_used))[:10],
        'accessed_fields': list(set(accessed_fields))[:10],
        'control_flow': control_flow,
        'branch_count': branch_count,
    }
    
    if total_funcs % 100 == 0:
        print(f"[+] Analyzed {total_funcs} functions...")

print(f"[+] Total analyzed: {total_funcs} functions")

# 保存分析结果
output_path = '${path.join(outputDir, "ida_analysis.json").replace(/\\/g, "\\\\")}'
with open(output_path, 'w', encoding='utf-8') as f:
    json.dump(analysis, f, indent=2, ensure_ascii=False)

print(f"[+] Analysis saved to {output_path}")

# 退出IDA
idc.qexit(0)
`

  await ctx.write(analysisScriptPath, analysisScript)

  // 在后台运行IDA分析（可能需要很长时间）
  const idaOutputPath = path.join(outputDir, "ida_analysis.json")

  try {
    // 批处理模式运行IDA
    await ctx.bash(
      `"${idaExecutable}" -A -S"${analysisScriptPath}" "${binaryPath}" > "${outputDir}/ida.log" 2>&1`,
      { timeout: 1800000 }, // 30分钟超时
    )

    // 检查输出文件
    if (await fileExists(idaOutputPath)) {
      return { success: true, analysisPath: idaOutputPath }
    }
  } catch (error) {
    // IDA分析失败，但不影响主流程
    return { success: false, analysisPath: null }
  }

  return { success: false, analysisPath: null }
}

async function analyzeDumpCs(dumpCsPath: string): Promise<{
  totalClasses: number
  totalMethods: number
  namespaces: string[]
  stringLiterals: number
}> {
  try {
    const content = await fs.readFile(dumpCsPath, "utf-8")

    // 统计类
    const classMatches = content.match(
      /^(\s*)(?:public|internal|private|protected)?\s*(?:abstract|sealed|static)?\s*(?:class|struct|enum|interface)\s+\w+/gm,
    )
    const totalClasses = classMatches ? classMatches.length : 0

    // 统计方法（包括构造函数）
    const methodMatches = content.match(
      /^\s*(?:public|private|protected|internal)?\s*(?:static|virtual|override|abstract)?\s*(?:\w+\s+)+\w+\s*\([^)]*\)/gm,
    )
    const totalMethods = methodMatches ? methodMatches.length : 0

    // 提取命名空间
    const namespaceMatches = content.match(/^namespace\s+([\w.]+)/gm)
    const namespaces = namespaceMatches
      ? Array.from(new Set(namespaceMatches.map((m) => m.replace(/^namespace\s+/, ""))))
      : []

    // 估计字符串字面量
    const stringMatches = content.match(/StringLiteral_\d+/g)
    const stringLiterals = stringMatches ? new Set(stringMatches).size : 0

    return {
      totalClasses,
      totalMethods,
      namespaces,
      stringLiterals,
    }
  } catch (error) {
    return {
      totalClasses: 0,
      totalMethods: 0,
      namespaces: [],
      stringLiterals: 0,
    }
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
