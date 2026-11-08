<script setup lang="ts">
import { ref, watch } from 'vue'
import { X } from '@lucide/vue'
import { useNewUi } from '~/composables/useNewUi'

/**
 * 点赞署名选择弹窗：歌曲点赞与帖子点赞共用。
 * confirm 事件回传 (reveal: boolean, remember: boolean)。
 */
const props = defineProps<{ show: boolean }>()

const emit = defineEmits<{
  (e: 'confirm', reveal: boolean, remember: boolean): void
  (e: 'cancel'): void
}>()

const uiT = useNewUi()

const choice = ref<'ANONYMOUS' | 'REVEAL'>('ANONYMOUS')
const remember = ref(false)

// 每次打开都重置为「匿名 + 不记住」，与原有交互一致
watch(
  () => props.show,
  (show) => {
    if (show) {
      choice.value = 'ANONYMOUS'
      remember.value = false
    }
  }
)

function confirm() {
  emit('confirm', choice.value === 'REVEAL', remember.value)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="community-fade">
      <div v-if="show" class="modal-layer" @click.self="emit('cancel')">
        <div class="modal-card" style="max-width: 24rem">
          <header class="modal-head">
            <div>
              <h3>{{ uiT.voteReveal.title }}</h3>
              <p>{{ uiT.voteReveal.desc }}</p>
            </div>
            <button class="icon-button" type="button" @click="emit('cancel')">
              <X :size="18" />
            </button>
          </header>
          <div class="modal-body">
            <button
              class="w-full rounded-xl border px-3 py-2.5 text-left transition-all"
              :class="choice === 'ANONYMOUS' ? 'border-primary bg-primary-10' : 'border-border-secondary hover:bg-bg-tertiary'"
              type="button"
              @click="choice = 'ANONYMOUS'"
            >
              <p class="text-xs font-bold text-text-primary">{{ uiT.voteReveal.anonymous }}</p>
              <p class="mt-0.5 text-[10px] text-text-tertiary">{{ uiT.voteReveal.anonymousHint }}</p>
            </button>
            <button
              class="w-full rounded-xl border px-3 py-2.5 text-left transition-all"
              :class="choice === 'REVEAL' ? 'border-primary bg-primary-10' : 'border-border-secondary hover:bg-bg-tertiary'"
              type="button"
              @click="choice = 'REVEAL'"
            >
              <p class="text-xs font-bold text-text-primary">{{ uiT.voteReveal.reveal }}</p>
              <p class="mt-0.5 text-[10px] text-text-tertiary">{{ uiT.voteReveal.revealHint }}</p>
            </button>
            <label class="flex items-start gap-2 rounded-xl bg-bg-secondary-60 px-3 py-2 text-[11px] text-text-secondary">
              <input v-model="remember" class="mt-0.5 h-3.5 w-3.5 accent-[var(--primary)]" type="checkbox" >
              <span class="min-w-0">
                <span class="block font-bold">{{ uiT.voteReveal.remember }}</span>
                <span class="mt-0.5 block text-text-tertiary">{{ uiT.voteReveal.rememberHint }}</span>
              </span>
            </label>
          </div>
          <footer class="modal-foot">
            <span class="foot-hint">{{ uiT.voteReveal.desc }}</span>
            <div class="foot-actions">
              <button class="ghost-button" type="button" @click="emit('cancel')">
                {{ uiT.voteReveal.cancel }}
              </button>
              <button class="primary-button" type="button" @click="confirm">
                {{ uiT.voteReveal.confirm }}
              </button>
            </div>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>



<style scoped>
.primary-button, .ghost-button, .icon-button, .link-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  border-radius: 0.75rem;
  font-size: 0.78rem;
  font-weight: 800;
  transition: all 0.2s ease;
  cursor: pointer;
}

.primary-button {
  padding: 0.65rem 1.1rem;
  background: var(--color-accent);
  color: #fff;
  box-shadow: 0 8px 20px var(--color-accent-alpha-30);
}

.primary-button:hover:not(:disabled) {
  background: var(--color-accent-hover);
}

.ghost-button {
  padding: 0.6rem 1rem;
  background: var(--overlay-5);
  border: 1px solid var(--overlay-10);
  color: var(--text-secondary);
}

.ghost-button:hover:not(:disabled) {
  background: var(--overlay-10);
  color: var(--text-primary);
}

.primary-button:disabled, .ghost-button:disabled, .like-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.icon-button {
  width: 2.2rem;
  height: 2.2rem;
  background: var(--overlay-5);
  color: var(--text-tertiary);
}

.icon-button:hover {
  background: var(--overlay-10);
  color: var(--text-primary);
}

.modal-layer {
  position: fixed;
  inset: 0;
  z-index: 1800;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  background: var(--bg-primary-80, rgba(0, 0, 0, 0.72));
  backdrop-filter: blur(6px);
}

.modal-card {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-height: min(86vh, 46rem);
  border-radius: 1.35rem;
  background: var(--panel-bg-dialog);
  border: 1px solid var(--overlay-10);
  box-shadow: 0 32px 80px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 1.1rem 1.2rem;
  border-bottom: 1px solid var(--overlay-6);
}

.modal-head h3 {
  font-size: 1rem;
  font-weight: 900;
  color: var(--text-primary);
}

.modal-head p {
  margin-top: 0.2rem;
  font-size: 0.7rem;
  color: var(--text-tertiary);
}

.modal-body {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  padding: 1.1rem 1.2rem;
  overflow-y: auto;
}

.modal-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.9rem 1.2rem;
  border-top: 1px solid var(--overlay-6);
  background: var(--overlay-2);
}

.foot-hint {
  font-size: 0.64rem;
  color: var(--text-quaternary);
}

.foot-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-left: auto;
}

.community-fade-enter-active, .community-fade-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.community-fade-enter-from, .community-fade-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@media (max-width: 768px) {
  .community-shell {
    padding-right: 0;
    gap: 1rem;
  }

  .community-title {
    font-size: 1.3rem;
  }

  .community-head {
    align-items: flex-start;
  }

  .community-head-actions {
    width: 100%;
  }

  .community-head-actions .primary-button {
    flex: 1;
  }

  .community-aside {
    grid-template-columns: minmax(0, 1fr);
  }

  .post-card {
    padding: 0.95rem 1rem;
  }

  .post-images {
    max-width: 100%;
  }

  .modal-layer {
    align-items: flex-end;
    padding: 0;
  }

  .modal-card {
    max-height: 92vh;
    border-radius: 1.35rem 1.35rem 0 0;
    border-bottom: none;
  }

  .publish-card,
  .detail-card,
  .profile-card {
    max-width: 100%;
  }

  .comment-list {
    max-height: 12rem;
  }

  .lightbox {
    padding: 1rem;
  }

  .lightbox-nav {
    width: 2.25rem;
    height: 2.25rem;
  }

  .lightbox-prev {
    left: 0.4rem;
  }

  .lightbox-next {
    right: 0.4rem;
  }
}

@media (max-width: 480px) {
  .modal-foot {
    flex-direction: column;
    align-items: stretch;
  }

  .foot-hint {
    text-align: center;
  }

  .foot-actions {
    margin-left: 0;
  }

  .foot-actions .primary-button {
    flex: 1;
  }

  .comment-foot {
    padding: 0.7rem;
  }

  .comment-send span {
    display: none;
  }
}
</style>
