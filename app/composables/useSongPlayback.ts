/**
 * 歌曲播放的共用逻辑（投稿列表与回声社区帖子共用）。
 * 投稿列表会传入 buildPlaylist 以继续播放列表里的下一首；
 * 社区没有列表概念，不传时播放列表就是当前这一首。
 */
import { useAudioPlayer } from '~/composables/useAudioPlayer'
import { isBilibiliSong } from '~/utils/bilibiliSource'
import { getMusicUrl as resolveMusicUrl } from '~/utils/musicUrl'

export type PlayableSong = Record<string, any>

export function useSongPlayback(
  options: {
    /** 构建播放列表（投稿列表用它串起整页歌曲；社区不传，只播放单曲） */
    buildPlaylist?: (song: PlayableSong) => Promise<PlayableSong[]> | PlayableSong[]
    /** 取播放地址失败时的提示回调 */
    onUrlError?: (song: PlayableSong) => void
  } = {}
) {
  const audioPlayer = useAudioPlayer()

  /**
   * 取播放链接：与投稿列表同口径（注意 resolveMusicUrl 是位置参数签名，
   * 不是传 song 对象——这里曾因签名用错导致社区所有歌曲取链失败）。
   */
  const getMusicUrlFor = async (song: PlayableSong): Promise<string | null> => {
    const { musicPlatform: platform, musicId, playUrl } = song
    if (playUrl && String(playUrl).trim()) return String(playUrl).trim()
    if (!platform || !musicId) throw new Error('缺少音乐平台或音乐ID信息')
    const isPodcast = platform === 'netease-podcast'
    return resolveMusicUrl(platform, musicId, undefined, {
      unblock: isPodcast ? false : undefined,
      musicInfo: {
        name: song.title,
        artist: song.artist,
        album: song.album || undefined,
        rawItem: song
      }
    })
  }

  const playSongWithUrlFetching = async (song: PlayableSong) => {
    if (!song) return
    let url: string | null = null
    try {
      url = await getMusicUrlFor(song)
    } catch {
      if (!isBilibiliSong(song) && options.onUrlError) options.onUrlError(song)
    }

    const playableSong = { ...song, musicUrl: url || null }
    const playlist = options.buildPlaylist ? await options.buildPlaylist(song) : [playableSong]
    const currentIndex = playlist.findIndex((item) => item.id === song.id)
    audioPlayer.playSong(playableSong, playlist, currentIndex < 0 ? 0 : currentIndex)

    if (!url && !isBilibiliSong(song)) return

    // 后台预取后续歌曲的播放链接（不阻塞当前播放）
    ;(async () => {
      for (let i = (currentIndex < 0 ? 0 : currentIndex) + 1; i < playlist.length; i += 1) {
        const next = playlist[i]
        if (!next?.musicUrl && ((next?.musicPlatform && next?.musicId) || next?.playUrl)) {
          try {
            next.musicUrl = await getMusicUrlFor(next)
          } catch {
            next.musicUrl = null
          }
        }
      }
    })()
  }

  const togglePlaySong = async (song: PlayableSong) => {
    if (!song) return
    // 正在播放当前歌曲 → 暂停
    if (audioPlayer.isCurrentSong(song.id) && audioPlayer.getPlayingStatus().value) {
      audioPlayer.pauseSong()
      return
    }

    // 当前歌曲已暂停 → 有现成地址就恢复，否则重新取地址
    if (audioPlayer.isCurrentSong(song.id) && !audioPlayer.getPlayingStatus().value) {
      const currentGlobalSong = audioPlayer.getCurrentSong().value as PlayableSong | null
      if (currentGlobalSong && (currentGlobalSong.musicUrl || isBilibiliSong(currentGlobalSong))) {
        audioPlayer.playSong(currentGlobalSong)
        return
      }
    }

    // 有音源信息才播放，否则点了没反应
    if ((song.musicPlatform && song.musicId) || song.playUrl) {
      await playSongWithUrlFetching(song)
    }
  }

  return { audioPlayer, togglePlaySong, playSongWithUrlFetching }
}
