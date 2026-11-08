/**
 * 回声社区审核积压提醒：每小时检查一次待审帖子/评论/用户数量，
 * 超过阈值时给有审核权限的人发邮件（发送与节流逻辑见 communityReviewBacklog.ts）。
 * 骨架与 community-archive-purge.ts 一致：单飞锁 + setInterval + unref + 延迟首跑。
 */
import { notifyReviewBacklog } from '~~/server/utils/communityReviewBacklog'

const ONE_HOUR = 60 * 60 * 1000

export default defineNitroPlugin(() => {
  let running = false

  const run = async () => {
    if (running) return
    running = true
    try {
      const sent = await notifyReviewBacklog()
      if (sent) {
        console.info('[community] 审核积压提醒邮件已发送')
      }
    } catch (error: any) {
      console.error('[community] 审核积压提醒检查失败:', error)
    } finally {
      running = false
    }
  }

  const timer = setInterval(run, ONE_HOUR)
  timer.unref?.()

  // 启动 2 分钟后先跑一次，避开冷启动高峰
  const firstRun = setTimeout(run, 2 * 60 * 1000)
  firstRun.unref?.()
})
