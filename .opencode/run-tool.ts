#!/usr/bin/env bun
import { execSync } from "child_process"
import * as path from "path"
import * as fs from "fs/promises"
import { Glob } from "bun"

/**
 * opencode Tool Runner for Development
 * 
 * This runner implements the standard ToolContext interface (ctx):
 * - ctx.bash(cmd)
 * - ctx.tool(name, args)
 * - ctx.glob(pattern)
 * - ctx.read(filePath)
 * - ctx.write(filePath, content)
 * 
 * Usage:
 *   bun run .opencode/run-tool.ts <toolName> [args...]
 * 
 * Example:
 *   bun run .opencode/run-tool.ts unity-impl-command --init --projectDir="..."
 */

const toolDir = path.join(import.meta.dir, "tool")

// ── Parse Command Line Arguments ───────────────────────────────────────────
const args = process.argv.slice(2)
if (args.length === 0) {
  console.log("Usage: bun run .opencode/run-tool.ts <toolName> [args...]")
  console.log("Example: bun run .opencode/run-tool.ts unity-impl-command --init --projectDir=\"/path/to/project\"")
  process.exit(1)
}

const toolName = args[0]
const rawArgs = args.slice(1)

// Parse --key=value or --key value into an object
const parsedArgs: Record<string, any> = {}
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i]
  if (arg.startsWith("--")) {
    const cleanArg = arg.slice(2)
    const eqIdx = cleanArg.indexOf("=")
    if (eqIdx !== -1) {
      const key = cleanArg.slice(0, eqIdx)
      const val = cleanArg.slice(eqIdx + 1)
      parsedArgs[key] = parseValue(val)
    } else {
      const key = cleanArg
      const nextArg = rawArgs[i + 1]
      if (nextArg && !nextArg.startsWith("--")) {
        parsedArgs[key] = parseValue(nextArg)
        i++ // skip next
      } else {
        parsedArgs[key] = true // boolean flag
      }
    }
  }
}

function parseValue(val: string): any {
  if (val.toLowerCase() === "true") return true
  if (val.toLowerCase() === "false") return false
  if (!isNaN(Number(val)) && val !== "") return Number(val)
  return val
}

// ── Implement ToolContext (ctx) ─────────────────────────────────────────────
const ctx = {
  async bash(cmdStr: string, options?: any) {
    try {
      const res = execSync(cmdStr, {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: options?.timeout,
      })
      return res
    } catch (e: any) {
      throw new Error(`Command failed: ${cmdStr}\nExit Code: ${e.status}\nError: ${e.message}\nOutput: ${e.stdout || e.stderr || ""}`)
    }
  },

  async tool(name: string, toolArgs: any) {
    // Dynamically load sibling tools
    const toolModulePath = path.join(toolDir, `${name}.ts`)
    const exists = await fs.access(toolModulePath).then(() => true).catch(() => false)
    if (!exists) {
      throw new Error(`Tool ${name} not found at ${toolModulePath}`)
    }
    const toolModule = await import(toolModulePath)
    return await toolModule.default.execute(toolArgs, ctx)
  },

  async glob(pattern: string) {
    // If pattern is absolute, resolve against cwd or use Glob
    const glob = new Glob(pattern)
    const files = Array.from(glob.scanSync({ cwd: process.cwd(), absolute: true }))
    return files
  },

  async read(filePath: string) {
    return await Bun.file(filePath).text()
  },

  async write(filePath: string, content: string) {
    await Bun.write(filePath, content)
  }
}

// ── Execute Tool ────────────────────────────────────────────────────────────
async function run() {
  const toolModulePath = path.join(toolDir, `${toolName}.ts`)
  const exists = await fs.access(toolModulePath).then(() => true).catch(() => false)
  if (!exists) {
    console.error(`Error: Tool ${toolName} not found at ${toolModulePath}`)
    process.exit(1)
  }

  console.log(`[Runner] Executing tool: ${toolName}`)
  console.log(`[Runner] Arguments:`, JSON.stringify(parsedArgs, null, 2))
  console.log(`------------------------------------------------------------\n`)

  try {
    const toolModule = await import(toolModulePath)
    const result = await toolModule.default.execute(parsedArgs, ctx)
    
    if (result.error) {
      console.error(`\n❌ Error returned by tool:\n${result.error}`)
      if (result.suggestion) console.log(`💡 Suggestion: ${result.suggestion}`)
      process.exit(1)
    }

    if (result.output) {
      console.log(result.output)
    } else {
      console.log(JSON.stringify(result, null, 2))
    }
    process.exit(0)
  } catch (e: any) {
    console.error(`\n💥 Execution crashed:\n`, e.stack || e.message || e)
    process.exit(1)
  }
}

run()
