import { getRouterParam } from 'h3'
import { and, eq } from 'drizzle-orm'
import { db } from '~/drizzle/db'
import { communitySongLikes } from '~/drizzle/schema'
import { createApiError } from '~~/server/utils/apiError'
import { requireCommunityUser } from '~~/server/utils/community'
import { matchSongBlacklistCheap } from '~~/server/utils/songBlacklistMatch'
import {
  getSongFacts,
  likeCommunitySong,
  unlikeCommunitySong
} from '~~/server/utils/communitySongLikes'

/**
 * 社区内歌曲点赞：POST /api/community/songs/:id/like
 * 与 /api/songs/vote（点歌页）解耦：任意非黑名单歌曲都能点，
 * 只有「待排期」歌曲的赞才会同步进 Vote 表计入投稿热度。
 */
export default defineEventHandler(async (event) => {
  const user = requireCommunityUser(event)

  const songId = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(songId) || songId <= 0) {
    throw createApiError(400, 'COMMON_INVALID_PARAMS', '歌曲参数不正确')
  }

  const facts = await getSongFacts(songId)
  if (!facts) throw createApiError(404, 'SONG_NOT_FOUND', '歌曲不存在')

  const blacklist = await matchSongBlacklistCheap(facts.title, facts.artist)
  if (blacklist.hit) {
    throw createApiError(400, 'SONG_BLACKLISTED', blacklist.reason || '该歌曲已被加入黑名单')
  }

  // 点赞时是否让投稿人知道是我（沿用点歌页的署名/匿名语义）
  const body = await readBody(event).catch(() => null)
  const reveal = body?.reveal !== false

  const [existing] = await db
    .select({ songId: communitySongLikes.songId })
    .from(communitySongLikes)
    .where(and(eq(communitySongLikes.songId, songId), eq(communitySongLikes.userId, user.id)))
    .limit(1)

  const result = existing
    ? await unlikeCommunitySong(songId, user.id)
    : await likeCommunitySong(songId, user.id, reveal)

  return { success: true, ...result }
})
