<script setup lang="ts">
// One row in the agent rail. Collapsed it's a compact one/two-line summary
// (status icon · phase dot · truncated goal · op-chip count). When the row is
// `selected` it expands INLINE to reveal the full op chips, assessment, reason,
// any error, and the always-visible branch + "use as result" actions — this row
// IS the step detail; there is no separate detail panel.
//
// Props down / events up: the row owns no run state. `index.vue` decides which
// row is `selected`/`isResult`/`isActive` and reacts to the emits.
import type { StepEvent } from '#shared/types'
import { opLabel, phaseColor } from '~/utils/stepFormat'

const props = defineProps<{
  step: StepEvent
  /** This row is the selected one — expand it inline. */
  selected?: boolean
  /** This frame is the current download target / result. */
  isResult?: boolean
  /** This is the active (latest streaming) step — gets emphasis. */
  isActive?: boolean
}>()

const emit = defineEmits<{
  /** Pin the cockpit (stage + filmstrip) to this step's frame. */
  select: []
  /** "Continue from here" — branch a new run off this step. */
  continue: []
  /** Make this frame the result / download target. */
  useAsResult: []
}>()

const isDeciding = computed(() => props.step.status === 'deciding')
const isDone = computed(() => props.step.status === 'done')
const isError = computed(() => props.step.status === 'error')
// An applied (or terminal done) step has a rendered frame to branch/flag from.
const hasImage = computed(() =>
  (props.step.status === 'applied' || props.step.status === 'done') && !!props.step.imageUrl
)

/**
 * The step's changed-slider ops as compact chips (the config diff). Falls back
 * to the legacy single `operation` field only if `operations` is absent.
 */
const opChips = computed<string[]>(() => {
  const ops = props.step.operations
  if (ops && ops.length) return ops.map(opLabel)
  if (props.step.operation) return [opLabel(props.step.operation)]
  return []
})
</script>

<template>
  <div
    class="rounded-lg ring-1 transition cursor-pointer"
    :class="[
      isActive
        ? 'ring-primary bg-primary/5'
        : selected
          ? 'ring-primary/50 bg-elevated'
          : 'ring-default hover:ring-primary/40 bg-elevated/40',
      isResult && !isActive ? 'ring-primary' : ''
    ]"
    @click="emit('select')"
  >
    <!-- Collapsed summary: status · phase dot · goal · op-chip count -->
    <div class="flex items-center gap-2.5 px-3 py-2.5">
      <!-- Status marker: step number, ✓ done, ✕ error, or a spinner deciding. -->
      <span
        class="flex items-center justify-center size-6 shrink-0 rounded-full text-[11px] font-semibold ring-1"
        :class="isError
          ? 'bg-error/10 text-error ring-error/30'
          : isDone
            ? 'bg-primary/10 text-primary ring-primary/30'
            : 'bg-elevated text-muted ring-default'"
      >
        <UIcon
          v-if="isDone"
          name="i-lucide-check"
          class="size-3.5"
        />
        <UIcon
          v-else-if="isError"
          name="i-lucide-x"
          class="size-3.5"
        />
        <UIcon
          v-else-if="isDeciding"
          name="i-lucide-loader-circle"
          class="size-3.5 animate-spin"
        />
        <template v-else>{{ step.step }}</template>
      </span>

      <!-- Phase dot: a small colored marker (compact stand-in for the badge). -->
      <span
        v-if="step.phase"
        class="size-2 shrink-0 rounded-full"
        :class="{
          'bg-neutral-400': phaseColor(step.phase) === 'neutral',
          'bg-warning': phaseColor(step.phase) === 'warning',
          'bg-info': phaseColor(step.phase) === 'info',
          'bg-primary': phaseColor(step.phase) === 'primary',
          'bg-secondary': phaseColor(step.phase) === 'secondary',
          'bg-success': phaseColor(step.phase) === 'success'
        }"
        :title="step.phase"
      />

      <!-- Goal (truncated): the working caption while deciding, else the goal. -->
      <span class="flex-1 min-w-0 truncate text-sm text-highlighted">
        <template v-if="isActive && isDeciding">
          <span class="text-muted">working…</span>
        </template>
        <template v-else>{{ step.goal ?? 'Step ' + step.step }}</template>
      </span>

      <!-- Op-chip count (collapsed only — expanded shows the chips themselves). -->
      <UBadge
        v-if="!selected && opChips.length"
        color="neutral"
        variant="subtle"
        size="sm"
        class="shrink-0 tabular-nums"
      >
        {{ opChips.length }}
      </UBadge>

      <!-- Result marker on the collapsed row. -->
      <UIcon
        v-if="isResult"
        name="i-lucide-flag"
        class="size-3.5 shrink-0 text-primary"
        title="Result frame"
      />
    </div>

    <!-- Expanded detail (selected only): chips · assessment · reason · actions -->
    <div
      v-if="selected"
      class="px-3 pb-3 pt-0.5 space-y-2.5"
    >
      <USeparator />

      <div class="flex flex-wrap items-center gap-2">
        <UBadge
          v-if="step.phase"
          :color="phaseColor(step.phase)"
          variant="subtle"
          size="sm"
          class="capitalize"
        >
          {{ step.phase }}
        </UBadge>
        <UBadge
          v-if="isResult"
          color="primary"
          variant="solid"
          size="sm"
          icon="i-lucide-check-circle"
        >
          Result
        </UBadge>
      </div>

      <!-- Op chips: one compact chip per slider the step changed. -->
      <div
        v-if="opChips.length"
        class="flex flex-wrap gap-1.5"
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

      <p
        v-if="step.assessment"
        class="text-sm text-default leading-relaxed"
      >
        {{ step.assessment }}
      </p>

      <p
        v-if="step.reason"
        class="text-sm text-muted leading-relaxed"
      >
        {{ step.reason }}
      </p>

      <UAlert
        v-if="isError && step.error"
        color="error"
        variant="subtle"
        :title="step.error"
        icon="i-lucide-triangle-alert"
      />

      <!-- Actions: ALWAYS visible (not hover-gated) on any frame with an image. -->
      <div
        v-if="hasImage"
        class="flex flex-wrap items-center gap-2 pt-0.5"
      >
        <UButton
          icon="i-lucide-git-branch"
          label="Continue from here"
          color="neutral"
          variant="subtle"
          size="xs"
          @click.stop="emit('continue')"
        />
        <UButton
          v-if="!isResult"
          icon="i-lucide-flag"
          label="Use as result"
          color="neutral"
          variant="ghost"
          size="xs"
          @click.stop="emit('useAsResult')"
        />
      </div>
    </div>
  </div>
</template>
