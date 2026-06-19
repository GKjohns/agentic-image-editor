<script setup lang="ts">
// The cockpit's filmstrip: a horizontal scroll row of every frame (original +
// each applied step) so the user navigates the edit history with one glance +
// one click instead of scrolling the rail. Selecting a thumb pins the stage to
// that frame; the branch "⑂" button (always visible, also ⌥-click) starts a
// "continue from here" run; the result flag marks the download target.
//
// Props down / events up: this component owns no run state — index.vue resolves
// `select`/`branch`/`useAsResult` against its refs (`selectedStep`, `fromStep`,
// `resultStep`). The auto-follow scroll respects the same pin rule as the stage:
// while running we scroll to the newest thumb UNLESS the user has scrolled away.

/** A filmstrip frame — the original or an applied step's rendered image. */
export interface FilmstripFrame {
  /** 'original' for the source image, else the applied step number. */
  step: number | 'original'
  imageUrl: string
  label: string
}

const props = defineProps<{
  /** Original first, then each applied step (derive from `lightboxFrames`). */
  frames: FilmstripFrame[]
  /** Which frame the cockpit is focused on (null before the first selection). */
  selectedStep: number | 'original' | null
  /** The current download target / result frame (null = default last applied). */
  resultStep: number | null
  /** A run is in flight — show the trailing "deciding…" shimmer + auto-follow. */
  running: boolean
}>()

const emit = defineEmits<{
  /** Pin the stage to this frame. */
  select: [step: number | 'original']
  /** "Continue from here" — branch a new run off this step. */
  branch: [step: number]
  /** Make this frame the result / download target. */
  useAsResult: [step: number]
}>()

// The scroll container, so we can auto-follow the newest frame while running.
const scroller = ref<HTMLElement | null>(null)

// True once the user has scrolled the strip themselves — suppresses auto-follow
// until a new run / the strip is back near the end. We don't reuse index.vue's
// `userPinned` here: that governs the STAGE; this is purely scroll position, so
// a click on an earlier thumb shouldn't freeze the strip if the user is just
// watching the newest frames stream in.
const userScrolled = ref(false)

function onScroll() {
  const el = scroller.value
  if (!el) return
  // If the user is within a thumb's width of the end, treat them as "following"
  // again so a tiny manual nudge doesn't permanently stop auto-scroll.
  const nearEnd = el.scrollWidth - el.scrollLeft - el.clientWidth < 80
  userScrolled.value = !nearEnd
}

function scrollToEnd() {
  const el = scroller.value
  if (el) el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' })
}

// Auto-follow: when a new applied frame arrives while running (the frame count
// grows), scroll to the newest thumb unless the user has scrolled away.
watch(
  () => props.frames.length,
  () => {
    if (props.running && !userScrolled.value) {
      nextTick(scrollToEnd)
    }
  }
)

/** Whether a given frame is the active selection (active ring). */
function isSelected(step: number | 'original'): boolean {
  return props.selectedStep === step
}

/** Whether a given frame is the result / download target (result flag). */
function isResult(step: number | 'original'): boolean {
  return step !== 'original' && step === props.resultStep
}

/** Click a thumb: ⌥/Alt-click is a desktop shortcut for branch; else select. */
function onThumbClick(frame: FilmstripFrame, event: MouseEvent) {
  if (event.altKey && frame.step !== 'original') {
    emit('branch', frame.step)
    return
  }
  emit('select', frame.step)
}

/** Short label under each thumb: "Orig" or the step number. */
function thumbLabel(frame: FilmstripFrame): string {
  return frame.step === 'original' ? 'Orig' : String(frame.step)
}
</script>

<template>
  <div class="rounded-xl ring-1 ring-default bg-elevated/40 h-full flex items-center">
    <div
      ref="scroller"
      class="flex items-stretch gap-3 overflow-x-auto px-4 py-3 w-full"
      @scroll="onScroll"
    >
      <!-- One thumb per frame: active ring + result flag + branch button -->
      <div
        v-for="frame in frames"
        :key="frame.step"
        class="relative shrink-0"
      >
        <button
          type="button"
          class="block rounded-lg overflow-hidden ring-1 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          :class="isSelected(frame.step)
            ? 'ring-2 ring-primary'
            : 'ring-default hover:ring-primary/60'"
          :aria-label="frame.step === 'original'
            ? 'Select original frame'
            : `Select step ${frame.step}`"
          :aria-pressed="isSelected(frame.step)"
          @click="onThumbClick(frame, $event)"
        >
          <img
            :src="frame.imageUrl"
            :alt="frame.label"
            class="size-16 object-cover"
          >
        </button>

        <!-- Result flag: marks the current download target. -->
        <span
          v-if="isResult(frame.step)"
          class="absolute top-1 left-1 inline-flex items-center justify-center rounded-md bg-primary text-inverted size-4 shadow"
          :title="'Result frame'"
        >
          <UIcon
            name="i-lucide-flag"
            class="size-3"
          />
        </span>

        <!-- Branch affordance: ALWAYS visible (not hover-only), so it works on
             touch too. ⌥-click on the thumb is a desktop shortcut for the same. -->
        <UButton
          v-if="frame.step !== 'original'"
          icon="i-lucide-git-branch"
          color="neutral"
          variant="solid"
          size="xs"
          class="absolute -top-1.5 -right-1.5 rounded-full p-0.5 shadow"
          :aria-label="`Continue from step ${frame.step}`"
          :title="`Continue from step ${frame.step}`"
          @click.stop="emit('branch', frame.step)"
        />

        <!-- "Use as result": flag a non-result applied frame as the download
             target. Always visible (like branch) so it works on touch. The
             current result frame already shows the solid flag, so it's hidden
             there to avoid a redundant control. -->
        <UButton
          v-if="frame.step !== 'original' && !isResult(frame.step)"
          icon="i-lucide-flag"
          color="neutral"
          variant="solid"
          size="xs"
          class="absolute -bottom-1.5 -right-1.5 rounded-full p-0.5 shadow"
          :aria-label="`Use step ${frame.step} as result`"
          :title="`Use step ${frame.step} as result`"
          @click.stop="emit('useAsResult', frame.step)"
        />

        <!-- Step number / Orig label under the thumb. -->
        <p
          class="mt-1 text-center text-[10px] font-medium tabular-nums"
          :class="isSelected(frame.step) ? 'text-primary' : 'text-muted'"
        >
          {{ thumbLabel(frame) }}
        </p>
      </div>

      <!-- Trailing "deciding…" shimmer while running and the latest step has no
           image yet — the next frame is being rendered. -->
      <div
        v-if="running"
        class="shrink-0"
      >
        <div class="size-16 rounded-lg ring-1 ring-default overflow-hidden filmstrip-shimmer" />
        <p class="mt-1 text-center text-[10px] font-medium text-dimmed">
          …
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Indeterminate shimmer for the pending-frame tile (mirrors the stage's
   indeterminate working treatment — no honest denominator). */
@keyframes filmstrip-shimmer-sweep {
  0% { background-position: -150% 0; }
  100% { background-position: 250% 0; }
}
.filmstrip-shimmer {
  background-image: linear-gradient(
    100deg,
    var(--ui-bg-elevated) 30%,
    var(--ui-bg-accented) 50%,
    var(--ui-bg-elevated) 70%
  );
  background-size: 200% 100%;
  animation: filmstrip-shimmer-sweep 1.4s ease-in-out infinite;
}
</style>
