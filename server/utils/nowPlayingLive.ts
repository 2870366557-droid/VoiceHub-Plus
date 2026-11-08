/**
 * 播放端实时状态缓存。
 *
 * /api/music/state 由客户端在播放/切歌时上报，服务端此前只做 SSE 广播、不保留状态；
 * 这里在内存中记录最后一条上报，供 /api/community/now-playing 读取「正在播放」。
 *
 * 数据源优先级（按上报者角色区分，2026-11-07 调整）：
 *   1. 放歌员（BROADCASTER）账号的上报 —— 社区「正在播放」以其为准；
 *   2. 匿名播控端的上报 —— 兼容现有鸿蒙播控端等无登录态设备，避免功能倒退；
 *   3. 其他已登录用户的播放上报 —— 不写入社区状态，避免任何人听歌都改动「正在播放」。
 *
 * 限制：内存状态仅当前实例有效，进程重启或多实例部署时不共享；
 * 上报超过 5 分钟未更新视为过期（播放端每 2 秒上报一次状态）。
 */
import { getServerTimestamp } from './serverTime'

/** 社区「正在播放」只认这个角色的上报 */
export const BROADCASTER_ROLE = 'BROADCASTER'

export type LiveNowPlaying = {
  songId: number
  isPlaying: boolean
  position: number
  duration: number
  updatedAt: number
  /** 上报者角色；null 表示匿名播控端 */
  role: string | null
  /** 上报者用户 ID；null 表示匿名 */
  userId: number | null
  /** 来源标记，供接口回传前端 */
  source: 'broadcaster' | 'console'
}

export type StateReporter = {
  userId?: number | null
  role?: string | null
}

const LIVE_TTL_MS = 5 * 60 * 1000

/** 放歌员账号的上报 */
let broadcasterState: LiveNowPlaying | null = null
/** 匿名播控端的上报 */
let consoleState: LiveNowPlaying | null = null

/** 判断该上报者是否写入社区状态，返回目标槽位 */
function resolveSlot(reporter?: StateReporter): 'broadcaster' | 'console' | null {
  const role = String(reporter?.role || '').trim()
  if (role) {
    // 已登录用户：只有放歌员角色才作为社区「正在播放」的数据源
    return role === BROADCASTER_ROLE ? 'broadcaster' : null
  }
  // 无登录态：视为播控端，保留为兜底
  return 'console'
}

function writeSlot(slot: 'broadcaster' | 'console', state: LiveNowPlaying) {
  if (slot === 'broadcaster') broadcasterState = state
  else consoleState = state
}

function readSlot(slot: 'broadcaster' | 'console'): LiveNowPlaying | null {
  const state = slot === 'broadcaster' ? broadcasterState : consoleState
  if (!state) return null
  if (getServerTimestamp() - state.updatedAt > LIVE_TTL_MS) return null
  return state
}

function baseOf(reporter?: StateReporter) {
  const userId = Number(reporter?.userId)
  return {
    role: reporter?.role ? String(reporter.role) : null,
    userId: Number.isInteger(userId) && userId > 0 ? userId : null
  }
}

/** 状态上报：没有歌曲 ID 时保留已知歌曲，只更新进度与播放态 */
export function recordMusicStateUpdate(
  input: {
    songId?: number | null
    isPlaying: boolean
    position?: number
    duration?: number
  } & StateReporter
) {
  const slot = resolveSlot(input)
  if (!slot) return

  const now = getServerTimestamp()
  const songId = Number(input.songId)
  const position = Math.max(0, Number(input.position) || 0)
  const duration = Math.max(0, Number(input.duration) || 0)
  const base = baseOf(input)
  const previous = slot === 'broadcaster' ? broadcasterState : consoleState

  if (Number.isInteger(songId) && songId > 0) {
    writeSlot(slot, {
      songId,
      isPlaying: !!input.isPlaying,
      position,
      duration: duration || (previous?.songId === songId ? previous.duration : 0),
      updatedAt: now,
      ...base,
      source: slot
    })
    return
  }

  if (previous) {
    writeSlot(slot, {
      ...previous,
      isPlaying: !!input.isPlaying,
      position,
      duration: duration || previous.duration,
      updatedAt: now
    })
  }
}

/** 切歌上报：以数据库校验后的歌曲元数据为准，位置归零 */
export function recordMusicSongChange(
  input: { songId?: number | null; duration?: number } & StateReporter
) {
  const slot = resolveSlot(input)
  if (!slot) return
  const songId = Number(input.songId)
  if (!Number.isInteger(songId) || songId <= 0) return

  writeSlot(slot, {
    songId,
    isPlaying: true,
    position: 0,
    duration: Math.max(0, Number(input.duration) || 0),
    updatedAt: getServerTimestamp(),
    ...baseOf(input),
    source: slot
  })
}

/** 读取社区「正在播放」：放歌员优先，匿名播控端兜底；过期或从未上报返回 null */
export function getLiveNowPlaying(): LiveNowPlaying | null {
  return readSlot('broadcaster') || readSlot('console')
}
