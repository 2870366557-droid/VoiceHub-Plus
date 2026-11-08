import { getQuery } from 'h3'
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { db } from '~/drizzle/db'
import { schedules, songs } from '~/drizzle/schema'
import { requireCommunityUser } from '~~/server/utils/community'
import { getActiveSemesterName, resolveCommunitySongLikeState } from '~~/server/utils/communitySongVote'
import { matchSongBlacklistCheap } from '~~/server/utils/songBlacklistMatch'

export default defineEventHandler(async (event) => {
  const user = requireCommunityUser(event)
  const query = getQuery(event)
  const q = String(query.q || '').trim().slice(0, 50)
  const activeSemester = await getActiveSemesterName()

  const escaped = q.replace(/[\\%_]/g, (char) => `\\${char}`)
  const pattern = `%${escaped}%`
  const conditions = q ? [or(ilike(songs.title, pattern), ilike(songs.artist, pattern))!] : []

  // 选歌不受点赞资格限制：往期、已播放、已排期的歌曲都能附到帖子。
  // 唯一排除的是命中黑名单的歌曲（黑名单项读后台配置，与投稿时同一套规则）。
  const rows = await db
    .select({
      id: songs.id,
      title: songs.title,
      artist: songs.artist,
      cover: songs.cover,
      played: songs.played,
      semester: songs.semester,
      isOwn: sql<boolean>`${songs.requesterId} = ${user.id}`,
      voteCount: sql<number>`(select count(*)::int from "Vote" v where v."songId" = ${songs.id})`,
      likedByMe: sql<boolean>`exists(select 1 from "CommunitySongLike" csl where csl."songId" = ${songs.id} and csl."userId" = ${user.id})`
    })
    .from(songs)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(songs.createdAt))
    .limit(20)

  // 批量判定黑名单并剔除命中项（黑名单列表有缓存，这里只是字符串比较）
  const blacklistFlags = await Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      hit: (await matchSongBlacklistCheap(row.title, row.artist)).hit
    }))
  )
  const blacklistedIds = new Set(blacklistFlags.filter((item) => item.hit).map((item) => item.id))
  const visibleRows = rows.filter((row) => !blacklistedIds.has(row.id))

  // 单独查已发布排期，避免把排期子查询和歌曲主查询混在一起
  const scheduledRows = visibleRows.length
    ? await db
        .selectDistinct({ songId: schedules.songId })
        .from(schedules)
        .where(
          and(
            inArray(schedules.songId, visibleRows.map((row) => row.id)),
            eq(schedules.isDraft, false)
          )
        )
    : []
  const scheduledIds = new Set(scheduledRows.map((row) => row.songId))

  const songsWithLikeState = visibleRows.map((row) => ({
    ...row,
    scheduled: scheduledIds.has(row.id),
    ...resolveCommunitySongLikeState(
      {
        requesterId: row.isOwn ? user.id : 0,
        semester: row.semester,
        played: row.played,
        scheduled: scheduledIds.has(row.id),
        likedByMe: row.likedByMe,
        blacklisted: false
      },
      user.id,
      activeSemester
    )
  }))

  return { success: true, songs: songsWithLikeState, activeSemester }
})
