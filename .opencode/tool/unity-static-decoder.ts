import { tool } from "@opencode-ai/plugin"

/**
 * Unity 静态数值精确解码工具（A1）
 *
 * 解决"逻辑+数值 100% 精确还原"中的数值命门。两类能力：
 *
 * 1. 浮点 literal 解码：IDA 伪代码里的 float 常量以 int bits 形式出现
 *    （如 973279855f 实际是把 IEEE-754 位模式当整数显示）。手工目测极易出错
 *    （曾把 973279855 误当 0.05，实际 = 0.0005，差 100 倍）。本工具批量精确转换。
 *
 * 2. cctor 静态数组解码：解析 IDA static .cctor 伪代码里的
 *    `*(_QWORD *)(arr + offset) = 0x....` / `*(float *)(arr + N) = bits` 赋值模式，
 *    还原静态数组（如 Brick.BRICK_POS / Const.UNLOCK_STARS / ROTATE_POINTS）的精确值。
 *
 * 用法：
 *   - mode=float: 解码单个/批量 int bits 为 float
 *   - mode=qword:  解码 64 位常量为两个 float（Vector2 打包）/ 或 double / 或两个 int
 *   - mode=cctor:  传入 IDA cctor 伪代码文本，提取所有数值赋值并解码为 float/int 候选值
 */
export default tool({
  description: "Unity 静态数值精确解码：IDA 浮点 literal(int bits→float)、Vector2 打包 QWORD、cctor 静态数组赋值",

  args: {
    mode: tool.schema.enum(["float", "qword", "cctor"]).describe("解码模式"),
    values: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("mode=float/qword 时：待解码的整数常量列表（十进制或 0x 十六进制）"),
    cctorCode: tool.schema.string().optional().describe("mode=cctor 时：IDA .cctor 伪代码文本"),
  },

  async execute(args) {
    if (args.mode === "float") {
      const out = (args.values ?? []).map((v) => {
        const bits = parseIntFlexible(v) >>> 0
        return { input: v, bits, float: bitsToFloat(bits) }
      })
      return {
        output: out.map((o) => `  ${o.input}  →  float ${formatFloat(o.float)}  (bits 0x${o.bits.toString(16)})`).join("\n"),
        metadata: { success: true, mode: "float", results: out },
      }
    }

    if (args.mode === "qword") {
      const out = (args.values ?? []).map((v) => {
        const q = BigInt(parseQwordFlexible(v))
        const lo = Number(q & 0xffffffffn) >>> 0
        const hi = Number((q >> 32n) & 0xffffffffn) >>> 0
        return {
          input: v,
          as_vector2: [bitsToFloat(lo), bitsToFloat(hi)],
          as_two_int: [lo | 0, hi | 0],
          as_double: qwordToDouble(q),
        }
      })
      return {
        output: out
          .map(
            (o) =>
              `  ${o.input}\n     Vector2(${formatFloat(o.as_vector2[0])}, ${formatFloat(o.as_vector2[1])})  |  int[${o.as_two_int[0]}, ${o.as_two_int[1]}]  |  double ${o.as_double}`,
          )
          .join("\n"),
        metadata: { success: true, mode: "qword", results: out },
      }
    }

    // mode=cctor: 提取所有 *(_TYPE *)(base + offset) = value 赋值
    const code = args.cctorCode ?? ""
    const assigns = extractAssignments(code)
    return {
      output: renderCctor(assigns),
      metadata: { success: true, mode: "cctor", count: assigns.length, assignments: assigns },
    }
  },
})

// ── 数值解码原语 ──────────────────────────────────────────────────────────────

function bitsToFloat(bits: number): number {
  const buf = new ArrayBuffer(4)
  new Uint32Array(buf)[0] = bits >>> 0
  return new Float32Array(buf)[0]
}

function qwordToDouble(q: bigint): number {
  const buf = new ArrayBuffer(8)
  new BigUint64Array(buf)[0] = q & 0xffffffffffffffffn
  return new Float64Array(buf)[0]
}

function parseIntFlexible(v: string): number {
  const t = v.trim().replace(/[uUlLfF]+$/, "")
  return t.toLowerCase().startsWith("0x") ? parseInt(t, 16) : parseInt(t, 10)
}

function parseQwordFlexible(v: string): bigint {
  const t = v.trim().replace(/[uUlLfF]+$/, "")
  return t.toLowerCase().startsWith("0x") ? BigInt(t) : BigInt(t)
}

function formatFloat(f: number): string {
  if (Number.isNaN(f)) return "NaN"
  if (!Number.isFinite(f)) return f > 0 ? "Infinity" : "-Infinity"
  // 短小精确：尽量还原常见游戏数值（0.05 / 0.5 / 1 等）
  const r = Math.round(f * 1e6) / 1e6
  return String(r)
}

// 从 IDA cctor 伪代码提取赋值: *(_QWORD *)(base + N) = VALUE; / *(float *)(base + N) = VALUE;
function extractAssignments(code: string) {
  const out: Array<{ type: string; offset: number; raw: string; decoded: any }> = []
  // 匹配 *(_TYPE *)(base + N) = VALUE，VALUE 截到第一个 ; , ) 或换行（避免吞入跨行条件表达式）。
  const re = /\*\(\s*(_QWORD|_DWORD|float|double|_WORD)\s*\*\)\s*\(\s*\w+\s*\+\s*(\d+)\s*\)\s*=\s*([^;,)\n]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    const type = m[1]
    const offset = parseInt(m[2], 10)
    const raw = m[3].trim()
    out.push({ type, offset, raw, decoded: decodeRaw(type, raw) })
  }
  return out
}

function decodeRaw(type: string, raw: string): any {
  const numMatch = raw.match(/^(0x[0-9A-Fa-f]+|-?\d+)(LL|L|u|U)?$/)
  if (!numMatch) return { note: "非纯常量(可能是变量/表达式)", expr: raw }
  if (type === "_QWORD" || type === "double") {
    const q = parseQwordFlexible(numMatch[1])
    const lo = Number(q & 0xffffffffn) >>> 0
    const hi = Number((q >> 32n) & 0xffffffffn) >>> 0
    return {
      as_vector2: [formatFloat(bitsToFloat(lo)), formatFloat(bitsToFloat(hi))],
      as_two_int: [lo | 0, hi | 0],
      as_double: qwordToDouble(q),
    }
  }
  const bits = parseIntFlexible(numMatch[1]) >>> 0
  return { as_float: formatFloat(bitsToFloat(bits)), as_int: bits | 0 }
}

function renderCctor(assigns: any[]): string {
  if (assigns.length === 0) return "未从 cctor 提取到数值赋值（可能是 blob 拷贝模式 InitializeArray，需另解 FieldRVA）"
  const lines = [`从 cctor 提取 ${assigns.length} 处数值赋值（按偏移排序）：`, ""]
  for (const a of [...assigns].sort((x, y) => x.offset - y.offset)) {
    if (a.decoded.note) {
      lines.push(`  +${a.offset} (${a.type}) = ${a.raw}  → ${a.decoded.note}`)
    } else if (a.type === "_QWORD" || a.type === "double") {
      lines.push(
        `  +${a.offset} (QWORD) = ${a.raw}  →  Vector2(${a.decoded.as_vector2[0]}, ${a.decoded.as_vector2[1]}) | int[${a.decoded.as_two_int[0]},${a.decoded.as_two_int[1]}] | double ${a.decoded.as_double}`,
      )
    } else {
      lines.push(`  +${a.offset} (${a.type}) = ${a.raw}  →  float ${a.decoded.as_float} | int ${a.decoded.as_int}`)
    }
  }
  return lines.join("\n")
}
