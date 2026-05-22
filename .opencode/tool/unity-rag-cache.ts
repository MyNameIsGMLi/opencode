import { deflateSync, inflateSync } from "zlib"

// ── 分层索引格式（v2.0.0）──────────────────────────────────────────────────
//
// 背景：index.json v1 是 39 MB 的单层 flat JSON（114K chunks），其中
//   - method chunks 占 85%（97K 条），但检索频率极低
//   - class/verified/module chunks 是检索热数据（约 5 MB）
//
// v2 策略：热/冷分离
//   - hotChunks：未压缩，直接内存访问
//   - coldChunks：Deflate level 1 压缩（6-8x 压缩比），按需解压

export interface CompressedChunk {
  id: string
  type: string
  compressed: string  // base64(deflate(JSON.stringify(chunk)))
  originalSize: number
}

export interface HotChunks {
  classes: any[]    // type:"class"    检索热数据
  modules: any[]    // type:"module"   模块摘要
  verified: any[]   // type:"verified" 已验证代码
}

export interface ColdChunks {
  methods: CompressedChunk[]  // 97K+ 条，压缩存储
  ida: CompressedChunk[]      // IDA 伪代码，按需解压
}

export interface RAGIndexV2 {
  version: "2.0.0"
  createdAt: string
  updatedAt: string
  hotChunks: HotChunks
  coldChunks: ColdChunks
  stats: {
    totalClasses: number
    totalMethods: number
    idaAnalyzed: number
    verifiedImplementations: number
    compressionRatio: number  // method chunks 压缩比
  }
}

// ── 压缩 / 解压 ────────────────────────────────────────────────────────────

export function compressChunk(chunk: any): CompressedChunk {
  const json = JSON.stringify(chunk)
  const originalSize = Buffer.byteLength(json, "utf-8")
  // level 1 = 最快速度，约 500 MB/s，压缩比 6-8x
  const compressed = deflateSync(json, { level: 1 })
  return {
    id: chunk.id,
    type: chunk.type,
    compressed: compressed.toString("base64"),
    originalSize,
  }
}

export function decompressChunk(c: CompressedChunk): any {
  const buf = Buffer.from(c.compressed, "base64")
  return JSON.parse(inflateSync(buf).toString("utf-8"))
}

export function compressBatch(chunks: any[]): CompressedChunk[] {
  return chunks.map(compressChunk)
}

// ── 版本检测 + 向后兼容迁移 ────────────────────────────────────────────────

export function isV2(raw: any): raw is RAGIndexV2 {
  return raw?.version === "2.0.0"
}

/**
 * v1 flat chunks → v2 分层格式（纯内存转换，不写文件）
 * 用于向后兼容：旧项目仍有 v1 index.json 时自动升级
 */
export function migrateV1toV2(old: any): RAGIndexV2 {
  const hotChunks: HotChunks = {
    classes:  old.chunks.filter((c: any) => c.type === "class"),
    modules:  old.chunks.filter((c: any) => c.type === "module"),
    verified: old.chunks.filter((c: any) => c.type === "verified"),
  }
  const methodChunks = old.chunks.filter((c: any) => c.type === "method")
  const idaChunks    = old.chunks.filter((c: any) => c.type === "ida")

  const compressedMethods = compressBatch(methodChunks)
  const originalBytes = methodChunks.reduce(
    (sum: number, c: any) => sum + Buffer.byteLength(JSON.stringify(c), "utf-8"),
    0,
  )
  const compressedBytes = compressedMethods.reduce(
    (sum: number, c: CompressedChunk) => sum + Buffer.byteLength(c.compressed, "utf-8"),
    0,
  )

  return {
    version: "2.0.0",
    createdAt: old.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hotChunks,
    coldChunks: {
      methods: compressedMethods,
      ida: compressBatch(idaChunks),
    },
    stats: {
      ...(old.stats ?? {}),
      compressionRatio:
        compressedBytes > 0
          ? Math.round((originalBytes / compressedBytes) * 10) / 10
          : 0,
    },
  }
}

/**
 * 将 v2 展开为全量 flat chunks 数组（向后兼容旧工具用）
 */
export function flattenV2(index: RAGIndexV2): any[] {
  return [
    ...index.hotChunks.classes,
    ...index.hotChunks.modules,
    ...index.hotChunks.verified,
    ...index.coldChunks.methods.map(decompressChunk),
    ...index.coldChunks.ida.map(decompressChunk),
  ]
}

// ── 分页工具 ────────────────────────────────────────────────────────────────

export interface PaginationParams {
  offset?: number
  limit?: number
}

export interface PaginatedResult<T> {
  items: T[]
  pagination: {
    total: number
    offset: number
    limit: number
    hasMore: boolean
    nextOffset: number | null
    prevOffset: number | null
    currentPage: number
    totalPages: number
  }
}

/**
 * 通用分页函数
 * - 默认 100 条/页，最大 1000 条/页
 * - 返回完整分页元数据，方便 MCP 客户端导航
 */
export function paginate<T>(
  allItems: T[],
  params: PaginationParams = {},
): PaginatedResult<T> {
  const offset = params.offset ?? 0
  const limit  = Math.min(params.limit ?? 100, 1000)
  const items  = allItems.slice(offset, offset + limit)
  const total  = allItems.length
  const hasMore = offset + limit < total

  return {
    items,
    pagination: {
      total,
      offset,
      limit,
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
      prevOffset: offset > 0 ? Math.max(0, offset - limit) : null,
      currentPage: Math.floor(offset / limit) + 1,
      totalPages:  Math.ceil(total / limit),
    },
  }
}
