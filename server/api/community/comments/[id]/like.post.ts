import { getRouterParam, readBody } from 'h3'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '~/drizzle/db'
import { communityCommentLikes, communityComments, notifications } from '~/drizzle/schema'
import { createApiError } from '~~/server/utils/apiError'
import { requireCommunityUser } from '~~/server/utils/community'

/**
 * 评论点赞（含子评论）：POST /api/community/comments/:id/like
 * 再点一次取消。与帖子点赞相互独立。
 */
export default defineEventHandler(async (event) => {
  const user = requireCommunityUser(event)

  const commentId = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(commentId) || commentId <= 0) {
    throw createApiError(400, 'COMMON_INVALID_PARAMS', '评论参数不正确')
  }

  // 点赞时是否让评论作者知道是我（与歌曲/帖子点赞共用署名偏好，默认匿名）
  const body = await readBody(event).catch(() => null)
  const reveal = body?.reveal === true

  const [comment] = await db
    .select({
      id: communityComments.id,
      deletedAt: communityComments.deletedAt,
      authorId: communityComments.authorId
    })
    .from(communityComments)
    .where(eq(communityComments.id, commentId))
    .limit(1)
  if (!comment || comment.deletedAt) {
    throw createApiError(404, 'COMMUNITY_COMMENT_NOT_FOUND', '评论不存在')
  }

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ commentId: communityCommentLikes.commentId })
      .from(communityCommentLikes)
      .where(
        and(eq(communityCommentLikes.commentId, commentId), eq(communityCommentLikes.userId, user.id))
      )
      .limit(1)

    if (existing) {
      await tx
        .delete(communityCommentLikes)
        .where(
          and(eq(communityCommentLikes.commentId, commentId), eq(communityCommentLikes.userId, user.id))
        )
      const [updated] = await tx
        .update(communityComments)
        .set({ likeCount: sql`greatest(${communityComments.likeCount} - 1, 0)` })
        .where(eq(communityComments.id, commentId))
        .returning({ likeCount: communityComments.likeCount })
      return { liked: false, likeCount: Number(updated?.likeCount || 0) }
    }

    await tx.insert(communityCommentLikes).values({ commentId, userId: user.id, revealToAuthor: reveal })
    const [updated] = await tx
      .update(communityComments)
      .set({ likeCount: sql`${communityComments.likeCount} + 1` })
      .where(eq(communityComments.id, commentId))
      .returning({ likeCount: communityComments.likeCount })
    // 点赞通知：署名时显示真实姓名，匿名时显示「一位同学」；自己给自己点赞不通知
    if (comment.authorId !== user.id) {
      await tx.insert(notifications).values({
        userId: comment.authorId,
        type: 'COMMUNITY_COMMENT_LIKE',
        source: 'COMMUNITY',
        title: '回声社区有新点赞',
        message: `${reveal ? user.name || '一位同学' : '一位同学'} 点赞了你的评论`
      })
    }
    return { liked: true, likeCount: Number(updated?.likeCount || 0) }
  })

  return { success: true, ...result }
})
