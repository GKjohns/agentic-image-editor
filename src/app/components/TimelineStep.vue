<script setup lang="ts">
import type { StepEvent, Phase } from '#shared/types'

const props = defineProps<{
  step: StepEvent
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

/** Format one param value: signed numbers (e.g. "+35", "-10"), strings as-is. */
function formatValue(v: number | string): string {
  if (typeof v === 'number') {
    const rounded = Math.round(v * 100) / 100
    return rounded > 0 ? `+${rounded}` : `${rounded}`
  }
  return v
}

/** Compact, generic "tool · key val key val" — handles every tool's params. */
const operationLabel = computed(() => {
  const op = props.step.operation
  if (!op) return null
  const parts = Object.entries(op.params).map(([k, v]) => {
    // `look` carries a single string `name` — render just the grade name.
    if (op.tool === 'look' && k === 'name') return String(v)
    return `${k} ${formatValue(v)}`
  })
  return `${op.tool} · ${parts.join(' ')}`
})

const isDeciding = computed(() => props.step.status === 'deciding')
const hasImage = computed(() => (props.step.status === 'applied' || props.step.status === 'done') && !!props.step.imageUrl)
const isDone = computed(() => props.step.status === 'done')
const isError = computed(() => props.step.status === 'error')
</script>

<template>
  <UCard
    variant="subtle"
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

        <UBadge
          v-if="operationLabel"
          color="neutral"
          variant="outline"
          size="sm"
          class="font-mono"
        >
          {{ operationLabel }}
        </UBadge>

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
    </div>

    <!-- Thumbnail -->
    <div class="shrink-0 self-start">
      <img
        v-if="hasImage"
        :src="step.imageUrl"
        alt="Step result"
        class="size-20 sm:size-24 rounded-lg object-cover ring-1 ring-default"
      >
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
