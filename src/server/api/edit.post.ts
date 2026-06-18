import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import type { DevelopConfig, StepEvent } from '~~/shared/types'
import { storage } from '~~/server/utils/storage'
import { getEngine } from '~~/server/utils/engines'
import { decideConfig, diffConfig, equalConfig } from '~~/server/utils/agent'

interface EditRequestBody {
  id?: string
  intent?: string
  /**
   * Branch point: the frame to continue editing FROM. `'original'` or a step
   * number. When present, the loop's base image is that frame and new frames are
   * numbered AFTER the current max step (append, never overwrite prior frames).
   * Absent → unchanged default: base = `original`, numbering starts at step 1.
   */
  fromStep?: number | 'original'
}

// NOTE: in the parametric model there is no per-step no-op filter — the loop's
// converge guard (model `done`, OR the returned config equals the current one)
// halts the run. The image is always re-rendered from the original, so any slider
// may move up or down freely; only "nothing changed" terminates.

export default defineEventHandler(async (event) => {
  const { id, intent, fromStep } = await readBody<EditRequestBody>(event)
  if (!id || typeof id !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'id is required' })
  }
  if (!intent || typeof intent !== 'string' || !intent.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'intent is required' })
  }

  // The original must exist (session created via /api/session).
  try {
    await storage.read(id, 'original')
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'Session not found' })
  }

  // --- Branch point (Sprint 3) -------------------------------------------------
  // `fromStep` lets a "continue from here" run start from a prior frame. Default
  // (absent) keeps current behavior exactly: base = original, numbering from 1.
  let baseStep: 'original' | number = 'original'
  if (fromStep !== undefined && fromStep !== null) {
    if (fromStep === 'original') {
      baseStep = 'original'
    } else {
      const n = Number(fromStep)
      if (!Number.isInteger(n) || n < 1) {
        throw createError({ statusCode: 400, statusMessage: `Invalid fromStep: ${fromStep}` })
      }
      baseStep = n
    }
    // The chosen base frame must exist.
    try {
      await storage.read(id, baseStep)
    } catch {
      throw createError({ statusCode: 404, statusMessage: `Frame not found: ${baseStep}` })
    }
  }

  // New frames continue numbering AFTER the current max step so a branch appends
  // rather than overwrites. For a default fresh run (no prior steps) this is 0 →
  // numbering starts at 1, identical to before.
  const existingSteps = await storage.listSteps(id)
  const startOffset = existingSteps.length ? Math.max(...existingSteps) : 0

  const runtimeConfig = useRuntimeConfig(event)
  const model = runtimeConfig.agentModel
  // MAX_STEPS = max re-look iterations (each re-renders the full config).
  const MAX_STEPS = parseInt(runtimeConfig.maxSteps) || 30

  // The active develop runner (Sharp / RT-local / RT-sandbox) is chosen by
  // RT_EXECUTION. `dispose(id)` runs in a `finally` so a stateful runner (the
  // future sandbox VM) never leaks even on error/abort.
  const engine = getEngine()

  // Cold-start mitigation: kick off provisioning (sandbox VM create + one-time
  // original upload) concurrently with the first `decideConfig()` vision call so
  // it overlaps the model's first decision. Fire-and-forget, errors swallowed —
  // the first real `renderConfig` re-awaits the same memoized provisioning and
  // surfaces any genuine failure there. No-op for sharp/rt-local (no `warm`).
  engine.warm?.(id, storage.pathFor(id, 'original')).catch(() => {})

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // Emit a `data-step` part. Every part carries a stable `id` of
      // `step-<n>`; the AI SDK reconciles same-id, same-type parts by REPLACING
      // the data in place (see HttpChatTransport stream handler), so a step's
      // `deciding` part is upgraded to `applied`/`done` rather than duplicated —
      // one card per step on the client with no side-buffer needed.
      //
      // NOTE (Sprint 4, Edge 1): `deciding` is now NON-transient. Transient
      // parts are delivered to `onData` only and never land in `message.parts`,
      // which would drop the "Deciding…" spinner from the derived timeline. By
      // persisting it under the same `id`, the spinner shows and is then
      // superseded by the rendered frame via in-place replacement.
      const emit = (data: StepEvent) => {
        writer.write({
          type: 'data-step',
          id: `step-${data.step}`,
          data
        })
      }

      // The agent holds ONE develop config of absolute slider values; the server
      // re-renders the full ordered stack FROM the original every iteration. A
      // branch ("continue from here") seeds from the base step's stored config
      // snapshot — `'original'` (or a missing sidecar) falls back to DEFAULT_CONFIG,
      // identical to a fresh run.
      let currentConfig: DevelopConfig = await storage.readConfig(id, baseStep)
      let currentPath = storage.pathFor(id, baseStep)
      let editCount = 0 // configs actually rendered (for the cap-hit summary)
      let lastStep = startOffset // last frame number we emitted
      // The result frame to fall back to. When branching, the base frame itself is
      // a valid prior result; when starting fresh from original it's 0 (none yet).
      let lastAppliedStep = baseStep === 'original' ? 0 : baseStep

      // `iter` is the re-look iteration (1..MAX_STEPS); `step` is the actual frame
      // number, continued after any existing frames so branches append. The whole
      // loop is wrapped so `engine.dispose(id)` always runs (a stateful sandbox
      // runner must release its per-session VM even on early return / abort).
      try {
        for (let iter = 1; iter <= MAX_STEPS; iter++) {
          const step = startOffset + iter
          lastStep = step
          try {
            const decision = await decideConfig(
              {
                originalPath: storage.pathFor(id, 'original'),
                currentPath,
                intent,
                currentConfig
              },
              model
            )

            const next = decision.config

            // Ephemeral "deciding" card update — chips show this step's diff.
            emit({
              step,
              status: 'deciding',
              assessment: decision.assessment,
              goal: decision.goal,
              operations: diffConfig(currentConfig, next),
              reason: decision.reason,
              phase: decision.phase
            })

            // Converged: model says done, OR the returned config is identical to
            // the current one (nothing left to change). Keep the last applied frame.
            if (decision.done || equalConfig(next, currentConfig)) {
              emit({
                step,
                status: 'done',
                assessment: decision.assessment,
                goal: decision.goal,
                reason: decision.reason,
                phase: decision.phase,
                imageUrl: lastAppliedStep > 0
                  ? `/api/image/${id}/${lastAppliedStep}?t=${Date.now()}`
                  : undefined
              })
              return
            }

            // Render the FULL config from the original — no compounding.
            const prevConfig = currentConfig
            const buf = await engine.renderConfig({
              sessionId: id,
              originalPath: storage.pathFor(id, 'original'),
              config: next
            })
            await storage.writeStep(id, step, buf)
            await storage.writeConfig(id, step, next)
            currentConfig = next
            currentPath = storage.pathFor(id, step)
            lastAppliedStep = step
            editCount++

            emit({
              step,
              status: 'applied',
              // Cache-buster: intermediates are served no-store, but this avoids any
              // stale-render edge cases if a step number is ever reused.
              imageUrl: `/api/image/${id}/${step}?t=${Date.now()}`,
              assessment: decision.assessment,
              goal: decision.goal,
              operations: diffConfig(prevConfig, next),
              config: next,
              reason: decision.reason,
              phase: decision.phase
            })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            emit({
              step,
              status: 'error',
              error: message
            })
            return
          }
        }

        // Cap hit without an explicit done — close out with a terminal step so the
        // client clearly knows the run ended at the cap. Final = last applied frame.
        emit({
          step: lastStep + 1,
          status: 'done',
          assessment: `Reached the ${MAX_STEPS}-iteration limit with ${editCount} renders applied.`,
          reason: 'Stopping at the iteration cap; the last applied frame is the final result.',
          imageUrl: lastAppliedStep > 0
            ? `/api/image/${id}/${lastAppliedStep}?t=${Date.now()}`
            : undefined
        })
      } finally {
        await engine.dispose(id)
      }
    }
  })

  return createUIMessageStreamResponse({ stream })
})
