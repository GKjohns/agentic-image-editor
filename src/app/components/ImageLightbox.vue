<script setup lang="ts">
import type { Operation } from '#shared/types'

/** A frame the lightbox can show — built from the original, a batch, or final. */
export interface LightboxFrame {
  imageUrl: string
  label: string
  goal?: string | null
  operations?: Operation[]
}

const open = defineModel<boolean>('open', { required: true })

const props = defineProps<{
  /** All frames, in order, for prev/next paging. */
  frames: LightboxFrame[]
  /** Index (into `frames`) of the currently shown frame. */
  index: number
}>()

const emit = defineEmits<{
  'update:index': [value: number]
}>()

const current = computed<LightboxFrame | null>(() => props.frames[props.index] ?? null)

const hasPrev = computed(() => props.index > 0)
const hasNext = computed(() => props.index < props.frames.length - 1)

function prev() {
  if (hasPrev.value) emit('update:index', props.index - 1)
}
function next() {
  if (hasNext.value) emit('update:index', props.index + 1)
}

/** Compact "tool · key val" chips for the caption (mirrors TimelineStep). */
const opChips = computed<string[]>(() => {
  const ops = current.value?.operations
  if (!ops?.length) return []
  return ops.map((op) => {
    const parts = Object.entries(op.params).map(([k, v]) => {
      if (op.tool === 'look' && k === 'name') return String(v)
      return `${k} ${typeof v === 'number' ? Math.round(v * 100) / 100 : v}`
    })
    return parts.length ? `${op.tool} · ${parts.join(' · ')}` : op.tool
  })
})

// Arrow-key paging while open. UModal already handles Esc to close.
function onKey(e: KeyboardEvent) {
  if (!open.value) return
  if (e.key === 'ArrowLeft') prev()
  else if (e.key === 'ArrowRight') next()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <UModal
    v-model:open="open"
    :title="current?.label ?? 'Frame'"
    :ui="{ content: 'max-w-4xl' }"
  >
    <template #content>
      <div class="flex flex-col">
        <!-- Header: label + download + close -->
        <div class="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-default">
          <div class="min-w-0">
            <p class="text-sm font-semibold text-highlighted truncate">
              {{ current?.label }}
            </p>
            <p
              v-if="current?.goal"
              class="text-xs text-muted truncate"
            >
              {{ current.goal }}
            </p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <UButton
              v-if="current"
              icon="i-lucide-download"
              label="Download"
              color="primary"
              variant="subtle"
              size="sm"
              :to="current.imageUrl"
              download="frame.jpg"
            />
            <UButton
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              size="sm"
              aria-label="Close"
              @click="open = false"
            />
          </div>
        </div>

        <!-- Image + prev/next overlay -->
        <div class="relative bg-elevated">
          <img
            v-if="current"
            :src="current.imageUrl"
            :alt="current.label"
            class="w-full max-h-[70vh] object-contain"
          >
          <UButton
            v-if="hasPrev"
            icon="i-lucide-chevron-left"
            color="neutral"
            variant="solid"
            size="lg"
            class="absolute top-1/2 left-3 -translate-y-1/2 rounded-full opacity-80 hover:opacity-100"
            aria-label="Previous frame"
            @click="prev"
          />
          <UButton
            v-if="hasNext"
            icon="i-lucide-chevron-right"
            color="neutral"
            variant="solid"
            size="lg"
            class="absolute top-1/2 right-3 -translate-y-1/2 rounded-full opacity-80 hover:opacity-100"
            aria-label="Next frame"
            @click="next"
          />
        </div>

        <!-- Caption: op chips + position -->
        <div class="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-t border-default">
          <div
            v-if="opChips.length"
            class="flex flex-wrap gap-1.5 min-w-0"
          >
            <UBadge
              v-for="(chip, i) in opChips"
              :key="i"
              color="neutral"
              variant="outline"
              size="sm"
              class="font-mono"
            >
              {{ chip }}
            </UBadge>
          </div>
          <span v-else />
          <span class="text-xs text-dimmed shrink-0">
            {{ index + 1 }} / {{ frames.length }}
          </span>
        </div>
      </div>
    </template>
  </UModal>
</template>
