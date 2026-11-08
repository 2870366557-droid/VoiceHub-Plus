/**
 * 歌曲黑名单判定的唯一实现。
 *
 * 设计要点：
 * - 黑名单项一律从 songBlacklists 表读取（后台「黑名单管理」配置），不做任何硬编码；
 * - 后台增改删会调用 invalidateSongBlacklistCache()，让新配置立即生效；
 * - 缓存只是加速用的短时副本（10 秒），配置变更后立即失效，不会长期不一致。
 *
 * 判定口径与投稿时一致：用「标题 - 歌手」小写串做子串匹配。
 * 语种/曲风需要按音源解析类型，因此拆成「廉价（仅歌名+关键词）」与「完整（叠加语种+曲风）」两种：
 * 选歌列表这类批量场景用廉价版，写入这类单点场景用完整版。
 */
import { eq } from 'drizzle-orm'
import { db } from '~/drizzle/db'
import { songBlacklists } from '~/drizzle/schema'
import { resolveSongTypes, matchBlacklistLanguage, matchBlacklistGenre } from './song-type-resolver'

export type BlacklistHit = {
  type: 'song' | 'keyword' | 'language' | 'genre'
  value: string | null
  reason: string
}

type BlacklistItem = {
  type: string
  value: string
  reason: string | null
}

const CACHE_TTL_MS = 10_000
let cache: { at: number; items: BlacklistItem[] } | null = null

async function getActiveBlacklistItems(): Promise<BlacklistItem[]> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.items
  const rows = await db
    .select({
      type: songBlacklists.type,
      value: songBlacklists.value,
      reason: songBlacklists.reason
    })
    .from(songBlacklists)
    .where(eq(songBlacklists.isActive, true))
  const items = rows.map((row) => ({
    type: String(row.type || '').toUpperCase(),
    value: String(row.value || ''),
    reason: row.reason || null
  }))
  cache = { at: now, items }
  return items
}

/** 后台改动黑名单后调用：让新配置立即生效，不等缓存过期 */
export function invalidateSongBlacklistCache(): void {
  cache = null
}

function songFullName(title: string | null | undefined, artist: string | null | undefined): string {
  return `${String(title || '').trim()} - ${String(artist || '').trim()}`.toLowerCase()
}

/**
 * 完整判定（歌名 + 关键词 + 语种 + 曲风）。
 * 语种/曲风需要 musicPlatform + musicId 才能解析；缺失或解析失败时按放行处理，避免误伤。
 */
export async function checkSongBlacklist(params: {
  title?: string | null
  artist?: string | null
  musicPlatform?: string | null
  musicId?: string | null
  /** 为 true 时隐藏具体命中的关键词（跟随系统设置 showBlacklistKeywords） */
  hideKeywordValue?: boolean
}): Promise<{ isBlocked: boolean; reasons: BlacklistHit[] }> {
  const items = await getActiveBlacklistItems()
  if (!items.length) return { isBlocked: false, reasons: [] }

  const fullName = songFullName(params.title, params.artist)
  const hits: BlacklistHit[] = []

  const languageItems = items.filter((item) => item.type === 'LANGUAGE' && !!item.value)
  const genreItems = items.filter((item) => item.type === 'GENRE' && !!item.value)
  let songTypes: Awaited<ReturnType<typeof resolveSongTypes>> = null
  const needTypes = languageItems.length > 0 || genreItems.length > 0
  if (needTypes) {
    try {
      songTypes = await resolveSongTypes(
        String(params.musicPlatform || '') || null,
        String(params.musicId || '') || null
      )
    } catch {
      songTypes = null
    }
  }

  for (const item of items) {
    if (!item.value) continue
    if (item.type === 'SONG') {
      if (fullName.includes(item.value.toLowerCase())) {
        hits.push({
          type: 'song',
          value: item.value,
          reason: item.reason || '该歌曲已被加入黑名单'
        })
      }
    } else if (item.type === 'KEYWORD') {
      if (fullName.includes(item.value.toLowerCase())) {
        hits.push({
          type: 'keyword',
          value: params.hideKeywordValue ? null : item.value,
          reason:
            item.reason ||
            (params.hideKeywordValue ? '包含关键词' : `包含关键词：${item.value}`)
        })
      }
    } else if (item.type === 'LANGUAGE') {
      if (songTypes && matchBlacklistLanguage(item.value, songTypes.languages)) {
        hits.push({
          type: 'language',
          value: item.value,
          reason: item.reason || `该歌曲语种「${item.value}」已被加入黑名单`
        })
      }
    } else if (item.type === 'GENRE') {
      if (songTypes && matchBlacklistGenre(item.value, songTypes.genres)) {
        hits.push({
          type: 'genre',
          value: item.value,
          reason: item.reason || `该歌曲曲风「${item.value}」已被加入黑名单`
        })
      }
    }
  }

  return { isBlocked: hits.length > 0, reasons: hits }
}

/** 廉价判定：只做歌名与关键词的子串匹配，无外部请求，适合选歌列表这类批量场景 */
export async function matchSongBlacklistCheap(
  title: string | null | undefined,
  artist: string | null | undefined
): Promise<{ hit: boolean; reason: string | null }> {
  const items = await getActiveBlacklistItems()
  const fullName = songFullName(title, artist)
  for (const item of items) {
    if (item.type !== 'SONG' && item.type !== 'KEYWORD') continue
    if (!item.value) continue
    if (fullName.includes(item.value.toLowerCase())) {
      return { hit: true, reason: item.reason || '该歌曲已被加入黑名单' }
    }
  }
  return { hit: false, reason: null }
}

/** 单点场景的完整判定（语种/曲风需要 platform + musicId） */
export async function checkSongBlacklistFull(params: {
  title?: string | null
  artist?: string | null
  musicPlatform?: string | null
  musicId?: string | null
}): Promise<{ hit: boolean; reason: string | null }> {
  const result = await checkSongBlacklist(params)
  return {
    hit: result.isBlocked,
    reason: result.reasons[0]?.reason || null
  }
}
