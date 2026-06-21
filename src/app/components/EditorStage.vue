<script setup lang="ts">
// The cockpit's live stage: one big object-contain frame that stays fixed while
// the agent streams. It shows the SELECTED frame (`imageUrl`), but its working
// caption reflects the ACTIVE (latest streaming) step — so scrubbing back never
// hides "it's still working." Clicking emits `open` with the shown imageUrl so
// the lightbox lands on the selected frame, not the result.
import type { StepEvent } from '#shared/types'

const props = defineProps<{
  /** The frame currently on the stage (selected frame's image, or original). */
  imageUrl: string | null
  /** A run is in flight. */
  running: boolean
  view: 'setup' | 'running' | 'done'
  /** The latest streaming step — drives the working caption, not the image. */
  activeStep: StepEvent | null
  /** The shown frame is the current download target / result. */
  isResult?: boolean
  /** Active crop keep-rect (normalized 0..1) for the grid overlay, or null. */
  crop?: { left: number, top: number, width: number, height: number } | null
}>()

const emit = defineEmits<{
  /** Carries the shown imageUrl so the lightbox opens the selected frame. */
  open: [imageUrl: string | null]
}>()

// The working caption text. Honest indeterminate state: while `deciding` the
// agent hasn't committed a goal yet, so we say so; once it has a goal we show it.
const caption = computed(() => {
  const step = props.activeStep
  if (!step) return 'Deciding the next move…'
  if (step.status === 'deciding') return 'Deciding the next move…'
  return step.goal ? `Step ${step.step} · ${step.goal}` : `Step ${step.step}`
})

// On done, a subtle tag in the corner: Result vs (when scrubbed back) Original.
const resultTag = computed(() => (props.isResult ? 'Result' : 'Original'))

// Rule-of-thirds / crop grid toggle — a human aid for judging level + composition.
// Off by default so it never clutters the working view; the button flips it.
const showGrid = ref(false)
</script>

<template>
  <div class="relative rounded-xl overflow-hidden ring-1 ring-default bg-elevated h-full">
    <button
      v-if="imageUrl"
      type="button"
      class="block w-full h-full cursor-zoom-in"
      aria-label="Open frame full screen"
      @click="emit('open', imageUrl)"
    >
      <img
        :src="imageUrl"
        :alt="view === 'done' ? 'Edited image' : 'Live preview of the selected frame'"
        class="w-full h-full object-contain"
      >
    </button>

    <!-- Rule-of-thirds / crop grid overlay (human aid; toggled by the button). -->
    <GridOverlay
      :show="showGrid && !!imageUrl"
      :crop="crop"
    />

    <!-- Grid toggle: a small monochrome button, top-left while editing/running so
         it doesn't collide with the done-state Result tag in that same corner. -->
    <div
      v-if="imageUrl && view !== 'done'"
      class="absolute top-3 left-3"
    >
      <UButton
        :icon="showGrid ? 'i-lucide-grid-3x3' : 'i-lucide-grid-2x2'"
        :label="showGrid ? 'Grid on' : 'Grid'"
        :color="showGrid ? 'primary' : 'neutral'"
        variant="subtle"
        size="sm"
        :aria-pressed="showGrid"
        @click.stop="showGrid = !showGrid"
      />
    </div>
    <!-- On done, the Result tag owns the top-left; put the grid toggle top-right
         (the download sits there only when isResult, so guard against overlap). -->
    <div
      v-if="imageUrl && view === 'done' && !isResult"
      class="absolute top-3 right-3"
    >
      <UButton
        :icon="showGrid ? 'i-lucide-grid-3x3' : 'i-lucide-grid-2x2'"
        :label="showGrid ? 'Grid on' : 'Grid'"
        :color="showGrid ? 'primary' : 'neutral'"
        variant="subtle"
        size="sm"
        :aria-pressed="showGrid"
        @click.stop="showGrid = !showGrid"
      />
    </div>
    <div
      v-else
      class="flex items-center justify-center h-full text-muted"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="size-6 animate-spin"
      />
    </div>

    <!-- Working caption (running only): goal + indeterminate animated progress -->
    <div
      v-if="running"
      class="absolute inset-x-0 bottom-0"
    >
      <div class="flex items-center gap-2 px-4 py-2.5 bg-default/85 backdrop-blur-sm border-t border-default">
        <UIcon
          name="i-lucide-loader-circle"
          class="size-4 shrink-0 text-primary animate-spin"
        />
        <span class="text-sm font-medium text-highlighted truncate">
          {{ caption }}
        </span>
      </div>
      <!-- Indeterminate progress bar: an animated sweep along the image edge,
           NOT a static badge — there's no honest denominator (the agent stops
           when the intent is met), so an indeterminate treatment is correct. -->
      <div class="h-0.5 overflow-hidden bg-primary/20">
        <div class="h-full w-1/3 bg-primary stage-progress" />
      </div>
    </div>

    <!-- Done: a subtle corner tag for the shown frame (Result / Original). -->
    <div
      v-else-if="view === 'done'"
      class="absolute top-3 left-3 flex items-center gap-2"
    >
      <UBadge
        :color="isResult ? 'primary' : 'neutral'"
        variant="subtle"
        size="sm"
      >
        {{ resultTag }}
      </UBadge>
    </div>

    <!-- Download stays accessible on the stage on done. -->
    <div
      v-if="view === 'done' && isResult && imageUrl"
      class="absolute top-3 right-3"
    >
      <UButton
        icon="i-lucide-download"
        label="Download"
        color="primary"
        variant="solid"
        size="sm"
        :to="imageUrl"
        download="edited.jpg"
        @click.stop
      />
    </div>
  </div>
</template>

<style scoped>
/* Indeterminate sweep for the working progress bar. */
@keyframes stage-progress-sweep {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
}
.stage-progress {
  animation: stage-progress-sweep 1.4s ease-in-out infinite;
}
</style>
