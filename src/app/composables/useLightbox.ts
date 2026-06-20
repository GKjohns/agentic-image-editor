import type { StepEvent } from '#shared/types'
import type { LightboxFrame } from '~/components/ImageLightbox.vue'

interface LightboxDeps {
  /** Active session id (drives the `/api/image/<id>/original` URL), or null. */
  sessionId: () => string | null
  /** Local object-URL preview before a session exists, or null. */
  previewUrl: () => string | null
  /** Applied frames, in order — the frames after Original. */
  appliedSteps: () => StepEvent[]
  /** The cockpit's currently selected frame. */
  selectedStep: () => number | 'original' | null
  /** The current result frame (download target / big preview). */
  effectiveResultStep: () => number | null
}

/**
 * Full-screen frame viewer state: open/index plus the original → applied-step
 * frame list, and the helpers that resolve a clicked thumbnail to the right
 * index (by the IMAGE it shows first, label as fallback).
 */
export function useLightbox(deps: LightboxDeps) {
  const open = ref(false)
  const index = ref(0)

  // Frames for the viewer + prev/next paging: original → each applied step.
  const frames = computed<LightboxFrame[]>(() => {
    const out: LightboxFrame[] = []
    const sessionId = deps.sessionId()
    const preview = deps.previewUrl()
    if (sessionId) {
      out.push({ imageUrl: `/api/image/${sessionId}/original`, label: 'Original' })
    } else if (preview) {
      out.push({ imageUrl: preview, label: 'Original' })
    }
    for (const s of deps.appliedSteps()) {
      out.push({
        imageUrl: s.imageUrl!,
        label: `Step ${s.step}`,
        goal: s.goal,
        operations: s.operations
      })
    }
    return out
  })

  /** Strip the `?t=` cache-buster so two URLs for the same frame compare equal. */
  function framePath(url?: string): string {
    return url ? url.split('?')[0]! : ''
  }

  /**
   * Open the viewer on a given frame. We resolve the index by the IMAGE the
   * thumbnail is actually showing (`imageUrl` path) first, so the modal always
   * matches the clicked thumbnail — this is what makes the terminal `done` card
   * (whose `step` number has no own frame; its image aliases the last applied
   * frame) open the right image instead of silently falling back to Original.
   * The `Step N` / `Original` label is a fallback when no imageUrl is given.
   */
  function openAt(step: number | 'original', imageUrl?: string) {
    let idx = -1
    if (imageUrl) {
      const target = framePath(imageUrl)
      idx = frames.value.findIndex(f => framePath(f.imageUrl) === target)
    }
    if (idx < 0) {
      idx = step === 'original'
        ? frames.value.findIndex(f => f.label === 'Original')
        : frames.value.findIndex(f => f.label === `Step ${step}`)
    }
    index.value = idx >= 0 ? idx : 0
    open.value = true
  }

  /** Open the viewer on whatever the stage currently shows (by image path). */
  function openStage(imageUrl: string | null) {
    const sel = deps.selectedStep()
    openAt(sel ?? deps.effectiveResultStep() ?? 'original', imageUrl ?? undefined)
  }

  return { open, index, frames, openAt, openStage }
}
