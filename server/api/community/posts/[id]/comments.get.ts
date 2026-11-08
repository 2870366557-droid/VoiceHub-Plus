import { getQuery, getRouterParam } from 'h3'
import { and, asc, count, eq, isNull, notInArray, or, sql } from 'drizzle-orm'
import { db } from '~/drizzle/db'
import {
  communityComments,
  communityPosts,
  communityProfiles,
  communityTitles,
  users
} from '~/drizzle/schema'
import {
  buildCommunityIdentity,
  getReviewableBoardIds,
  isCommunityAdmin,
  isCommunityReviewer,
  requireCommunityUser
} from '~~/server/utils/community'
import { getBlockedUserIds } from '~~/server/utils/communityRelations'
import {
  COMMUNITY_MENTION_LIMIT,
  extractCommunityMentionTokens,
  resolveCommunityMentionUsers
} from '~~/server/utils/communityCommentMentions'
import { createApiError } from '~~/server/utils/apiError'

/** 单条评论在接口中的序列化形态（向后兼容原有字段，新增楼中楼与 @ 相关字段） */
interface CommunityCommentPayload {
  id: number
  createdAt: Date
  content: string
  status: string
  reviewNote: string | null
  parentId: number | null
  replyTo: string | null
  likeCount: number
  likedByMe: boolean
  mentionNames: string[]
  author: {
    id: number
    className: string
    maskedName: string
    title: string | null
    displayName: string
  }
}

/** 楼中楼：顶层评论 + 其下所有回复（库表只支持一层 parentId，读取时归一化到根） */
interface CommunityCommentThread extends CommunityCommentPayload {
  replies: CommunityCommentThread[]
}

export default defineEventHandler(async (event) => {
  const user = requireCommunityUser(event)
  const postId = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(postId) || postId <= 0) {
    throw createApiError(400, 'COMMUNITY_POST_INVALID', '帖子参数不正确')
  }

  const postRow = await db
    .select({
      id: communityPosts.id,
      boardId: communityPosts.boardId,
      status: communityPosts.status,
      authorId: communityPosts.authorId,
      deletedAt: communityPosts.deletedAt
    })
    .from(communityPosts)
    .where(eq(communityPosts.id, postId))
    .limit(1)
  const post = postRow[0]
  if (!post || post.deletedAt) throw createApiError(404, 'COMMUNITY_POST_NOT_FOUND', '帖子不存在')

  const scopedBoardIds = await getReviewableBoardIds(user)
  const canReviewBoard = !scopedBoardIds || scopedBoardIds.includes(post.boardId)
  const reviewerForBoard = canReviewBoard && isCommunityReviewer(user)
  const privileged = reviewerForBoard || post.authorId === user.id
  if (post.status !== 'APPROVED' && !privileged) {
    throw createApiError(403, 'COMMUNITY_POST_NOT_PUBLIC', '帖子尚未公开')
  }

  // 审核状态可见性保持原逻辑：审帖员可见该帖全部评论，普通用户只看已通过 + 自己的评论
  const visibility = reviewerForBoard
    ? isNull(communityComments.deletedAt)
    : and(
        isNull(communityComments.deletedAt),
        or(eq(communityComments.status, 'APPROVED'), eq(communityComments.authorId, user.id))
      )

  // 拉黑关系 + 影子封禁过滤（作者本人与管理员/审帖员不受影响）
  const extraConditions: any[] = []
  const blockedIds = await getBlockedUserIds(user.id)
  if (blockedIds.length) extraConditions.push(notInArray(communityComments.authorId, blockedIds))
  if (!isCommunityAdmin(user)) {
    extraConditions.push(
      or(
        eq(communityComments.authorId, user.id),
        sql`not exists (select 1 from "CommunityProfile" cp where cp."userId" = ${communityComments.authorId} and cp."shadowBanned" = true)`
      )!
    )
  }

  const rows = await db
    .select({
      id: communityComments.id,
      createdAt: communityComments.createdAt,
      content: communityComments.content,
      status: communityComments.status,
      reviewNote: communityComments.reviewNote,
      parentId: communityComments.parentId,
      authorId: communityComments.authorId,
      likeCount: communityComments.likeCount,
      likedByMe: sql<boolean>`exists(select 1 from "CommunityCommentLike" ccl where ccl."commentId" = ${communityComments.id} and ccl."userId" = ${user.id})`,
      authorName: users.name,
      authorGrade: users.grade,
      authorClass: users.class,
      titleName: communityTitles.name
    })
    .from(communityComments)
    .innerJoin(users, eq(users.id, communityComments.authorId))
    .leftJoin(communityProfiles, eq(communityProfiles.userId, communityComments.authorId))
    .leftJoin(communityTitles, eq(communityTitles.id, communityProfiles.equippedTitleId))
    .where(and(eq(communityComments.postId, postId), visibility, ...extraConditions))
    .orderBy(asc(communityComments.id))
    .limit(200)

  // 一次性解析整页正文里的 @ token，避免逐条评论重复查 users 表
  const mentionTokens: string[] = []
  for (const row of rows) {
    mentionTokens.push(...extractCommunityMentionTokens(row.content))
  }
  const mentionUserByToken = await resolveCommunityMentionUsers(mentionTokens, user)

  const rowById = new Map(rows.map((row) => [row.id, row]))
  const identityOf = (row: (typeof rows)[number]) =>
    buildCommunityIdentity(
      { id: row.authorId, name: row.authorName, grade: row.authorGrade, class: row.authorClass },
      row.titleName,
      user
    )

  const comments: CommunityCommentPayload[] = rows.map((row) => {
    // 父评论可能因审核状态对当前用户不可见，此时 replyTo 留空但保留 parentId
    const parent = row.parentId ? rowById.get(row.parentId) : undefined
    const mentioned: string[] = []
    const seenMentionUserIds = new Set<number>()
    for (const token of extractCommunityMentionTokens(row.content)) {
      const mentionedUser = mentionUserByToken.get(token)
      if (!mentionedUser || seenMentionUserIds.has(mentionedUser.id)) continue
      seenMentionUserIds.add(mentionedUser.id)
      mentioned.push(mentionedUser.displayName)
      if (mentioned.length >= COMMUNITY_MENTION_LIMIT) break
    }

    // 正文里的 @提及按查看者权限重写：非管理员看「@陈*翰」，管理员/本人看「@陈奕翰」。
    // 先替换更长的 token，避免「@陈」抢先把「@陈奕翰」替换坏。
    let displayContent = row.content
    const resolvableTokens = extractCommunityMentionTokens(row.content)
      .filter((token) => mentionUserByToken.has(token))
      .sort((a, b) => b.length - a.length)
    for (const token of resolvableTokens) {
      const mentionedUser = mentionUserByToken.get(token)
      if (!mentionedUser?.displayName) continue
      displayContent = displayContent.split(`@${token}`).join(`@${mentionedUser.displayName}`)
    }

    return {
      id: row.id,
      createdAt: row.createdAt,
      content: displayContent,
      status: row.status,
      likeCount: Number(row.likeCount || 0),
      likedByMe: !!row.likedByMe,
      reviewNote: row.reviewNote,
      parentId: row.parentId ?? null,
      replyTo: parent ? identityOf(parent).displayName : null,
      mentionNames: mentioned,
      author: {
        id: row.authorId,
        ...identityOf(row)
      }
    }
  })

  // 组装评论树：支持任意深度嵌套，父评论不可见（被删除/未过审）的回复提升为顶层
  const nodeById = new Map<number, CommunityCommentThread>()
  for (const comment of comments) {
    nodeById.set(comment.id, { ...comment, replies: [] })
  }

  const roots: CommunityCommentThread[] = []
  for (const comment of comments) {
    const node = nodeById.get(comment.id)
    if (!node) continue
    // 父评论在当前可见集合里就挂到它下面；父评论不可见则提升为顶层
    const parent = comment.parentId != null ? nodeById.get(comment.parentId) : undefined
    if (parent && parent !== node) {
      // 脏数据兜底：父链成环时不挂载，直接提升为顶层
      let cyclic = false
      let cursor: CommunityCommentThread | undefined = parent
      for (let guard = 0; cursor && guard < 50; guard += 1) {
        if (cursor === node) {
          cyclic = true
          break
        }
        cursor = cursor.parentId != null ? nodeById.get(cursor.parentId) : undefined
      }
      if (cyclic) roots.push(node)
      else parent.replies.push(node)
    } else {
      roots.push(node)
    }
  }
  let threads = roots

  const byCreatedAtAsc = (a: { createdAt: Date; id: number }, b: { createdAt: Date; id: number }) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id - b.id
  // 子评论点赞高的排前面（同赞数按时间正序）；顶层评论保持时间正序
  const byLikeDesc = (
    a: { likeCount: number; createdAt: Date; id: number },
    b: { likeCount: number; createdAt: Date; id: number }
  ) => Number(b.likeCount || 0) - Number(a.likeCount || 0) || byCreatedAtAsc(a, b)
  const sortReplies = (list: CommunityCommentThread[]): void => {
    list.sort(byLikeDesc)
    for (const item of list) sortReplies(item.replies)
  }
  sortReplies(threads)

  // 评论总数只统计已通过审核且未删除的评论（与帖子列表 commentCount 口径一致）
  const totalCountRows = await db
    .select({ count: count() })
    .from(communityComments)
    .where(
      and(
        eq(communityComments.postId, postId),
        isNull(communityComments.deletedAt),
        eq(communityComments.status, 'APPROVED'),
        ...extraConditions
      )
    )
  const total = Number(totalCountRows[0]?.count || 0)

  // 按顶层评论分页：只切顶层，每个顶层连同其全部回复一起返回，保证楼中楼不被拆散。
  // 未传 limit 时保持原行为（一次返回全部），向后兼容已有调用方。
  const query = getQuery(event)
  const rawLimit = Number(query.limit)
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 0
  const beforeId = Number(query.beforeId) || 0

  let pageThreads = threads
  let nextCursor: number | null = null
  let hasMore = false
  if (limit > 0) {
    // 顶层按时间正序（点赞排序只作用于回复），用 id 作游标稳定翻页
    const orderedRoots = [...threads].sort(byCreatedAtAsc)
    const startIndex = beforeId ? orderedRoots.findIndex((item) => item.id > beforeId) : 0
    const from = startIndex < 0 ? orderedRoots.length : startIndex
    const slice = orderedRoots.slice(from, from + limit + 1)
    hasMore = slice.length > limit
    pageThreads = hasMore ? slice.slice(0, limit) : slice
    // 保持前端期望的展示顺序（顶层按 id 升序、回复按赞降序）
    pageThreads = [...pageThreads].sort(byCreatedAtAsc)
    nextCursor = hasMore && pageThreads.length ? pageThreads[pageThreads.length - 1].id : null
  }

  // 扁平 comments 同步按本页包含的评论裁剪，避免前端渲染到页外数据
  let pageComments = comments
  if (limit > 0) {
    const visibleIds = new Set<number>()
    const collect = (list: CommunityCommentThread[]) => {
      for (const item of list) {
        visibleIds.add(item.id)
        collect(item.replies)
      }
    }
    collect(pageThreads)
    pageComments = comments.filter((item) => visibleIds.has(item.id))
  }

  return {
    success: true,
    // 向后兼容：保留原有扁平 comments 数组与字段，新增 parentId/replyTo/mentionNames
    comments: pageComments,
    // 楼中楼结构由服务端组装好，前端可直接渲染，无需自己拼树
    threads: pageThreads,
    total,
    hasMore,
    nextCursor
  }
})
