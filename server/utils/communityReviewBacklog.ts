/**
 * 回声社区审核积压提醒：待审帖子/评论/用户超过阈值时给有审核权限的人发邮件。
 * 触发由 server/plugins/community-review-backlog-notify.ts 每小时驱动；
 * 同一收件人 6 小时内只发一次，避免没人处理时每小时轰炸。
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '~/drizzle/db'
import { communityBoardReviewers, communityComments, communityPosts, users } from '~/drizzle/schema'
import { SmtpService } from '~~/server/services/smtpService'

export const REVIEW_BACKLOG_THRESHOLD = 5
const NOTIFY_THROTTLE_MS = 6 * 60 * 60 * 1000

export type ReviewBacklogCounts = {
  posts: number
  comments: number
  users: number
}

export async function getReviewBacklogCounts(): Promise<ReviewBacklogCounts> {
  const [postRows, commentRows, userRows] = await Promise.all([
    // 帖子待审 = status 'PENDING'（大写）且未删除
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(communityPosts)
      .where(and(eq(communityPosts.status, 'PENDING'), isNull(communityPosts.deletedAt))),
    // 评论待审，同时要求母帖未被删除（与审核队列口径一致）
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(communityComments)
      .innerJoin(communityPosts, eq(communityPosts.id, communityComments.postId))
      .where(
        and(
          eq(communityComments.status, 'PENDING'),
          isNull(communityComments.deletedAt),
          isNull(communityPosts.deletedAt)
        )
      ),
    // 用户待审 = status 'pending'（小写枚举，注意与帖子/评论不同）
    db.select({ value: sql<number>`count(*)::int` }).from(users).where(eq(users.status, 'pending'))
  ])

  return {
    posts: Number(postRows[0]?.value || 0),
    comments: Number(commentRows[0]?.value || 0),
    users: Number(userRows[0]?.value || 0)
  }
}

/** 有待审帖子的板块（审帖员只收自己负责板块的提醒） */
export async function getPendingPostBoardIds(): Promise<number[]> {
  const rows = await db
    .selectDistinct({ boardId: communityPosts.boardId })
    .from(communityPosts)
    .where(and(eq(communityPosts.status, 'PENDING'), isNull(communityPosts.deletedAt)))
  return rows.map((row) => row.boardId)
}

// 收件人节流记录（内存态：进程重启后清零，最多多发一封，可接受）
const lastNotifiedAt = new Map<string, number>()

function buildActionUrl(): string | undefined {
  const host = String(process.env.NUXT_PUBLIC_HOST || '').trim()
  if (!host) return undefined
  const base = host.startsWith('http') ? host : `https://${host}`
  return `${base.replace(/\/+$/, '')}/dashboard`
}

/** 检查积压并发送提醒邮件；返回是否真正发出了邮件 */
export async function notifyReviewBacklog(): Promise<boolean> {
  const counts = await getReviewBacklogCounts()
  const contentBacklog = counts.posts + counts.comments
  if (contentBacklog <= REVIEW_BACKLOG_THRESHOLD && counts.users <= REVIEW_BACKLOG_THRESHOLD) {
    return false
  }

  // 收件人：管理员/超管全量；审帖员只收自己负责板块有待审帖子的
  const recipients = new Map<number, string>()
  const adminRows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(
      and(
        inArray(users.role, ['ADMIN', 'SUPER_ADMIN']),
        eq(users.emailVerified, true)
      )
    )
  for (const row of adminRows) {
    if (row.email) recipients.set(row.id, row.email)
  }

  if (counts.posts > 0) {
    const boardIds = await getPendingPostBoardIds()
    if (boardIds.length) {
      const reviewerRows = await db
        .selectDistinct({ userId: communityBoardReviewers.userId })
        .from(communityBoardReviewers)
        .where(inArray(communityBoardReviewers.boardId, boardIds))
      const reviewerUserIds = reviewerRows.map((row) => row.userId)
      if (reviewerUserIds.length) {
        const reviewerUsers = await db
          .select({ id: users.id, email: users.email, role: users.role })
          .from(users)
          .where(and(inArray(users.id, reviewerUserIds), eq(users.emailVerified, true)))
        for (const row of reviewerUsers) {
          if (row.email && row.role === 'REVIEWER') recipients.set(row.id, row.email)
        }
      }
    }
  }

  if (!recipients.size) return false

  const smtp = SmtpService.getInstance()
  const now = Date.now()
  let sent = 0
  for (const [, email] of recipients) {
    const last = lastNotifiedAt.get(email) || 0
    if (now - last < NOTIFY_THROTTLE_MS) continue
    try {
      const ok = await smtp.renderAndSend(email, 'community-review-backlog', {
        title: '回声社区待审核内容积压提醒',
        postCount: counts.posts,
        commentCount: counts.comments,
        userCount: counts.users,
        actionUrl: buildActionUrl()
      })
      if (ok) {
        lastNotifiedAt.set(email, now)
        sent += 1
      }
    } catch (error: any) {
      console.error('[community] 审核积压提醒邮件发送失败:', email, error)
    }
  }
  return sent > 0
}
