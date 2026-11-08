import { createError, defineEventHandler, readBody } from 'h3'
import { getSystemSettingsCached } from '~~/server/utils/system-settings-helper'
import { checkSongBlacklist } from '~~/server/utils/songBlacklistMatch'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const { title, artist, musicPlatform, musicId } = body

  if (!title) {
    throw createError({
      statusCode: 400,
      message: '歌曲标题不能为空'
    })
  }

  // 管理员不受黑名单限制
  const user = event.context.user
  if (user && ['SUPER_ADMIN', 'ADMIN', 'SONG_ADMIN'].includes(user.role)) {
    return {
      isBlocked: false,
      reasons: [],
      song: {
        title,
        artist
      }
    }
  }

  const systemSettingsData = await getSystemSettingsCached()
  const showBlacklistKeywords = systemSettingsData?.showBlacklistKeywords ?? false

  // 判定统一走 songBlacklistMatch：黑名单项始终读后台配置，不会出现两份规则走偏
  const result = await checkSongBlacklist({
    title,
    artist,
    musicPlatform,
    musicId,
    hideKeywordValue: !showBlacklistKeywords
  })

  return {
    isBlocked: result.isBlocked,
    reasons: result.reasons,
    song: {
      title,
      artist
    }
  }
})
