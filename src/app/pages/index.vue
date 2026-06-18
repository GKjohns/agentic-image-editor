<script setup lang="ts">
import { Chat } from '@ai-sdk/vue'
import { DefaultChatTransport } from 'ai'
import type { UIMessage } from 'ai'
import type { StepEvent } from '#shared/types'
import type { LightboxFrame } from '~/components/ImageLightbox.vue'

// --- useChat (Vercel AI SDK) -------------------------------------------------
// The interactive streaming client. The bespoke fetch + manual SSE reader is
// gone; the SDK owns the transport, the message list, and abort. Image/timeline
// state is still our own (`data-step` parts + plain client refs below).
//
// NOTE (Sprint 4, Edge 2 — unused history): `useChat` POSTs the FULL `messages[]`
// on every send, but the server ignores it — all run state (session id, branch
// point) is threaded through the request `body` in `run()`, NOT message history.
// This is harmless (the server reads `id`/`intent`/`fromStep` off the body); do
// not wire any run state through `messages` here, or it will silently no-op.
//
// `@ai-sdk/vue@3` exposes the `Chat` class (the Vue idiom; `messages`/`status`
// are reactive getters) rather than a `useChat` composable — same contract.
const chat = new Chat<UIMessage>({
  transport: new DefaultChatTransport({
    api: '/api/edit',
    // The default transport posts its own `id` (the chat id) at the body root,
    // which would shadow the session `id` the server reads. We take control of
    // the request body: ship ONLY the per-call body (session id, intent, the
    // optional branch point) plus `messages` for completeness. The session id
    // from `run()`'s per-call `body` wins — no collision with the chat id.
    prepareSendMessagesRequest: ({ messages, body }) => ({
      body: { ...body, messages }
    })
  })
})

// --- Input state -------------------------------------------------------------
const file = ref<File | null>(null)
const previewUrl = ref<string | null>(null)
const intent = ref('')
// A run is in flight while the SDK is submitting or streaming.
const running = computed(() => chat.status === 'submitted' || chat.status === 'streaming')
// Surface our own session/transport errors plus any SDK stream error.
const localError = ref<string | null>(null)
const errorMessage = computed(() => localError.value ?? chat.error?.message ?? null)

function onFileChange(value: File | File[] | null) {
  const next = Array.isArray(value) ? value[0] ?? null : value
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  file.value = next
  previewUrl.value = next ? URL.createObjectURL(next) : null
}

function onInputFile(event: Event) {
  const target = event.target as HTMLInputElement
  onFileChange(target.files?.[0] ?? null)
}

// --- Sample images (for users who don't have a photo handy) ------------------
const samples = [
  { src: '/samples/flat-and-crooked.jpg', label: 'Flat & crooked' },
  { src: '/samples/foggy-ocean-horizon.jpg', label: 'Foggy ocean' },
  { src: '/samples/foggy-rocky-shore.jpg', label: 'Foggy shore' },
  { src: '/samples/cozy-cafe-warm-cast.jpg', label: 'Warm café' },
  { src: '/samples/overcast-ocean-horizon.jpg', label: 'Overcast coast' }
]

async function loadSample(sample: { src: string, label: string }) {
  const res = await fetch(sample.src)
  const blob = await res.blob()
  const name = sample.src.split('/').pop() ?? 'sample.jpg'
  onFileChange(new File([blob], name, { type: blob.type || 'image/jpeg' }))
}

onBeforeUnmount(() => {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
})

const canRun = computed(() => !!file.value && intent.value.trim().length > 0)

// --- Session + branch state --------------------------------------------------
// Persist the session id so "continue from here" branch runs reuse the same
// session (appending frames) instead of creating a fresh one.
const sessionId = ref<string | null>(null)
// When set, the next run() branches FROM this step (sent to /api/edit as
// `fromStep`) and APPENDS to the timeline instead of wiping it.
const fromStep = ref<number | null>(null)
// Manual override of which step is the "result" (download target / big preview).
// null → default = last applied frame.
const resultStep = ref<number | null>(null)

// --- Timeline (derived from the useChat message stream) ----------------------
// Every server-emitted `data-step` part lands in `message.parts` (deciding is
// non-transient — see edit.post.ts Edge 1). The SDK already de-dupes parts by
// their stable `step-N` id (replacing data in place), but a refinement turn
// produces a NEW assistant message, so we flatten across ALL messages and keep
// the last event per step number (later status — applied/done — wins).
const steps = computed<StepEvent[]>(() => {
  const byStep = new Map<number, StepEvent>()
  for (const message of chat.messages) {
    for (const part of message.parts) {
      if (part.type === 'data-step') {
        const event = part.data as StepEvent
        byStep.set(event.step, event)
      }
    }
  }
  return [...byStep.values()].sort((a, b) => a.step - b.step)
})

// All applied frames (have a rendered image), in order.
const appliedSteps = computed(() => steps.value.filter(s => s.status === 'applied' && s.imageUrl))

// The default result frame = the last applied frame.
const lastAppliedStep = computed(() => {
  const a = appliedSteps.value
  return a.length ? a[a.length - 1]!.step : null
})

// The effective result step honours a manual `resultStep` override (used by
// "Use this as result" and "Undo last step"), else the last applied frame.
const effectiveResultStep = computed(() => resultStep.value ?? lastAppliedStep.value)

// The final / download image is the effective result frame's image.
const finalImageUrl = computed(() => {
  const step = effectiveResultStep.value
  if (step === null) return null
  return appliedSteps.value.find(s => s.step === step)?.imageUrl ?? null
})

const showFinal = computed(() => !running.value && !!finalImageUrl.value)

// --- View state --------------------------------------------------------------
// 'setup'   → no run yet: input panel is the hero, centered + roomy.
// 'running' → a run is in flight: input collapses, large live preview takes over.
// 'done'    → run finished: final image + Download, input still collapsed.
const view = computed<'setup' | 'running' | 'done'>(() => {
  if (running.value) return 'running'
  if (steps.value.length > 0) return 'done'
  return 'setup'
})

// Whether the (collapsible) input panel is expanded. In setup it's always the
// hero; once a run starts it collapses, and the header button re-expands it.
const setupOpen = ref(true)
watch(view, (v) => {
  setupOpen.value = v === 'setup'
})

// The most-recent applied frame — drives the large live preview while running.
const latestImageUrl = computed(() => {
  const a = appliedSteps.value
  return a.length ? a[a.length - 1]!.imageUrl ?? null : null
})

// What the big preview shows: the running live frame, the chosen result on done,
// else the local input preview as a placeholder.
const previewImageUrl = computed(() => {
  if (view.value === 'done') return finalImageUrl.value
  return latestImageUrl.value ?? previewUrl.value
})

/** Reset back to a fresh setup screen (clears the run + keeps no image). */
function newImage() {
  stop()
  chat.messages = []
  localError.value = null
  onFileChange(null)
  intent.value = ''
  sessionId.value = null
  fromStep.value = null
  resultStep.value = null
}

// --- Lightbox ----------------------------------------------------------------
const lightboxOpen = ref(false)
const lightboxIndex = ref(0)

// Frames for the lightbox + prev/next paging: original → each applied step.
const lightboxFrames = computed<LightboxFrame[]>(() => {
  const frames: LightboxFrame[] = []
  if (sessionId.value) {
    frames.push({ imageUrl: `/api/image/${sessionId.value}/original`, label: 'Original' })
  } else if (previewUrl.value) {
    frames.push({ imageUrl: previewUrl.value, label: 'Original' })
  }
  for (const s of appliedSteps.value) {
    frames.push({
      imageUrl: s.imageUrl!,
      label: `Step ${s.step}`,
      goal: s.goal,
      operations: s.operations
    })
  }
  return frames
})

/** Strip the `?t=` cache-buster so two URLs for the same frame compare equal. */
function framePath(url?: string): string {
  return url ? url.split('?')[0]! : ''
}

/**
 * Open the lightbox on a given frame. We resolve the index by the IMAGE the
 * thumbnail is actually showing (`imageUrl` path) first, so the modal always
 * matches the clicked thumbnail — this is what makes the terminal `done` card
 * (whose `step` number has no own frame; its image aliases the last applied
 * frame) open the right image instead of silently falling back to Original.
 * The `Step N` / `Original` label is a fallback when no imageUrl is given.
 */
function openLightbox(step: number | 'original', imageUrl?: string) {
  let idx = -1
  if (imageUrl) {
    const target = framePath(imageUrl)
    idx = lightboxFrames.value.findIndex(f => framePath(f.imageUrl) === target)
  }
  if (idx < 0) {
    idx = step === 'original'
      ? lightboxFrames.value.findIndex(f => f.label === 'Original')
      : lightboxFrames.value.findIndex(f => f.label === `Step ${step}`)
  }
  lightboxIndex.value = idx >= 0 ? idx : 0
  lightboxOpen.value = true
}

/** Open the lightbox on whatever the big preview currently shows. */
function openPreviewLightbox() {
  const step = effectiveResultStep.value
  openLightbox(step ?? 'original')
}

// --- Branch / result actions (Sprint 3) --------------------------------------
/** "Continue from here": branch a new run off `step`, appending frames. */
function continueFrom(step: number) {
  fromStep.value = step
  resultStep.value = null
  intent.value = ''
  setupOpen.value = true
}

/** "Use this as result": make `step` the download target / big preview. */
function useAsResult(step: number) {
  resultStep.value = step
}

/** "Undo last step": revert the result to the second-to-last applied frame. */
function undoLastStep() {
  const a = appliedSteps.value
  if (a.length < 2) return
  resultStep.value = a[a.length - 2]!.step
}

const canUndo = computed(() => view.value === 'done' && appliedSteps.value.length >= 2)

/**
 * Submit an edit run through `useChat`.
 *
 * State is threaded entirely via the request `body` (Edge 2/3) — `sendMessage`
 * still POSTs the chat history, but the server only reads `id`/`intent`/`fromStep`
 * off the body. The branch base frame (`fromStep`) is decided HERE, not from
 * message history:
 *   - explicit "Continue from here" (the `fromStep` ref) wins;
 *   - else, a follow-up after a finished run continues from the current result
 *     frame (conversational refinement — "now make it cooler" appends to the
 *     timeline instead of restarting from the original);
 *   - else (first run, no frames yet) base = original.
 */
async function run() {
  if (!canRun.value || running.value) return
  localError.value = null

  // The frame to branch FROM. A truly fresh first run leaves this null (server
  // defaults to `original`); any continuation derives it so frames APPEND.
  const branchFrom = fromStep.value ?? (sessionId.value ? effectiveResultStep.value : null)
  const branching = branchFrom !== null && !!sessionId.value
  if (!branching) {
    // Fresh run: clear the prior conversation/timeline and result override.
    chat.messages = []
    resultStep.value = null
  }

  try {
    let id = sessionId.value
    // Create a session from the uploaded image (fresh run only).
    if (!branching || !id) {
      const form = new FormData()
      form.append('image', file.value!)
      const session = await $fetch<{ id: string }>('/api/session', {
        method: 'POST',
        body: form
      })
      id = session.id
      sessionId.value = id
    }

    // Hand off to the SDK: it owns the SSE transport + message stream. The body
    // carries our run state; the server ignores the POSTed `messages` history.
    await chat.sendMessage(
      { text: intent.value },
      {
        body: {
          id,
          intent: intent.value,
          ...(branching ? { fromStep: branchFrom } : {})
        }
      }
    )
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error)
  } finally {
    // One-shot: consume an explicit branch point so the next plain Run derives
    // its own continuation (or starts fresh).
    fromStep.value = null
  }
}

function stop() {
  chat.stop()
}
</script>

<template>
  <UContainer class="py-8 sm:py-12">
    <div
      class="mb-8 sm:mb-10 flex items-start justify-between gap-4"
      :class="view === 'setup' ? 'max-w-3xl mx-auto' : 'max-w-6xl mx-auto'"
    >
      <div>
        <h1 class="text-2xl sm:text-3xl font-bold text-highlighted">
          Agentic Image Editor
        </h1>
        <p class="mt-2 text-muted">
          Drop an image, describe the edit, watch an AI agent do it step by step.
        </p>
      </div>

      <!-- Header controls (only once a run has started) -->
      <div
        v-if="view !== 'setup'"
        class="flex items-center gap-2 shrink-0"
      >
        <UButton
          v-if="canUndo"
          icon="i-lucide-undo-2"
          label="Undo last step"
          color="neutral"
          variant="subtle"
          size="sm"
          @click="undoLastStep"
        />
        <UButton
          icon="i-lucide-sliders-horizontal"
          label="Edit setup"
          color="neutral"
          variant="subtle"
          size="sm"
          :class="setupOpen ? 'ring-1 ring-primary/40' : ''"
          @click="setupOpen = !setupOpen"
        />
        <UButton
          icon="i-lucide-image-plus"
          label="New image"
          color="neutral"
          variant="ghost"
          size="sm"
          @click="newImage"
        />
      </div>
    </div>

    <!-- SETUP: input panel is the hero, centered + roomy -->
    <div
      v-if="view === 'setup'"
      class="max-w-xl mx-auto"
    >
      <UCard>
        <InputPanel
          v-model:preview-url="previewUrl"
          v-model:intent="intent"
          :samples="samples"
          :can-run="canRun"
          :running="running"
          :error-message="errorMessage"
          @pick-file="onInputFile"
          @clear-file="onFileChange(null)"
          @load-sample="loadSample"
          @run="run"
          @stop="stop"
        />
      </UCard>
    </div>

    <!-- RUNNING / DONE: large live preview takes over; input collapses inline -->
    <div
      v-else
      class="grid lg:grid-cols-5 gap-6 lg:gap-8 max-w-6xl mx-auto"
    >
      <!-- Collapsible input panel (re-opened from the header button) -->
      <div
        v-if="setupOpen"
        class="lg:col-span-2"
      >
        <UCard class="lg:sticky lg:top-8">
          <InputPanel
            v-model:preview-url="previewUrl"
            v-model:intent="intent"
            :samples="samples"
            :can-run="canRun"
            :running="running"
            :error-message="errorMessage"
            @pick-file="onInputFile"
            @clear-file="onFileChange(null)"
            @load-sample="loadSample"
            @run="run"
            @stop="stop"
          />
        </UCard>
      </div>

      <!-- Main area: large live preview + supporting timeline -->
      <div :class="setupOpen ? 'lg:col-span-3 space-y-6' : 'lg:col-span-5 space-y-6'">
        <!-- Large live preview of the latest frame (final on done) -->
        <section>
          <div class="flex items-center justify-between mb-4">
            <div class="flex items-center gap-2">
              <h2 class="text-sm font-semibold uppercase tracking-wide text-muted">
                {{ view === 'done' ? 'Final result' : 'Live preview' }}
              </h2>
              <UBadge
                v-if="running"
                color="primary"
                variant="subtle"
                size="sm"
                :ui="{ leadingIcon: 'animate-spin' }"
                icon="i-lucide-loader-circle"
              >
                Editing…
              </UBadge>
            </div>
            <UButton
              v-if="showFinal"
              icon="i-lucide-download"
              label="Download"
              color="primary"
              variant="subtle"
              size="sm"
              :to="finalImageUrl ?? undefined"
              download="edited.jpg"
            />
          </div>

          <div class="rounded-xl overflow-hidden ring-1 ring-default bg-elevated">
            <button
              v-if="previewImageUrl"
              type="button"
              class="block w-full group cursor-zoom-in"
              :disabled="!effectiveResultStep && !latestImageUrl"
              aria-label="Open preview full screen"
              @click="openPreviewLightbox"
            >
              <img
                :src="previewImageUrl"
                :alt="view === 'done' ? 'Final edited image' : 'Live preview of the latest frame'"
                class="w-full max-h-[34rem] object-contain"
              >
            </button>
            <div
              v-else
              class="flex items-center justify-center h-72 text-muted"
            >
              <UIcon
                name="i-lucide-loader-circle"
                class="size-6 animate-spin"
              />
            </div>
          </div>
        </section>

        <USeparator />

        <!-- Supporting timeline strip -->
        <section>
          <div class="flex items-center gap-2 mb-4">
            <h2 class="text-sm font-semibold uppercase tracking-wide text-muted">
              Timeline
            </h2>
            <UBadge
              color="neutral"
              variant="subtle"
              size="sm"
            >
              {{ steps.length }} {{ steps.length === 1 ? 'step' : 'steps' }}
            </UBadge>
          </div>

          <div class="space-y-3">
            <TimelineStep
              v-for="s in steps"
              :key="s.step"
              :step="s"
              :is-result="s.step === effectiveResultStep"
              @open="openLightbox(s.step, s.imageUrl)"
              @continue="continueFrom(s.step)"
              @use-as-result="useAsResult(s.step)"
            />
          </div>
        </section>
      </div>
    </div>

    <!-- Full-screen frame viewer with download + prev/next -->
    <ImageLightbox
      v-model:open="lightboxOpen"
      v-model:index="lightboxIndex"
      :frames="lightboxFrames"
    />
  </UContainer>
</template>
