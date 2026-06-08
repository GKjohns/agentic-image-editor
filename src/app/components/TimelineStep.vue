<script setup lang="ts">
import type { StepEvent, Phase, Operation, ToolName } from '#shared/types'

const props = defineProps<{
  step: StepEvent
  /** This frame is the current download target / final result. */
  isResult?: boolean
}>()

const emit = defineEmits<{
  open: []
  continue: []
  useAsResult: []
}>()

type BadgeColor = 'neutral' | 'warning' | 'info' | 'primary' | 'secondary' | 'success'

const phaseColors: Record<Phase, BadgeColor> = {
  straighten: 'neutral',
  exposure: 'warning',
  tone: 'info',
  color: 'primary',
  creative: 'secondary',
  finish: 'success'
}

const phaseColor = computed(() => props.step.phase ? phaseColors[props.step.phase] : 'neutral')

/**
 * Params that are NOT bipolar deltas centered on 0, so a leading `+` would mislead.
 * `saturation.amount` is a MULTIPLIER centered on 1 (0.7 = a reduction, not "+0.7");
 * `sharpen.amount` is a 0..1 magnitude. For these we show the bare number.
 */
const unsignedParams: Partial<Record<ToolName, string>> = {
  saturation: 'amount',
  sharpen: 'amount'
}

/** Format one param value: signed deltas (e.g. "+35", "-10") unless unsigned. */
function formatValue(v: number | string, signed: boolean): string {
  if (typeof v === 'number') {
    const rounded = Math.round(v * 100) / 100
    return signed && rounded > 0 ? `+${rounded}` : `${rounded}`
  }
  return v
}

/** Compact, generic "tool · key val key val" label for one operation. */
function opLabel(op: Operation): string {
  const parts = Object.entries(op.params).map(([k, v]) => {
    // `look` carries a single string `name` — render just the grade name.
    if (op.tool === 'look' && k === 'name') return String(v)
    const signed = unsignedParams[op.tool] !== k
    return `${k} ${formatValue(v, signed)}`
  })
  return parts.length ? `${op.tool} · ${parts.join(' · ')}` : op.tool
}

/**
 * The step's changed-slider ops as compact chips (the config diff). Falls back to
 * the legacy single `operation` field only if `operations` is absent.
 */
const opChips = computed<string[]>(() => {
  const ops = props.step.operations
  if (ops && ops.length) return ops.map(opLabel)
  if (props.step.operation) return [opLabel(props.step.operation)]
  return []
})

/** The step's stated sub-goal — the card title. */
const goal = computed(() => props.step.goal ?? null)

const isDeciding = computed(() => props.step.status === 'deciding')
const hasImage = computed(() => (props.step.status === 'applied' || props.step.status === 'done') && !!props.step.imageUrl)
const isDone = computed(() => props.step.status === 'done')
const isError = computed(() => props.step.status === 'error')
</script>

<template>
  <UCard
    variant="subtle"
    class="group transition-shadow"
    :class="isResult ? 'ring-2 ring-primary' : ''"
    :ui="{ body: 'flex gap-4 sm:gap-5' }"
  >
    <!-- Step number + connector rail -->
    <div class="flex flex-col items-center shrink-0">
      <span
        class="flex items-center justify-center size-7 rounded-full text-xs font-semibold ring-1"
        :class="isError
          ? 'bg-error/10 text-error ring-error/30'
          : isDone
            ? 'bg-primary/10 text-primary ring-primary/30'
            : 'bg-elevated text-muted ring-default'"
      >
        <UIcon
          v-if="isDone"
          name="i-lucide-check"
          class="size-4"
        />
        <UIcon
          v-else-if="isError"
          name="i-lucide-x"
          class="size-4"
        />
        <template v-else>{{ step.step }}</template>
      </span>
    </div>

    <!-- Body -->
    <div class="flex-1 min-w-0 space-y-2.5">
      <div class="flex flex-wrap items-center gap-2">
        <UBadge
          v-if="step.phase"
          :color="phaseColor"
          variant="subtle"
          size="sm"
          class="capitalize"
        >
          {{ step.phase }}
        </UBadge>

        <span
          v-if="goal"
          class="text-sm font-semibold text-highlighted"
        >
          {{ goal }}
        </span>

        <span
          v-if="isDeciding"
          class="inline-flex items-center gap-1.5 text-sm text-muted"
        >
          <UIcon
            name="i-lucide-loader-circle"
            class="size-4 animate-spin"
          />
          Deciding…
        </span>

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

      <!-- Op chips: one compact chip per slider the step changed -->
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

      <!-- Actions: branch / use-as-result on any applied frame -->
      <div
        v-if="hasImage"
        class="flex flex-wrap items-center gap-2 pt-0.5 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
      >
        <UButton
          icon="i-lucide-git-branch"
          label="Continue from here"
          color="neutral"
          variant="subtle"
          size="xs"
          @click="emit('continue')"
        />
        <UButton
          v-if="!isResult"
          icon="i-lucide-flag"
          label="Use this as result"
          color="neutral"
          variant="ghost"
          size="xs"
          @click="emit('useAsResult')"
        />
      </div>
    </div>

    <!-- Thumbnail (click to open the lightbox) -->
    <div class="shrink-0 self-start">
      <button
        v-if="hasImage"
        type="button"
        class="block rounded-lg overflow-hidden ring-1 ring-default hover:ring-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary transition"
        aria-label="Open frame full screen"
        @click="emit('open')"
      >
        <img
          :src="step.imageUrl"
          alt="Step result"
          class="size-20 sm:size-24 object-cover"
        >
      </button>
      <div
        v-else-if="!isDone"
        class="flex items-center justify-center size-20 sm:size-24 rounded-lg bg-elevated ring-1 ring-default"
      >
        <UIcon
          name="i-lucide-image"
          class="size-6 text-dimmed"
        />
      </div>
    </div>
  </UCard>
</template>
