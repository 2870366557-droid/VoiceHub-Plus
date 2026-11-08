<script setup lang="ts">
import { computed } from 'vue'
import { Flag, Heart, Trash2 } from '@lucide/vue'
import { useLocale } from '~/utils/locale'

type AnyRecord = Record<string, any>

const props = withDefaults(
  defineProps<{
    comment: AnyRecord
    /** 当前层级，用于缩进；顶层为 0 */
    depth?: number
    /** 当前登录用户 id，用于判断「自己的评论」 */
    myUserId?: number
    /** 是否有内容管理权限（管理员/审帖员） */
    canReview?: boolean
    /** 是否允许回复（帖子已通过审核且未被禁言） */
    canReply?: boolean
  }>(),
  { depth: 0, myUserId: 0, canReview: false, canReply: false }
)

const emit = defineEmits<{
  (e: 'reply', comment: AnyRecord): void
  (e: 'remove', comment: AnyRecord): void
  (e: 'report', comment: AnyRecord): void
  (e: 'like', comment: AnyRecord): void
  (e: 'profile', userId: number): void
}>()

const { songs } = useLocale()
const t = computed<AnyRecord>(() => (songs.value?.community as AnyRecord) || {})

// 缩进到 6 层后不再继续加深，避免深层评论在手机上被挤出屏幕
const MAX_INDENT_DEPTH = 6
const indentRem = computed(() => (props.depth >= MAX_INDENT_DEPTH ? 0 : 0.75))

const isOwn = computed(
  () => Number(props.comment?.author?.id) === props.myUserId && props.myUserId > 0
)
// 服务端给出的直接父评论作者展示名（被回复对象）
const replyToName = computed(() => String(props.comment?.replyTo || ''))
const canRemove = computed(() => isOwn.value || props.canReview)

function statusText(value: string) {
  const map: Record<string, string> = {
    PENDING: t.value.statusPending,
    APPROVED: t.value.statusApproved,
    REJECTED: t.value.statusRejected,
    BLOCKED: t.value.statusBlocked
  }
  return map[value] || value
}

function formatTime(value: string | Date | null | undefined) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const diff = Date.now() - date.getTime()
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return t.value.justNow || '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)}${t.value.minutesAgo || '分钟前'}`
  if (diff < day) return `${Math.floor(diff / hour)}${t.value.hoursAgo || '小时前'}`
  if (diff < 30 * day) return `${Math.floor(diff / day)}${t.value.daysAgo || '天前'}`
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
</script>

<template>
  <div class="comment-item" :class="{ 'comment-reply-item': depth > 0 }">
    <div class="comment-head">
      <button class="identity comment-identity" type="button" @click="emit('profile', comment.author?.id)">
        <span class="identity-name">{{ comment.author?.displayName }}</span>
        <span v-if="comment.author?.title" class="identity-title">{{ comment.author.title }}</span>
      </button>
      <div class="comment-tail">
        <span
          v-if="comment.status !== 'APPROVED'"
          :class="['status-pill', `status-${String(comment.status || '').toLowerCase()}`]"
        >
          {{ statusText(comment.status) }}
        </span>
        <span v-if="replyToName" class="reply-target">回复 {{ replyToName }}</span>
        <button
          class="comment-like"
          :class="{ liked: comment.likedByMe }"
          :title="comment.likedByMe ? t.unlike || '取消点赞' : t.like || '点赞'"
          type="button"
          @click="emit('like', comment)"
        >
          <Heart :fill="comment.likedByMe ? 'currentColor' : 'none'" :size="13" />
          <span v-if="Number(comment.likeCount) > 0">{{ comment.likeCount }}</span>
        </button>
        <button
          v-if="canReply"
          class="comment-reply-btn"
          type="button"
          @click="emit('reply', comment)"
        >
          {{ t.reply || '回复' }}
        </button>
        <button
          v-if="!isOwn"
          class="comment-remove"
          :title="t.report || '举报'"
          type="button"
          @click="emit('report', comment)"
        >
          <Flag :size="13" />
        </button>
        <button
          v-if="canRemove"
          class="comment-remove"
          :title="isOwn ? t.withdraw : t.deleteContent"
          type="button"
          @click="emit('remove', comment)"
        >
          <Trash2 :size="13" />
        </button>
      </div>
    </div>
    <p>
      <span v-for="name in comment.mentionNames || []" :key="name" class="mention-name">@{{ name }} </span>
      {{ comment.content }}
    </p>
    <p v-if="comment.reviewNote" class="comment-note">
      {{ t.reviewNoteLabel }}：{{ comment.reviewNote }}
    </p>
    <span class="comment-time">{{ formatTime(comment.createdAt) }}</span>

    <div
      v-if="comment.replies && comment.replies.length"
      class="comment-replies"
      :style="{ paddingLeft: `${indentRem}rem` }"
    >
      <CommunityCommentItem
        v-for="reply in comment.replies"
        :key="reply.id"
        :comment="reply"
        :depth="depth + 1"
        :my-user-id="myUserId"
        :can-review="canReview"
        :can-reply="canReply"
        @reply="emit('reply', $event)"
        @remove="emit('remove', $event)"
        @report="emit('report', $event)"
        @profile="emit('profile', $event)"
      />
    </div>
  </div>
</template>



<style scoped>
.identity {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.25rem;
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  text-align: left;
}

.identity-name {
  font-size: 0.82rem;
  font-weight: 800;
  color: var(--text-primary);
  transition: color 0.2s ease;
}

.identity:hover .identity-name {
  color: var(--color-accent);
}

.identity-meta {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.identity-title {
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: var(--color-accent-alpha-12);
  color: var(--color-accent);
  font-size: 0.6rem;
  font-weight: 800;
}

.identity-board {
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: var(--overlay-6);
  color: var(--text-tertiary);
  font-size: 0.6rem;
  font-weight: 700;
}

.status-pill {
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  font-size: 0.6rem;
  font-weight: 800;
  border: 1px solid transparent;
}

.status-pending {
  background: var(--warning-light);
  border-color: var(--warning-border);
  color: var(--warning);
}

.status-approved {
  background: var(--success-light);
  border-color: var(--success-border);
  color: var(--success);
}

.status-rejected, .status-blocked {
  background: var(--error-light);
  border-color: var(--error-border);
  color: var(--error);
}

.me-identity, .profile-identity {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.detail-identity {
  align-self: stretch;
}

.comment-replies {
  margin-top: 0.6rem;
  padding-left: 0.75rem;
  border-left: 2px solid var(--overlay-8);
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.comment-reply-item {
  background: var(--overlay-4);
  border-radius: 0.6rem;
  padding: 0.5rem 0.6rem;
}

.comment-reply-btn {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 0.68rem;
  font-weight: 700;
  cursor: pointer;
}

.comment-reply-btn:hover {
  color: var(--color-accent);
}

.reply-target {
  font-size: 0.62rem;
  color: var(--text-disabled);
}

.mention-name {
  color: var(--color-accent);
  font-weight: 700;
}

.comment-item {
  padding: 0.6rem 0.7rem;
  border-radius: 0.75rem;
  background: var(--overlay-3);
}

.comment-item p {
  margin-top: 0.35rem;
  font-size: 0.76rem;
  line-height: 1.6;
  color: var(--text-secondary);
  word-break: break-word;
}

.comment-identity {
  flex-direction: row;
  align-items: center;
  gap: 0.4rem;
}

.comment-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.comment-tail {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  flex-shrink: 0;
}

.comment-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 0.45rem;
  border: none;
  background: transparent;
  color: var(--text-quaternary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.comment-remove:hover {
  color: var(--error);
  background: var(--error-light);
}

.comment-note {
  margin-top: 0.3rem;
  font-size: 0.66rem;
  color: var(--warning);
}

.comment-identity .identity-name {
  font-size: 0.7rem;
}

.comment-time {
  display: block;
  margin-top: 0.3rem;
  font-size: 0.6rem;
  color: var(--text-quaternary);
}

.comment-like {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  height: 1.5rem;
  padding: 0 0.35rem;
  border-radius: 0.45rem;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}

.comment-like:hover {
  background: var(--overlay-8);
}

.comment-like.liked {
  color: var(--primary);
}



</style>


