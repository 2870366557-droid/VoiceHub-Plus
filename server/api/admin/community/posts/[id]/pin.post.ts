import { getRouterParam } from 'h3'
import { readBody } from 'h3'
import { eq } from 'drizzle-orm'
import { db } from '~/drizzle/db'
import { communityPosts, users } from '~/drizzle/schema'
import { requireCommunityAdmin } from '~~/server/utils/community'
import { createApiError } from '~~/server/utils/apiError'
import { writeAdminAudit } from '~~/server/utils/adminAudit'

/** 管理员置顶/取消置顶帖子：POST /api/admin/community/posts/:id/pin，body { pinned: boolean } */
export default defineEventHandler(async (event) => {
  requireCommunityAdmin(event)

  const postId = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(postId) || postId <= 0) {
    throw createApiError(400, 'COMMUNITY_POST_INVALID', '帖子参数不正确')
  }
  const body = await readBody(event)
  const pinned = Boolean(body?.pinned)

  const [updated] = await db
    .update(communityPosts)
    .set({ pinned, updatedAt: new Date() })
    .where(eq(communityPosts.id, postId))
    .returning({ id: communityPosts.id, pinned: communityPosts.pinned })

  if (!updated) throw createApiError(404, 'COMMUNITY_POST_NOT_FOUND', '帖子不存在')

  // 审计带上作者与内容摘要，避免日志里只有 #id
  const [meta] = await db
    .select({
      content: communityPosts.content,
      authorName: users.name,
      authorUsername: users.username
    })
    .from(communityPosts)
    .innerJoin(users, eq(users.id, communityPosts.authorId))
    .where(eq(communityPosts.id, postId))
    .limit(1)
  const authorLabel = meta?.authorName || meta?.authorUsername || ''
  const contentSnippet = meta?.content ? meta.content.replace(/\s+/g, ' ').slice(0, 20) : ''

  await writeAdminAudit(event, {
    action: pinned ? 'COMMUNITY_POST_PIN' : 'COMMUNITY_POST_UNPIN',
    target: `帖子 #${postId}${authorLabel ? `（作者 ${authorLabel}）` : ''}${
      contentSnippet ? `「${contentSnippet}」` : ''
    }`,
    detail: `结果：${pinned ? '置顶' : '取消置顶'}`
  })

  return { success: true, pinned: updated.pinned }
})
