<script setup lang="ts">
import type { StepEvent } from '#shared/types'

// --- Input state -------------------------------------------------------------
const file = ref<File | null>(null)
const previewUrl = ref<string | null>(null)
const intent = ref('')
const running = ref(false)
const errorMessage = ref<string | null>(null)

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

// --- Timeline (live, keyed by step) -----------------------------------------
const stepMap = ref<Map<number, StepEvent>>(new Map())
const steps = computed(() => [...stepMap.value.values()].sort((a, b) => a.step - b.step))

// The final image is the last `applied` step's image (the terminal `done` step
// carries no image — fall back to the previous applied step).
const finalImageUrl = computed(() => {
  const applied = steps.value.filter(s => s.status === 'applied' && s.imageUrl)
  return applied.length ? applied[applied.length - 1]!.imageUrl ?? null : null
})

const showFinal = computed(() => !running.value && !!finalImageUrl.value)

let controller: AbortController | null = null

/** Merge an incoming StepEvent into the per-step card. */
function mergeStep(event: StepEvent) {
  const existing = stepMap.value.get(event.step)
  const merged: StepEvent = existing ? { ...existing, ...event } : event
  // A later `applied`/`done` shouldn't be clobbered back to `deciding` if events
  // somehow arrive out of order; otherwise take the newest status.
  stepMap.value.set(event.step, merged)
  // Trigger reactivity on the Map.
  stepMap.value = new Map(stepMap.value)
}

/** Parse the SSE UI-message stream, dispatching every `data-step` part. */
async function readStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // SSE frames are separated by a blank line.
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''

    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let chunk: { type?: string, data?: StepEvent }
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue
        }
        if (chunk.type === 'data-step' && chunk.data) {
          mergeStep(chunk.data)
        }
      }
    }
  }
}

async function run() {
  if (!canRun.value || running.value) return
  running.value = true
  errorMessage.value = null
  stepMap.value = new Map()
  controller = new AbortController()

  try {
    // 1. Create a session from the uploaded image.
    const form = new FormData()
    form.append('image', file.value!)
    const session = await $fetch<{ id: string }>('/api/session', {
      method: 'POST',
      body: form,
      signal: controller.signal
    })

    // 2. Run the edit; stream the step events back via a plain fetch.
    const res = await fetch('/api/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: session.id, intent: intent.value }),
      signal: controller.signal
    })

    if (!res.ok || !res.body) {
      throw new Error(`Edit request failed (${res.status})`)
    }

    await readStream(res.body)
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      // User-initiated stop; not an error.
    } else {
      errorMessage.value = error instanceof Error ? error.message : String(error)
    }
  } finally {
    running.value = false
    controller = null
  }
}

function stop() {
  controller?.abort()
  running.value = false
}
</script>

<template>
  <UContainer class="py-8 sm:py-12">
    <div class="max-w-3xl mx-auto mb-8 sm:mb-10">
      <h1 class="text-2xl sm:text-3xl font-bold text-highlighted">
        Agentic Image Editor
      </h1>
      <p class="mt-2 text-muted">
        Drop an image, describe the edit, watch an AI agent do it step by step.
      </p>
    </div>

    <div class="grid lg:grid-cols-5 gap-6 lg:gap-8 max-w-6xl mx-auto">
      <!-- Input panel -->
      <div class="lg:col-span-2">
        <UCard class="lg:sticky lg:top-8">
          <div class="space-y-5">
            <!-- Dropzone -->
            <div>
              <label class="block text-sm font-medium text-default mb-2">Image</label>

              <div
                v-if="previewUrl"
                class="relative group rounded-lg overflow-hidden ring-1 ring-default"
              >
                <img
                  :src="previewUrl"
                  alt="Selected image preview"
                  class="w-full h-48 object-cover"
                >
                <UButton
                  icon="i-lucide-x"
                  color="neutral"
                  variant="solid"
                  size="xs"
                  class="absolute top-2 right-2"
                  aria-label="Remove image"
                  @click="onFileChange(null)"
                />
              </div>

              <label
                v-else
                class="flex flex-col items-center justify-center gap-2 h-48 rounded-lg border-2 border-dashed border-default bg-elevated/40 hover:bg-elevated/70 transition-colors cursor-pointer text-center px-4"
              >
                <UIcon
                  name="i-lucide-image-up"
                  class="size-8 text-dimmed"
                />
                <span class="text-sm text-muted">
                  Drop an image or <span class="text-primary font-medium">browse</span>
                </span>
                <span class="text-xs text-dimmed">PNG, JPG, WebP</span>
                <input
                  type="file"
                  accept="image/*"
                  class="sr-only"
                  @change="onInputFile"
                >
              </label>

              <!-- Sample images for users without a photo handy -->
              <div
                v-if="!previewUrl"
                class="mt-3"
              >
                <p class="text-xs text-dimmed mb-2">
                  No image? Try a sample:
                </p>
                <div class="grid grid-cols-5 gap-2">
                  <button
                    v-for="sample in samples"
                    :key="sample.src"
                    type="button"
                    class="group relative rounded-md overflow-hidden ring-1 ring-default hover:ring-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary transition"
                    :title="sample.label"
                    @click="loadSample(sample)"
                  >
                    <img
                      :src="sample.src"
                      :alt="sample.label"
                      class="w-full h-12 object-cover"
                    >
                  </button>
                </div>
              </div>
            </div>

            <!-- Intent -->
            <div>
              <label class="block text-sm font-medium text-default mb-2">Edit intent</label>
              <UTextarea
                v-model="intent"
                :rows="3"
                autoresize
                class="w-full"
                placeholder="e.g. straighten the horizon, warm it up, lift the shadows"
              />
            </div>

            <!-- Actions -->
            <div class="flex items-center gap-2">
              <UButton
                v-if="!running"
                icon="i-lucide-sparkles"
                label="Run"
                color="primary"
                :disabled="!canRun"
                block
                @click="run"
              />
              <template v-else>
                <UButton
                  icon="i-lucide-loader-circle"
                  label="Running…"
                  color="primary"
                  variant="soft"
                  :ui="{ leadingIcon: 'animate-spin' }"
                  block
                  disabled
                />
                <UButton
                  icon="i-lucide-square"
                  label="Stop"
                  color="neutral"
                  variant="subtle"
                  @click="stop"
                />
              </template>
            </div>

            <UAlert
              v-if="errorMessage"
              color="error"
              variant="subtle"
              :title="errorMessage"
              icon="i-lucide-triangle-alert"
            />
          </div>
        </UCard>
      </div>

      <!-- Timeline + final -->
      <div class="lg:col-span-3 space-y-6">
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
              {{ steps.length }} steps
            </UBadge>
          </div>

          <div
            v-if="steps.length"
            class="space-y-3"
          >
            <TimelineStep
              v-for="s in steps"
              :key="s.step"
              :step="s"
            />
          </div>

          <UCard
            v-else
            variant="subtle"
          >
            <p class="text-sm text-muted text-center py-6">
              Run an edit to watch the agent's steps appear here.
            </p>
          </UCard>
        </section>

        <USeparator v-if="showFinal" />

        <!-- Final image -->
        <section v-if="showFinal">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-sm font-semibold uppercase tracking-wide text-muted">
              Final result
            </h2>
            <UButton
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
            <img
              :src="finalImageUrl!"
              alt="Final edited image"
              class="w-full max-h-[28rem] object-contain"
            >
          </div>
        </section>
      </div>
    </div>
  </UContainer>
</template>
