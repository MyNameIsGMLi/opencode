import { deflateSync, inflateSync } from "zlib"

// ── 分层索引格式（v2.0.0）──────────────────────────────────────────────────
//
// 背景：index.json v1 是 39 MB 的单层 flat JSON（114K chunks），其中
//   - method chunks 占 85%（97K 条），但检索频率极低
//   - class/verified/module chunks 是检索热数据（约 5 MB）
//
// v2 策略：热/冷分离
//   - hotChunks：未压缩，直接内存访问（class/module/verified）
//   - coldChunks：整体批量压缩（Deflate level 1，7x 压缩比）
//
// 关键实测（arrows_unity_project，97K method chunks）：
//   - 逐个压缩（方案 A）：1.2x，base64 开销抵消了压缩增益
//   - 整体批量压缩（方案 B）：7.1x，31.6 MB → 4.5 MB ✅
//   原因：大数组 JSON 文本重复度极高，统一压缩效率远优于逐个压缩

export interface HotChunks {
  classes:  any[]   // type:"class"    检索热数据
  modules:  any[]   // type:"module"   模块摘要
  verified: any[]   // type:"verified" 已验证代码
}

export interface ColdChunks {
  // 整体批量压缩：base64(deflate(JSON.stringify(chunk[])))
  // 解压时一次性还原整个数组，然后按需访问
  methodsBlob: string   // 97K+ method chunks，整体压缩
  idaBlob: string       // IDA 伪代码，整体压缩（数量较少，按需解压）
  methodCount: number   // 不解压即可获得数量
  idaCount: number
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

// ── 压缩 / 解压（单个 chunk，供 IDA 动态添加使用）────────────────────────

export function compressChunk(chunk: any): string {
  // 返回 base64 编码的压缩字符串（单个 chunk 场景，IDA 用）
  const json = JSON.stringify(chunk)
  return deflateSync(json, { level: 1 }).toString("base64")
}

export function decompressChunk(compressed: string): any {
  const buf = Buffer.from(compressed, "base64")
  return JSON.parse(inflateSync(buf).toString("utf-8"))
}

// ── 批量压缩（整体数组，7x 压缩比）──────────────────────────────────────

export function compressArray(chunks: any[]): string {
  if (chunks.length === 0) return ""
  const json = JSON.stringify(chunks)
  return deflateSync(json, { level: 1 }).toString("base64")
}

export function decompressArray(blob: string): any[] {
  if (!blob) return []
  const buf = Buffer.from(blob, "base64")
  return JSON.parse(inflateSync(buf).toString("utf-8"))
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

  const originalBytes = Buffer.byteLength(JSON.stringify(methodChunks), "utf-8")
  const methodsBlob   = compressArray(methodChunks)
  const compressedBytes = Buffer.byteLength(methodsBlob, "utf-8")

  return {
    version: "2.0.0",
    createdAt: old.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hotChunks,
    coldChunks: {
      methodsBlob,
      idaBlob: compressArray(idaChunks),
      methodCount: methodChunks.length,
      idaCount:    idaChunks.length,
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
    ...decompressArray(index.coldChunks.methodsBlob),
    ...decompressArray(index.coldChunks.idaBlob),
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
