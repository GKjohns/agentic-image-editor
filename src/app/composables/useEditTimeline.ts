import type { UIMessage } from 'ai'
import type { StepEvent } from '#shared/types'

/**
 * The editing timeline, derived from the useChat message stream.
 *
 * Every server-emitted `data-step` part lands in `message.parts` (deciding is
 * non-transient — see edit.post.ts Edge 1). The SDK already de-dupes parts by
 * their stable `step-N` id (replacing data in place), but a refinement turn
 * produces a NEW assistant message, so we flatten across ALL messages and keep
 * the last event per step number (later status — applied/done — wins).
 *
 * Also owns the "result frame" override (the download target / big preview) and
 * the actions that move it.
 *
 * @param messages getter for the reactive `chat.messages` list (read inside the
 *   computed so it tracks updates).
 */
export function useEditTimeline(messages: () => UIMessage[]) {
  const steps = computed<StepEvent[]>(() => {
    const byStep = new Map<number, StepEvent>()
    for (const message of messages()) {
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

  // Manual override of which step is the "result" (download target / big
  // preview). null → default = last applied frame.
  const resultStep = ref<number | null>(null)

  // The effective result step honours a manual `resultStep` override (used by
  // "Use this as result" and "Undo last step"), else the last applied frame.
  const effectiveResultStep = computed(() => resultStep.value ?? lastAppliedStep.value)

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

  return {
    steps,
    appliedSteps,
    lastAppliedStep,
    resultStep,
    effectiveResultStep,
    useAsResult,
    undoLastStep
  }
}
