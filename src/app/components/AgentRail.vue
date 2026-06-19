<script setup lang="ts">
// The cockpit's agent / history rail: a scrollable list of AgentStepRow, one per
// streamed step. The active (latest streaming) row is emphasized and auto-scrolled
// into view while running — mirroring the filmstrip's auto-follow + pin rule:
// we follow the newest row UNLESS the user has scrolled the list away from the
// bottom (re-engaging once they scroll back near the end).
//
// Props down / events up: the rail owns no run state. `index.vue` decides
// `selectedStep`/`activeStep`/`resultStep` and reacts to the pass-through emits.
import type { StepEvent } from '#shared/types'

const props = defineProps<{
  /** Every streamed step, in order. */
  steps: StepEvent[]
  /** Which frame the cockpit is focused on (drives which row is expanded). */
  selectedStep: number | 'original' | null
  /** The latest streaming step — drives the active-row emphasis + auto-scroll. */
  activeStep: StepEvent | null
  /** The current download target / result frame (null = default last applied). */
  resultStep: number | null
}>()

const emit = defineEmits<{
  /** Pin the cockpit (stage + filmstrip) to this step's frame. */
  select: [step: number]
  /** "Continue from here" — branch a new run off this step. */
  continue: [step: number]
  /** Make this frame the result / download target. */
  useAsResult: [step: number]
}>()

// The scroll container, so we can auto-follow the active row while running.
const scroller = ref<HTMLElement | null>(null)

// True once the user has scrolled the list themselves — suppresses auto-follow
// until they scroll back near the bottom (a tiny manual nudge near the end keeps
// following). Local to the rail's scroll position; it does NOT touch the stage's
// `userPinned` (that governs which frame is shown, not this list's scroll).
const userScrolled = ref(false)

function onScroll() {
  const el = scroller.value
  if (!el) return
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64
  userScrolled.value = !nearBottom
}

function scrollToBottom() {
  const el = scroller.value
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
}

// Auto-follow: when a new step arrives (the active step changes) and the user
// hasn't scrolled away, bring the newest row into view.
watch(
  () => props.activeStep?.step,
  () => {
    if (!userScrolled.value) nextTick(scrollToBottom)
  }
)

/** Which row is selected (expanded) — matches `selectedStep` by step number. */
function isSelected(step: StepEvent): boolean {
  return props.selectedStep === step.step
}

/** Which row is the active (latest streaming) step. */
function isActive(step: StepEvent): boolean {
  return props.activeStep?.step === step.step
}

/** Which row is the result / download target. */
function isResult(step: StepEvent): boolean {
  return props.resultStep === step.step
}
</script>

<template>
  <div class="hidden lg:flex flex-col min-h-0 rounded-xl ring-1 ring-default bg-elevated/40">
    <div class="flex items-center gap-2 px-4 py-3 border-b border-default shrink-0">
      <h2 class="text-sm font-semibold uppercase tracking-wide text-muted">
        Agent
      </h2>
      <UBadge
        color="neutral"
        variant="subtle"
        size="sm"
      >
        {{ steps.length }} {{ steps.length === 1 ? 'step' : 'steps' }}
      </UBadge>
    </div>

    <!-- Scrollable list of step rows (internal scroll). -->
    <div
      ref="scroller"
      class="flex-1 overflow-y-auto p-3 space-y-2"
      @scroll="onScroll"
    >
      <p
        v-if="!steps.length"
        class="px-1 py-2 text-xs text-dimmed"
      >
        The agent's steps will appear here.
      </p>
      <AgentStepRow
        v-for="step in steps"
        :key="step.step"
        :step="step"
        :selected="isSelected(step)"
        :is-active="isActive(step)"
        :is-result="isResult(step)"
        @select="emit('select', step.step)"
        @continue="emit('continue', step.step)"
        @use-as-result="emit('useAsResult', step.step)"
      />
    </div>
  </div>
</template>
