import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import type { Operation, Phase, StepEvent } from '~~/shared/types'
import { storage } from '~~/server/utils/storage'
import { executor } from '~~/server/utils/executor'
import { decideNextBatch, type HistoryEntry } from '~~/server/utils/agent'

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

/** Soft prior the planner is biased to move through (not enforced). */
const PHASE_ORDER: Phase[] = ['straighten', 'exposure', 'tone', 'color', 'creative', 'finish']

/**
 * True when an operation's params are effectively identity (no visible change),
 * so applying it would burn a step for nothing. Identity per tool:
 *   straighten angle≈0; exposure ev≈0; contrast/vibrance/sharpen amount≈0;
 *   saturation amount≈1; tone both≈0; whiteBalance both≈0.
 * (look has no identity — a named grade always does something.)
 */
function isNoOp(op: Operation): boolean {
  const p = op.params
  const z = (v: unknown, eps = 1e-3) => Math.abs(Number(v) || 0) <= eps
  switch (op.tool) {
    case 'straighten': return z(p.angleDeg, 0.05)
    case 'exposure': return z(p.ev, 0.02)
    case 'contrast': return z(p.amount, 0.02)
    case 'vibrance': return z(p.amount, 0.02)
    case 'sharpen': return z(p.amount, 0.02)
    case 'saturation': return Math.abs((Number(p.amount) || 1) - 1) <= 0.02
    case 'tone': return z(p.highlights, 0.5) && z(p.shadows, 0.5)
    case 'whiteBalance': return z(p.temp, 0.5) && z(p.tint, 0.5)
    case 'look': return false
  }
}

// NOTE (Sprint 1): the cross-batch flip-flop / reversal guardrail was REMOVED for
// the batching model. With multi-op batches, a same-tool sign flip across batches
// is often legitimate convergence and is hard to judge cheaply. For v1 we rely on
// the model's own done-judgment plus the MAX_STEPS iteration cap to halt, and keep
// only the no-op guard below (an empty / all-identity batch ends the run).

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
  // MAX_STEPS = max re-look iterations (each iteration applies a batch of ops).
  const MAX_STEPS = parseInt(runtimeConfig.maxSteps) || 30
  // Per-batch hard cap on operations (over-cap lines are dropped server-side).
  const MAX_OPS_PER_BATCH = parseInt(runtimeConfig.maxOpsPerBatch) || 6

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // Emit a `data-step` part. `deciding` events are transient (ephemeral
      // progress); `applied`/`done`/`error` persist. An `id` lets the client
      // merge the persisted parts into one card per step.
      const emit = (data: StepEvent, transient = false) => {
        writer.write({
          type: 'data-step',
          id: `step-${data.step}`,
          data,
          transient
        })
      }

      let currentPath = storage.pathFor(id, baseStep)
      const history: HistoryEntry[] = []
      let lastStep = startOffset // last frame number we emitted
      // The result frame to fall back to. When branching, the base frame itself is
      // a valid prior result; when starting fresh from original it's 0 (none yet).
      let lastAppliedStep = baseStep === 'original' ? 0 : baseStep

      // `iter` is the re-look iteration (1..MAX_STEPS); `step` is the actual frame
      // number, continued after any existing frames so branches append.
      for (let iter = 1; iter <= MAX_STEPS; iter++) {
        const step = startOffset + iter
        lastStep = step
        try {
          const decision = await decideNextBatch(
            {
              originalPath: storage.pathFor(id, 'original'),
              currentPath,
              intent,
              history,
              phasePrior: PHASE_ORDER
            },
            model,
            MAX_OPS_PER_BATCH
          )

          // Ephemeral "deciding" card update (batch-shaped).
          emit({
            step,
            status: 'deciding',
            assessment: decision.assessment,
            goal: decision.goal,
            operations: decision.operations,
            reason: decision.reason,
            phase: decision.phase
          }, true)

          // Model stopped (done, or an empty parsed batch → safe stop).
          if (decision.done || decision.operations.length === 0) {
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

          // --- Guardrail: no-op batch. Every op in the batch is effectively
          // identity → applying it would burn an iteration for nothing. Stop,
          // keeping the last applied frame.
          const effectiveOps = decision.operations.filter(op => !isNoOp(op))
          if (effectiveOps.length === 0) {
            emit({
              step,
              status: 'done',
              assessment: decision.assessment,
              goal: decision.goal,
              reason: `${decision.reason} (chosen batch had no effect — stopping)`,
              phase: decision.phase,
              imageUrl: lastAppliedStep > 0
                ? `/api/image/${id}/${lastAppliedStep}?t=${Date.now()}`
                : undefined
            })
            return
          }

          const buf = await executor.applyBatch(currentPath, effectiveOps)
          await storage.writeStep(id, step, buf)
          currentPath = storage.pathFor(id, step)
          lastAppliedStep = step

          emit({
            step,
            status: 'applied',
            // Cache-buster: intermediates are served no-store, but this avoids any
            // stale-render edge cases if a step number is ever reused.
            imageUrl: `/api/image/${id}/${step}?t=${Date.now()}`,
            assessment: decision.assessment,
            goal: decision.goal,
            operations: effectiveOps,
            reason: decision.reason,
            phase: decision.phase
          })

          for (const op of effectiveOps) {
            history.push({ tool: op.tool, params: op.params })
          }
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
        assessment: `Reached the ${MAX_STEPS}-iteration limit with ${history.length} edits applied.`,
        reason: 'Stopping at the iteration cap; the last applied frame is the final result.',
        imageUrl: lastAppliedStep > 0
          ? `/api/image/${id}/${lastAppliedStep}?t=${Date.now()}`
          : undefined
      })
    }
  })

  return createUIMessageStreamResponse({ stream })
})
