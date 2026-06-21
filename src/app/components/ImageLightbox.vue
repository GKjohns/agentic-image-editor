<script setup lang="ts">
import type { Operation } from '#shared/types'

/** A frame the lightbox can show — built from the original, a step, or final. */
export interface LightboxFrame {
  imageUrl: string
  label: string
  goal?: string | null
  operations?: Operation[]
  /** True for the Original frame (the before/after slider hides here). */
  isOriginal?: boolean
  /** The compare-against-original source for the before/after slider. */
  originalUrl?: string
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

// --- Zoom / pan --------------------------------------------------------------
const {
  transform,
  percent,
  isZoomed,
  isDragging,
  target: viewport,
  imageEl,
  reset: resetZoom,
  zoomIn,
  zoomOut,
  zoomToFit,
  zoomToHundred,
  toggleFitHundred,
  onWheel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onTouchStart,
  onTouchMove,
  onTouchEnd
} = useZoomPan()

// --- Inspection modes --------------------------------------------------------
const showGrid = ref(false)
const compare = ref(false)
// Before/after divider position, 0..1 across the frame (0 = all original).
const comparePos = ref(0.5)

// The current frame can compare only if it has an original source and isn't it.
const canCompare = computed(() => !!current.value?.originalUrl && !current.value?.isOriginal)

function toggleCompare() {
  if (!canCompare.value) return
  compare.value = !compare.value
}
function toggleGrid() {
  showGrid.value = !showGrid.value
}

function prev() {
  if (hasPrev.value) emit('update:index', props.index - 1)
}
function next() {
  if (hasNext.value) emit('update:index', props.index + 1)
}

// Reset zoom (and disable compare if the new frame can't) on frame nav.
watch(() => props.index, () => {
  resetZoom()
  if (!canCompare.value) compare.value = false
})
// Open at fit zoom, clean modes.
watch(open, (v) => {
  if (v) {
    resetZoom()
    compare.value = false
    showGrid.value = false
    comparePos.value = 0.5
  }
})

// --- Before/after divider drag ----------------------------------------------
const compareEl = ref<HTMLElement | null>(null)
let draggingDivider = false

function setComparePosFromEvent(clientX: number) {
  const el = compareEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  comparePos.value = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
}
function onDividerDown(e: PointerEvent) {
  draggingDivider = true
  setComparePosFromEvent(e.clientX)
  // Guard capture — throws if the pointer id isn't active (synthetic events).
  try {
    (e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId)
  } catch { /* ignore */ }
}
function onDividerMove(e: PointerEvent) {
  if (draggingDivider) setComparePosFromEvent(e.clientX)
}
function onDividerUp(e: PointerEvent) {
  draggingDivider = false
  try {
    (e.currentTarget as HTMLElement)?.releasePointerCapture?.(e.pointerId)
  } catch { /* ignore */ }
}

/** Compact "tool · key val" chips for the caption (mirrors the rail's chips). */
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

// Active-mode label for the footer.
const modeLabel = computed(() => {
  const m: string[] = []
  if (compare.value) m.push('Compare')
  if (showGrid.value) m.push('Grid')
  if (isZoomed.value) m.push('Pan')
  return m.length ? m.join(' · ') : 'Fit'
})

// Keyboard map: arrows = prev/next, +/-/0 zoom, c compare, g grid, Esc closes.
function onKey(e: KeyboardEvent) {
  if (!open.value) return
  switch (e.key) {
    case 'ArrowLeft':
      prev()
      break
    case 'ArrowRight':
      next()
      break
    case '+':
    case '=':
      zoomIn()
      break
    case '-':
    case '_':
      zoomOut()
      break
    case '0':
      resetZoom()
      break
    case 'c':
    case 'C':
      toggleCompare()
      break
    case 'g':
    case 'G':
      toggleGrid()
      break
    default:
      return
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <UModal
    v-model:open="open"
    :title="current?.label ?? 'Frame'"
    :ui="{ content: 'max-w-5xl' }"
  >
    <template #content>
      <div class="flex flex-col">
        <!-- Header: label + inspection toggles + download + close -->
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
          <div class="flex items-center gap-1.5 shrink-0">
            <UTooltip text="Before / after compare (c)">
              <UButton
                icon="i-lucide-columns-2"
                color="neutral"
                :variant="compare ? 'solid' : 'ghost'"
                size="sm"
                :disabled="!canCompare"
                aria-label="Toggle compare"
                @click="toggleCompare"
              />
            </UTooltip>
            <UTooltip text="Rule-of-thirds grid (g)">
              <UButton
                icon="i-lucide-grid-3x3"
                color="neutral"
                :variant="showGrid ? 'solid' : 'ghost'"
                size="sm"
                aria-label="Toggle grid"
                @click="toggleGrid"
              />
            </UTooltip>
            <div class="w-px h-5 bg-default mx-0.5" />
            <UButton
              v-if="current"
              icon="i-lucide-download"
              color="primary"
              variant="subtle"
              size="sm"
              :to="current.imageUrl"
              download="frame.jpg"
              aria-label="Download"
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

        <!-- Image stage: zoom/pan viewport + prev/next + grid + compare slider -->
        <div
          ref="viewport"
          class="relative bg-elevated overflow-hidden touch-none select-none h-[70vh]"
          :class="isZoomed ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in'"
          @wheel="onWheel"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointerleave="onPointerUp"
          @dblclick="toggleFitHundred"
          @touchstart="onTouchStart"
          @touchmove="onTouchMove"
          @touchend="onTouchEnd"
        >
          <!-- The transformed frame (and, in compare mode, the original beneath). -->
          <div
            ref="compareEl"
            class="absolute inset-0 flex items-center justify-center"
          >
            <!-- Current (edited) frame. In compare mode it is clipped to the
                 right of the divider so the original shows through on the left. -->
            <img
              v-if="current"
              ref="imageEl"
              :src="current.imageUrl"
              :alt="current.label"
              class="max-h-full max-w-full object-contain origin-center will-change-transform"
              :style="{
                transform,
                clipPath: compare && canCompare
                  ? `inset(0 0 0 ${comparePos * 100}%)`
                  : undefined
              }"
              draggable="false"
            >
            <!-- Original beneath, revealed left of the divider. Shares the same
                 transform so zoom/pan stays aligned between the two. -->
            <img
              v-if="compare && canCompare && current?.originalUrl"
              :src="current.originalUrl"
              alt="Original"
              class="absolute max-h-full max-w-full object-contain origin-center will-change-transform"
              :style="{
                transform,
                clipPath: `inset(0 ${(1 - comparePos) * 100}% 0 0)`
              }"
              draggable="false"
            >
          </div>

          <!-- Rule-of-thirds overlay (presentational). -->
          <GridOverlay :show="showGrid" />

          <!-- Before/after draggable divider. -->
          <div
            v-if="compare && canCompare"
            class="absolute inset-y-0 z-10 flex items-center"
            :style="{ left: `calc(${comparePos * 100}% - 1px)` }"
          >
            <div class="absolute inset-y-0 w-0.5 bg-white/90 shadow" />
            <div
              class="relative -ml-4 h-9 w-9 rounded-full bg-white text-black ring-1 ring-black/10 shadow-lg flex items-center justify-center cursor-ew-resize"
              role="slider"
              aria-label="Before/after divider"
              @pointerdown="onDividerDown"
              @pointermove="onDividerMove"
              @pointerup="onDividerUp"
            >
              <UIcon
                name="i-lucide-chevrons-left-right"
                class="size-4"
              />
            </div>
          </div>
          <!-- Compare labels -->
          <template v-if="compare && canCompare">
            <span class="absolute top-3 left-3 z-10 px-2 py-0.5 rounded text-xs font-medium bg-black/60 text-white">Original</span>
            <span class="absolute top-3 right-3 z-10 px-2 py-0.5 rounded text-xs font-medium bg-black/60 text-white">Edited</span>
          </template>

          <!-- Prev / next paging. -->
          <UButton
            v-if="hasPrev"
            icon="i-lucide-chevron-left"
            color="neutral"
            variant="solid"
            size="lg"
            class="absolute top-1/2 left-3 -translate-y-1/2 rounded-full opacity-80 hover:opacity-100 z-20"
            aria-label="Previous frame"
            @click="prev"
          />
          <UButton
            v-if="hasNext"
            icon="i-lucide-chevron-right"
            color="neutral"
            variant="solid"
            size="lg"
            class="absolute top-1/2 right-3 -translate-y-1/2 rounded-full opacity-80 hover:opacity-100 z-20"
            aria-label="Next frame"
            @click="next"
          />

          <!-- Zoom controls (bottom-center). -->
          <div class="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 rounded-full bg-black/60 px-1.5 py-1 backdrop-blur">
            <UButton
              icon="i-lucide-zoom-out"
              color="neutral"
              variant="ghost"
              size="xs"
              class="text-white hover:bg-white/15"
              aria-label="Zoom out"
              @click="zoomOut"
            />
            <button
              type="button"
              class="min-w-[3rem] text-center text-xs font-mono text-white tabular-nums"
              aria-label="Reset zoom"
              @click="resetZoom"
            >
              {{ percent }}%
            </button>
            <UButton
              icon="i-lucide-zoom-in"
              color="neutral"
              variant="ghost"
              size="xs"
              class="text-white hover:bg-white/15"
              aria-label="Zoom in"
              @click="zoomIn"
            />
            <div class="w-px h-4 bg-white/25 mx-0.5" />
            <UButton
              label="Fit"
              color="neutral"
              variant="ghost"
              size="xs"
              class="text-white hover:bg-white/15"
              @click="zoomToFit"
            />
            <UButton
              label="100%"
              color="neutral"
              variant="ghost"
              size="xs"
              class="text-white hover:bg-white/15"
              @click="zoomToHundred"
            />
          </div>
        </div>

        <!-- Caption: op chips + zoom% / mode + position + shortcut legend -->
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
          <div class="flex items-center gap-3 shrink-0">
            <span
              class="hidden sm:inline text-xs text-dimmed"
              title="Arrows page · +/-/0 zoom · c compare · g grid · Esc close"
            >
              {{ modeLabel }} · {{ percent }}%
            </span>
            <span class="text-xs text-dimmed">
              {{ index + 1 }} / {{ frames.length }}
            </span>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
