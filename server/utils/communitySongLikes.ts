/**
 * 社区歌曲点赞：与投稿热度（Vote 表）解耦。
 *
 * 规则（与产品口径一致）：
 * - 任意歌曲都能在社区点赞，只有命中黑名单的歌不让点；
 * - 只有「待排期」歌曲（活跃学期 + 未播放 + 未排期 + 非本人投稿）的赞会同步成一条 Vote，计入点歌热度；
 * - 已经排期的歌、已播放的歌、往期学期的歌、自己投稿的歌：点赞只留在社区，不进 Vote；
 * - 歌曲后来变成待排期时（例如学期切换、撤销排期），由 reconcile 把历史赞补同步进 Vote。
 */
import { and, eq, sql } from 'drizzle-orm'
import { db } from '~/drizzle/db'
import { communitySongLikes, schedules, semesters, songs, votes } from '~/drizzle/schema'
import { getActiveSemesterName, resolveSongVoteBlockCode } from './communitySongVote'

export type SongFacts = {
  id: number
  title: string
  artist: string
  requesterId: number | null
  semester: string | null
  played: boolean
  scheduled: boolean
}

/** 取歌曲的点赞判定所需事实（是否待排期由 published schedule 派生） */
export async function getSongFacts(songId: number): Promise<SongFacts | null> {
  const rows = await db
    .select({
      id: songs.id,
      title: songs.title,
      artist: songs.artist,
      requesterId: songs.requesterId,
      semester: songs.semester,
      played: songs.played,
      scheduled: sql<boolean>`exists(select 1 from "Schedule" s where s."songId" = ${songs.id} and s."isDraft" = false)`
    })
    .from(songs)
    .where(eq(songs.id, songId))
    .limit(1)
  return rows[0] ?? null
}

/** 这首歌当前是否处于「待排期」（即符合投稿点赞资格，点赞会计入热度） */
export async function isSongVoteEligible(
  facts: Pick<SongFacts, 'requesterId' | 'semester' | 'played' | 'scheduled'>,
  userId: number
): Promise<boolean> {
  const activeSemester = await getActiveSemesterName()
  return resolveSongVoteBlockCode(facts, userId, activeSemester) === null
}

/** 社区内该歌曲的点赞数（含不同步进热度的） */
export async function countCommunitySongLikes(songId: number): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(communitySongLikes)
    .where(eq(communitySongLikes.songId, songId))
  return Number(rows[0]?.value || 0)
}

/** 该歌曲在投稿系统里的热度（Vote 表） */
export async function countSongVotes(songId: number): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(votes)
    .where(eq(votes.songId, songId))
  return Number(rows[0]?.value || 0)
}

export type ToggleResult = {
  liked: boolean
  likeCount: number
  voteCount: number
  /** 这次点赞是否已计入投稿热度 */
  synced: boolean
  /** 这首歌当前是否处于待排期（决定点赞会不会同步） */
  eligible: boolean
}

/**
 * 点赞：先落社区点赞，再在「待排期」时同步一条 Vote。
 * 若用户在点歌页已经点过（Vote 已存在），不重复插入，也不把它当作待同步。
 */
export async function likeCommunitySong(
  songId: number,
  userId: number,
  reveal = true
): Promise<ToggleResult> {
  const facts = await getSongFacts(songId)
  if (!facts) throw new Error('歌曲不存在')

  const eligible = await isSongVoteEligible(facts, userId)
  let synced = false

  await db.transaction(async (tx) => {
    await tx
      .insert(communitySongLikes)
      .values({ songId, userId, syncedToVote: false })
      .onConflictDoNothing()

    if (eligible) {
      const existing = await tx
        .select({ id: votes.id })
        .from(votes)
        .where(and(eq(votes.songId, songId), eq(votes.userId, userId)))
        .limit(1)
      if (!existing[0]) {
        await tx.insert(votes).values({ songId, userId, revealToRequester: reveal })
        synced = true
      }
    }
    if (synced) {
      await tx
        .update(communitySongLikes)
        .set({ syncedToVote: true })
        .where(and(eq(communitySongLikes.songId, songId), eq(communitySongLikes.userId, userId)))
    }
  })

  return {
    liked: true,
    likeCount: await countCommunitySongLikes(songId),
    voteCount: await countSongVotes(songId),
    synced,
    eligible
  }
}

/** 取消赞：只删除「当初由社区同步出来的」那条 Vote，不动用户在点歌页自己点的 */
export async function unlikeCommunitySong(songId: number, userId: number): Promise<ToggleResult> {
  const facts = await getSongFacts(songId)
  if (!facts) throw new Error('歌曲不存在')

  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ syncedToVote: communitySongLikes.syncedToVote })
      .from(communitySongLikes)
      .where(and(eq(communitySongLikes.songId, songId), eq(communitySongLikes.userId, userId)))
      .limit(1)

    await tx
      .delete(communitySongLikes)
      .where(and(eq(communitySongLikes.songId, songId), eq(communitySongLikes.userId, userId)))

    if (row?.syncedToVote) {
      await tx
        .delete(votes)
        .where(and(eq(votes.songId, songId), eq(votes.userId, userId)))
    }
  })

  const eligible = await isSongVoteEligible(facts, userId)
  return {
    liked: false,
    likeCount: await countCommunitySongLikes(songId),
    voteCount: await countSongVotes(songId),
    synced: false,
    eligible
  }
}

/**
 * 对账：把「现在处于待排期」的歌曲上、还没同步的历史社区赞补进 Vote。
 * 场景：发帖时这首歌还没被投稿/还没进入待排期，后来进入待排期了，之前的赞要补上。
 */
export async function reconcileSyncedCommunityLikes(limit = 500): Promise<number> {
  const activeSemester = await getActiveSemesterName()
  if (!activeSemester) return 0

  // 只取未同步的社区赞，联表拿到判定所需字段，并排除已存在 Vote 的
  const rows = await db
    .select({
      songId: communitySongLikes.songId,
      userId: communitySongLikes.userId,
      requesterId: songs.requesterId,
      semester: songs.semester,
      played: songs.played,
      scheduled: sql<boolean>`exists(select 1 from "Schedule" s where s."songId" = ${communitySongLikes.songId} and s."isDraft" = false)`,
      voteId: votes.id
    })
    .from(communitySongLikes)
    .innerJoin(songs, eq(songs.id, communitySongLikes.songId))
    .leftJoin(
      votes,
      and(eq(votes.songId, communitySongLikes.songId), eq(votes.userId, communitySongLikes.userId))
    )
    .where(eq(communitySongLikes.syncedToVote, false))
    .limit(limit)

  let synced = 0
  for (const row of rows) {
    if (row.voteId != null) continue
    const blocked = resolveSongVoteBlockCode(
      { requesterId: row.requesterId, semester: row.semester, played: row.played, scheduled: row.scheduled },
      row.userId,
      activeSemester
    )
    if (blocked) continue
    try {
      await db.transaction(async (tx) => {
        await tx.insert(votes).values({ songId: row.songId, userId: row.userId, revealToRequester: false })
        await tx
          .update(communitySongLikes)
          .set({ syncedToVote: true })
          .where(
            and(
              eq(communitySongLikes.songId, row.songId),
              eq(communitySongLikes.userId, row.userId)
            )
          )
      })
      synced += 1
    } catch {
      // 并发下可能已被别人插入，忽略即可，下一轮对账会自然收敛
    }
  }
  return synced
}
