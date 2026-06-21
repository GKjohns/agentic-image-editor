<script setup lang="ts">
import { Chat } from '@ai-sdk/vue'
import { DefaultChatTransport } from 'ai'
import type { UIMessage } from 'ai'
import type { StepEvent } from '#shared/types'
import type { FilmstripFrame } from '~/components/Filmstrip.vue'

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

// --- Input state (source image + intent + samples) ---------------------------
const { file, previewUrl, intent, samples, loadSample, onFileChange, onInputFile, canRun } = useImageInput()

// A run is in flight while the SDK is submitting or streaming.
const running = computed(() => chat.status === 'submitted' || chat.status === 'streaming')
// Surface our own session/transport errors plus any SDK stream error.
const localError = ref<string | null>(null)
const errorMessage = computed(() => localError.value ?? chat.error?.message ?? null)

// --- Session + branch state --------------------------------------------------
// Persist the session id so "continue from here" branch runs reuse the same
// session (appending frames) instead of creating a fresh one.
const sessionId = ref<string | null>(null)
// When set, the next run() branches FROM this step (sent to /api/edit as
// `fromStep`) and APPENDS to the timeline instead of wiping it.
const fromStep = ref<number | null>(null)

// --- Timeline (derived from the useChat message stream) ----------------------
// Owns the step derivation + the "result frame" override (download target).
const {
  steps,
  appliedSteps,
  lastAppliedStep,
  resultStep,
  effectiveResultStep,
  useAsResult,
  undoLastStep
} = useEditTimeline(() => chat.messages)

// --- View state --------------------------------------------------------------
// 'setup'   → no run yet: input panel is the hero, centered + roomy.
// 'running' → a run is in flight: input collapses, large live preview takes over.
// 'done'    → run finished: final image + Download, input still collapsed.
const view = computed<'setup' | 'running' | 'done'>(() => {
  if (running.value) return 'running'
  if (steps.value.length > 0) return 'done'
  return 'setup'
})

// --- Cockpit selection + pin rule (Sprint 1) ---------------------------------
// `selectedStep` is which frame the cockpit (stage/filmstrip/rail) is focused on
// — distinct from `resultStep` (the download target). `userPinned` governs
// auto-follow: auto-follow is ON whenever `userPinned` is false.
//   - while running && !userPinned: selectedStep tracks lastAppliedStep.
//   - on running→done && !userPinned: selectedStep = effectiveResultStep.
// `userPinned` is set true by clicking a frame (Sprint 2/3); it is cleared by
// EXACTLY two actions: starting a new run() and "Jump to latest" (Sprint 2).
// Nothing else touches it — so a pin set mid-run survives the done transition.
const selectedStep = ref<number | 'original' | null>(null)
const userPinned = ref(false)

// Follow the latest applied frame while running (unless the user has pinned).
watch(lastAppliedStep, (step) => {
  if (running.value && !userPinned.value && step !== null) {
    selectedStep.value = step
  }
})

// On the running→done transition, settle the selection on the result frame
// (unless the user pinned a specific frame mid-run — the pin wins).
watch(running, (now, was) => {
  if (was && !now && !userPinned.value) {
    selectedStep.value = effectiveResultStep.value
  }
})

// The active (latest streaming) step — drives the stage's working caption
// independently of `selectedStep`, so scrubbing back never hides progress.
const activeStep = computed<StepEvent | null>(() => {
  const all = steps.value
  return all.length ? all[all.length - 1]! : null
})

// The image shown on the stage = the selected frame's image. Before the first
// applied frame exists (lastAppliedStep === null) we fall back to the original
// (or the local preview) so the stage is never blank during the first
// "deciding" beat — preserving today's previewImageUrl behaviour.
const selectedImageUrl = computed(() => {
  const localOriginal = sessionId.value
    ? `/api/image/${sessionId.value}/original`
    : previewUrl.value

  const sel = selectedStep.value
  if (sel === null || sel === 'original') {
    // null before the first applied frame, or an explicit "original" selection.
    if (sel === null && lastAppliedStep.value !== null) {
      // We have frames but no selection yet — show the latest applied frame.
      return appliedSteps.value.find(s => s.step === lastAppliedStep.value)?.imageUrl ?? localOriginal
    }
    return localOriginal
  }
  return appliedSteps.value.find(s => s.step === sel)?.imageUrl ?? localOriginal
})

// Whether the frame on the stage is the current result (download target).
const selectedIsResult = computed(() => {
  const sel = selectedStep.value
  return sel !== null && sel !== 'original' && sel === effectiveResultStep.value
})

// The develop config of the frame currently on the stage — used to draw the crop
// rectangle in the grid overlay so the human sees the agent's crop. `null` on the
// original (no crop applied yet) so the overlay shows the plain thirds grid.
const selectedConfig = computed(() => {
  const sel = selectedStep.value
  if (sel === null || sel === 'original') {
    // No explicit frame: while running, reflect the latest applied frame's config.
    if (sel === null && lastAppliedStep.value !== null) {
      return appliedSteps.value.find(s => s.step === lastAppliedStep.value)?.config ?? null
    }
    return null
  }
  return appliedSteps.value.find(s => s.step === sel)?.config ?? null
})

// The crop keep-rectangle (normalized) for the overlay, or null when the frame is
// uncropped (full frame) — GridOverlay then draws just the thirds grid.
const selectedCrop = computed(() => {
  const c = selectedConfig.value
  if (!c) return null
  return { left: c.cropLeft, top: c.cropTop, width: c.cropWidth, height: c.cropHeight }
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
  selectedStep.value = null
  userPinned.value = false
}

// --- Command bar + mobile rail (Sprint 4) ------------------------------------
// Template ref to the command bar so "continue from here" can focus its input.
const commandBar = ref<{ focus: () => void } | null>(null)
// On < lg the rail lives behind a toggle (a slideover) so mobile isn't a wall of
// panels — the stage + command bar stay visible. Desktop ignores this flag (the
// rail is always shown in the grid via `lg:flex`).
const railOpen = ref(false)

// --- Lightbox ----------------------------------------------------------------
// Full-screen frame viewer (original → applied steps). Aliased to the template's
// existing `lightbox*` / `openStageLightbox` bindings.
const {
  open: lightboxOpen,
  index: lightboxIndex,
  frames: lightboxFrames,
  openStage: openStageLightbox
} = useLightbox({
  sessionId: () => sessionId.value,
  previewUrl: () => previewUrl.value,
  appliedSteps: () => appliedSteps.value,
  selectedStep: () => selectedStep.value,
  effectiveResultStep: () => effectiveResultStep.value
})

// Frames for the filmstrip: the same original → applied-step ordering as the
// lightbox, but carrying the `step` id the strip selects/branches/flags on.
const filmstripFrames = computed<FilmstripFrame[]>(() => {
  const frames: FilmstripFrame[] = []
  const original = sessionId.value
    ? `/api/image/${sessionId.value}/original`
    : previewUrl.value
  if (original) {
    frames.push({ step: 'original', imageUrl: original, label: 'Original' })
  }
  for (const s of appliedSteps.value) {
    frames.push({ step: s.step, imageUrl: s.imageUrl!, label: `Step ${s.step}` })
  }
  return frames
})

// --- Cockpit selection actions (Sprint 2) ------------------------------------
/**
 * Select a filmstrip/rail frame: pin the cockpit to it. Per the single pin rule,
 * clicking a frame is what SETS `userPinned` — so the stage stops auto-following
 * the latest frame and stays on this one (the caption still shows the agent
 * working). The pin is cleared only by "Jump to latest" or starting a new run.
 */
function selectFrame(step: number | 'original') {
  selectedStep.value = step
  userPinned.value = true
}

/**
 * Keyboard scrubbing: ←/→ move the selection one frame through the filmstrip
 * (original → applied steps) when the stage is focused. Pins on first use (like
 * a click), so arrowing back stops auto-follow just as clicking a thumb does.
 */
function scrubFrame(delta: number) {
  const frames = filmstripFrames.value
  if (!frames.length) return
  const current = selectedStep.value ?? effectiveResultStep.value ?? frames[0]!.step
  let idx = frames.findIndex(f => f.step === current)
  if (idx < 0) idx = frames.length - 1
  const next = frames[Math.min(frames.length - 1, Math.max(0, idx + delta))]
  if (next) selectFrame(next.step)
}

function onStageKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    scrubFrame(-1)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    scrubFrame(1)
  }
}

/**
 * "Jump to latest": clear the pin so auto-follow resumes (one of the two actions
 * that may clear `userPinned`, the other being a new run()). We snap the
 * selection to the latest frame now so the stage updates immediately rather than
 * waiting for the next applied frame.
 */
function jumpToLatest() {
  userPinned.value = false
  selectedStep.value = running.value
    ? (lastAppliedStep.value ?? 'original')
    : effectiveResultStep.value
}

// --- Branch / result actions (Sprint 3) --------------------------------------
/**
 * "Continue from here": branch a new run off `step`, appending frames. Sets the
 * branch point (surfaced as the command bar's "Continuing from Step N" chip) +
 * clears the result override, then focuses the command bar's intent input so the
 * user can immediately type the steering instruction.
 */
function continueFrom(step: number) {
  fromStep.value = step
  resultStep.value = null
  nextTick(() => commandBar.value?.focus())
}

// `useAsResult` / `undoLastStep` now live in useEditTimeline (result-frame owner).
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

  // Starting a run clears the pin so the stage auto-follows the new frames.
  userPinned.value = false

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

// --- Interrupt-and-steer (Sprint 4) ------------------------------------------
// Re-entrancy guard: true from the moment an interrupt begins until the new run
// has been kicked off. A second send() while mid-settle is ignored, so a rapid
// double-tap (or Enter-spam) can't spawn two overlapping runs.
const steering = ref(false)

/**
 * Wait for the SDK to actually settle out of an in-flight state after stop().
 *
 * `chat.stop()` aborts the transport but `chat.status` doesn't flip to a settled
 * value synchronously — the SDK finishes tearing down the stream first. We must
 * NOT start the next run until it has, or the new sendMessage() races the aborting
 * one (two streams, interleaved `data-step` parts, frame numbers that don't append
 * cleanly). So instead of guessing a fixed timeout, we WATCH the reactive status
 * and resolve the moment it's no longer 'submitted'/'streaming'. A safety timeout
 * is a fallback only — if the status somehow never settles we proceed anyway
 * rather than hang the steer forever.
 */
function waitForSettled(timeoutMs = 4000): Promise<void> {
  // Already settled — nothing to wait for.
  if (chat.status !== 'submitted' && chat.status !== 'streaming') {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      unwatch()
      clearTimeout(timer)
      resolve()
    }
    const unwatch = watch(
      () => chat.status,
      (status) => {
        if (status !== 'submitted' && status !== 'streaming') finish()
      }
    )
    // Safety net: never block the steer indefinitely on a stuck status.
    const timer = setTimeout(finish, timeoutMs)
  })
}

/**
 * The command bar's single action. "Send" means different things by state:
 *   - NOT running → behaves like run(): a fresh run, or (after a finished run)
 *     a refinement that continues from the result frame. run() already derives
 *     the right branch base, so we just call it.
 *   - running → INTERRUPT-AND-STEER: stop the live run and continue from the
 *     frame currently on the stage with the new instruction, so frames APPEND
 *     from where the user stopped rather than restarting from the original.
 */
async function send() {
  // Ignore re-entrant sends while an interrupt is still settling.
  if (steering.value) return

  if (!running.value) {
    await run()
    return
  }

  // --- Interrupt-and-steer ---------------------------------------------------
  // 1) Capture the new instruction + the branch base BEFORE we stop, since the
  //    user-visible selection can shift as the aborting stream tears down. The
  //    base is the on-stage frame: the user's pin, else the result, else original.
  const branchBase = selectedStep.value ?? effectiveResultStep.value ?? 'original'
  steering.value = true
  try {
    // 2) Halt the current run.
    stop()
    // 3) Wait for the SDK to settle out of submitted/streaming (watch-based, not
    //    a guessed timeout) so the new run doesn't race the aborting one.
    await waitForSettled()
    // 4) Point the next run at the captured base and run() — frames APPEND from
    //    there. 'original' (no frames yet) means a plain fresh re-run.
    fromStep.value = typeof branchBase === 'number' ? branchBase : null
    await run()
  } finally {
    steering.value = false
  }
}
</script>

<template>
  <UContainer class="py-6">
    <!-- SETUP HEADER: onboarding title + subtitle (setup view only). In the
         editing view this block is gone — the global UHeader carries the name
         and a slim in-page toolbar (below) holds the actions. -->
    <div
      v-if="view === 'setup'"
      class="mb-6 max-w-3xl mx-auto"
    >
      <h1 class="text-2xl sm:text-3xl font-bold text-highlighted">
        Agentic Image Editor
      </h1>
      <p class="mt-2 text-muted">
        Drop an image, describe the edit, watch an AI agent do it step by step.
      </p>
    </div>

    <!-- EDITING TOOLBAR: a slim single-line action row directly above the grid
         (replaces the old in-page header). Compact, shrink-0, right-aligned;
         shown only once a run has started. -->
    <div
      v-else
      class="mb-3 max-w-6xl mx-auto flex items-center justify-end gap-2 shrink-0"
    >
      <!-- Mobile-only: open the agent rail (hidden in the grid on < lg). -->
      <UButton
        icon="i-lucide-list"
        label="Steps"
        color="neutral"
        variant="subtle"
        size="sm"
        class="lg:hidden"
        @click="railOpen = true"
      />
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
        icon="i-lucide-image-plus"
        label="New image"
        color="neutral"
        variant="ghost"
        size="sm"
        @click="newImage"
      />
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

    <!-- RUNNING / DONE: the cockpit. A viewport-bounded grid so the stage stays
         fixed while the rail/filmstrip scroll internally instead of the whole
         page scrolling. Main column = stage (top) + filmstrip (beneath); right
         column = the agent rail (a slideover on < lg); the command bar is pinned
         below. On < lg the columns stack (stage → filmstrip → command bar) and
         the rail moves behind the header "Steps" toggle. -->
    <div
      v-else
      class="max-w-6xl mx-auto flex flex-col gap-4 lg:h-[calc(100vh-13.5rem)]"
    >
      <div class="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_20rem] gap-4">
        <!-- Main column: stage on top, filmstrip beneath -->
        <div class="flex flex-col gap-4 min-h-0">
          <!-- The live stage (fixed; selected frame + working caption). Focusable
               so ←/→ scrub the filmstrip when the stage has focus. -->
          <div
            class="flex-1 min-h-0 min-h-[16rem] focus:outline-none"
            tabindex="0"
            @keydown="onStageKeydown"
          >
            <EditorStage
              :image-url="selectedImageUrl"
              :running="running"
              :view="view"
              :active-step="activeStep"
              :is-result="selectedIsResult"
              :crop="selectedCrop"
              @open="openStageLightbox"
            />
          </div>

          <!-- Filmstrip: every frame, click to scrub/pin, ⑂ to branch. A
               "Jump to latest" button clears the pin so auto-follow resumes
               (one of only two actions that clear `userPinned`). -->
          <div class="shrink-0 flex items-stretch gap-2">
            <div class="flex-1 min-w-0">
              <Filmstrip
                :frames="filmstripFrames"
                :selected-step="selectedStep"
                :result-step="effectiveResultStep"
                :running="running"
                @select="selectFrame"
                @branch="continueFrom"
                @use-as-result="useAsResult"
              />
            </div>
            <UButton
              v-if="userPinned"
              icon="i-lucide-chevrons-right"
              label="Jump to latest"
              color="neutral"
              variant="subtle"
              size="sm"
              class="shrink-0 self-center"
              @click="jumpToLatest"
            />
          </div>
        </div>

        <!-- Right rail (desktop, in-grid): the scrollable agent/history list.
             Selecting a row pins the cockpit to that frame (drives stage +
             filmstrip via the shared `selectedStep` + `selectFrame`);
             branch/result reuse the existing continueFrom/useAsResult actions.
             Scrolls internally + auto-follows the active row while running.
             Hidden on < lg (the rail is `hidden lg:flex`); mobile gets the
             slideover below via the header "Steps" toggle. -->
        <AgentRail
          :steps="steps"
          :selected-step="selectedStep"
          :active-step="activeStep"
          :result-step="effectiveResultStep"
          @select="selectFrame"
          @continue="continueFrom"
          @use-as-result="useAsResult"
        />
      </div>

      <!-- Command bar (pinned below): persistent intent input + Send (Steer while
           running) + an always-visible Stop. Shares index.vue's `intent` ref with
           the setup InputPanel, and `fromStep` so its chip can clear the branch
           point. Send routes through send() — fresh run / refinement / steer. -->
      <CommandBar
        ref="commandBar"
        v-model:intent="intent"
        v-model:from-step="fromStep"
        :running="running"
        :can-run="canRun"
        :error-message="errorMessage"
        @send="send"
        @stop="stop"
      />
    </div>

    <!-- Mobile rail: the same agent list behind a slideover so < lg isn't a wall
         of panels (stage + command bar stay visible; "Steps" in the header opens
         this). The inner AgentRail is `hidden lg:flex`, so we override its
         visibility within the slideover body with a wrapper. -->
    <USlideover
      v-model:open="railOpen"
      title="Agent steps"
      side="right"
    >
      <template #body>
        <!-- The inner AgentRail root is `hidden lg:flex` for the desktop grid;
             inside the slideover we force it visible (!flex beats `hidden`) and
             full-height so the list scrolls within the drawer. -->
        <div class="h-full [&>div]:!flex [&>div]:h-full [&>div]:ring-0">
          <AgentRail
            :steps="steps"
            :selected-step="selectedStep"
            :active-step="activeStep"
            :result-step="effectiveResultStep"
            @select="selectFrame"
            @continue="continueFrom"
            @use-as-result="useAsResult"
          />
        </div>
      </template>
    </USlideover>

    <!-- Full-screen frame viewer with download + prev/next -->
    <ImageLightbox
      v-model:open="lightboxOpen"
      v-model:index="lightboxIndex"
      :frames="lightboxFrames"
    />
  </UContainer>
</template>
