<script setup lang="ts">
// The cockpit's persistent command bar (pinned at the bottom). It owns the intent
// input + Send while a run is in flight or finished — taking over InputPanel's
// Run/Stop role in the running/done views. Two things make it the steering surface:
//   - Send is enabled EVEN WHILE RUNNING. Sending mid-run interrupts the current
//     run and re-aims it from the on-stage frame (the index.vue `send()` wrapper
//     does the stop-then-continue). The button reflects this: idle → "Send";
//     running → "Steer" so the user understands sending now redirects the edit.
//   - Stop is ALWAYS VISIBLE (not hidden behind a state swap like InputPanel),
//     enabled only while running, so it's reachable mid-run without hunting.
//
// Props down / events up: the bar owns no run state. `intent` is a two-way
// `defineModel` sharing index.vue's single `intent` ref (the same ref InputPanel
// binds in setup), and `fromStep` is a two-way model so the chip's ✕ can clear the
// branch point directly. `send`/`stop` are pass-through to index.vue.
const intent = defineModel<string>('intent', { required: true })
// Two-way so the "continuing from Step N · ✕" chip can clear the branch point
// itself (set null) without a separate event — mirrors InputPanel's defineModel
// pattern and keeps fromStep a single source of truth in index.vue.
const fromStep = defineModel<number | null>('fromStep', { required: true })

const props = defineProps<{
  /** A run is in flight (drives Stop enablement + the Send→Steer label swap). */
  running: boolean
  /** Whether a fresh run is valid (image + non-empty intent) — gates idle Send. */
  canRun: boolean
  /** Our own/SDK error to surface inline under the bar. */
  errorMessage: string | null
}>()

const emit = defineEmits<{
  /** Send the current intent — fresh run, refinement, or interrupt-and-steer. */
  send: []
  /** Stop the in-flight run. */
  stop: []
}>()

// Send is enabled while running (to steer); when idle it needs a valid run.
// A blank intent can't steer either, so require some text in both states.
const canSend = computed(() => {
  const hasText = intent.value.trim().length > 0
  return props.running ? hasText : props.canRun
})

/** Enter sends (unless Shift for a newline). Mirrors a chat composer. */
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    if (canSend.value) emit('send')
  }
}

// Expose focus() so "continue from here" (index.vue) can drop the cursor into the
// intent input after setting the branch point — the user types the steer next.
// UTextarea forwards a `$el` root; the native <textarea> is queried off it.
const textarea = useTemplateRef<{ $el?: HTMLElement }>('textarea')
defineExpose({
  focus() {
    textarea.value?.$el?.querySelector('textarea')?.focus()
  }
})
</script>

<template>
  <div class="shrink-0 rounded-xl ring-1 ring-default bg-elevated/40 p-3 space-y-2">
    <!-- Branch context chip: when a "continue from here" set a branch point, make
         it explicit so the user knows the next Send appends from that frame. The
         ✕ clears it (back to default continuation from the result frame). -->
    <div
      v-if="fromStep !== null"
      class="flex"
    >
      <UBadge
        color="primary"
        variant="subtle"
        size="sm"
        class="gap-1"
      >
        <UIcon
          name="i-lucide-git-branch"
          class="size-3"
        />
        Continuing from Step {{ fromStep }}
        <button
          type="button"
          class="ml-0.5 inline-flex items-center justify-center rounded-sm hover:text-highlighted focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          aria-label="Clear branch point"
          @click="fromStep = null"
        >
          <UIcon
            name="i-lucide-x"
            class="size-3"
          />
        </button>
      </UBadge>
    </div>

    <div class="flex items-end gap-2">
      <UTextarea
        ref="textarea"
        v-model="intent"
        :rows="1"
        autoresize
        class="flex-1"
        :ui="{ base: 'resize-none' }"
        :placeholder="running ? 'Steer the edit — e.g. now make it cooler…' : 'Refine the edit — e.g. now make it cooler…'"
        @keydown="onKeydown"
      />

      <!-- Send: enabled while running (steer). Label/icon reflect state. -->
      <UButton
        :icon="running ? 'i-lucide-send-horizontal' : 'i-lucide-send'"
        :label="running ? 'Steer' : 'Send'"
        color="primary"
        :disabled="!canSend"
        @click="emit('send')"
      />

      <!-- Stop: ALWAYS visible, enabled only while running, so it's reachable
           mid-run without scrolling or a state swap. -->
      <UButton
        icon="i-lucide-square"
        label="Stop"
        color="neutral"
        variant="subtle"
        :disabled="!running"
        @click="emit('stop')"
      />
    </div>

    <UAlert
      v-if="errorMessage"
      color="error"
      variant="subtle"
      :title="errorMessage"
      icon="i-lucide-triangle-alert"
    />
  </div>
</template>
