import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import type { Operation, Phase, StepEvent } from '~~/shared/types'
import { storage } from '~~/server/utils/storage'
import { executor } from '~~/server/utils/executor'
import { decideNextEdit, type HistoryEntry } from '~~/server/utils/agent'

interface EditRequestBody {
  id?: string
  intent?: string
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

/**
 * Reversal: the new op pushes the immediately-previous APPLIED op back the other
 * way. Same tool, and either a re-toggled look (same grade) or opposite-sign
 * numeric params of similar magnitude (e.g. whiteBalance temp -35 then +30).
 *
 * NOTE a *single* reversal is healthy convergence — the model overshot and is
 * dialing back, and the reversing op yields the BETTER frame. We let it apply.
 * Only a *repeated* reversal on the same tool (A+ → A- → A+ …) is true
 * flip-flopping that won't settle; that's what the loop stops on. Shrinking
 * repeats (same tool, smaller each time) are fine-tuning, not a problem.
 */
function reversesPrevious(prev: Operation, next: Operation): boolean {
  if (prev.tool !== next.tool) return false
  if (next.tool === 'look') {
    // Re-applying the same look is a wash; a different look is a new direction.
    return String(prev.params.name) === String(next.params.name)
  }
  // Numeric tools: every shared key flips sign with comparable magnitude.
  const keys = Object.keys(next.params)
  let sawSignedKey = false
  for (const k of keys) {
    const a = Number(prev.params[k]) || 0
    const b = Number(next.params[k]) || 0
    if (Math.abs(a) < 1e-3 && Math.abs(b) < 1e-3) continue // both ~0: neutral key
    sawSignedKey = true
    if (a * b >= 0) return false // same sign (or one zero) → not a reversal
    const mag = Math.min(Math.abs(a), Math.abs(b)) / Math.max(Math.abs(a), Math.abs(b))
    if (mag < 0.4) return false // magnitudes too different to call it an undo
  }
  return sawSignedKey
}

export default defineEventHandler(async (event) => {
  const { id, intent } = await readBody<EditRequestBody>(event)
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

  const runtimeConfig = useRuntimeConfig(event)
  const model = runtimeConfig.agentModel
  const MAX_STEPS = parseInt(runtimeConfig.maxSteps) || 8

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

      let currentPath = storage.pathFor(id, 'original')
      const history: HistoryEntry[] = []
      const appliedOps: Operation[] = [] // for reversal detection
      let consecutiveReversals = 0 // same-tool flip-flop counter
      let lastStep = 0
      let lastAppliedStep = 0 // step number whose frame is the current result

      for (let step = 1; step <= MAX_STEPS; step++) {
        lastStep = step
        try {
          const decision = await decideNextEdit(
            {
              originalPath: storage.pathFor(id, 'original'),
              currentPath,
              intent,
              history,
              phasePrior: PHASE_ORDER
            },
            model
          )

          // Ephemeral "deciding" card update.
          emit({
            step,
            status: 'deciding',
            assessment: decision.assessment,
            operation: decision.operation,
            reason: decision.reason,
            phase: decision.phase
          }, true)

          // Model stopped (done, or tool=none → safe stop).
          if (decision.done || !decision.operation) {
            emit({
              step,
              status: 'done',
              assessment: decision.assessment,
              reason: decision.reason,
              phase: decision.phase,
              imageUrl: lastAppliedStep > 0
                ? `/api/image/${id}/${lastAppliedStep}?t=${Date.now()}`
                : undefined
            })
            return
          }

          const op = decision.operation

          // --- Guardrail: no-op. The model effectively chose nothing. Stop.
          if (isNoOp(op)) {
            emit({
              step,
              status: 'done',
              assessment: decision.assessment,
              reason: `${decision.reason} (chosen op had no effect — stopping)`,
              phase: decision.phase
            })
            return
          }

          // --- Guardrail: flip-flop oscillation. A single reversal is healthy
          // (the model overshot and is correcting — that op makes a better
          // frame, so let it apply). But a SECOND consecutive reversal on the
          // same tool means it's flip-flopping and won't settle: stop, keeping
          // the last applied (most-converged) frame. The MAX_STEPS cap is the
          // ultimate backstop for any slower wobble.
          const prev = appliedOps[appliedOps.length - 1]
          const isReversal = !!prev && reversesPrevious(prev, op)
          if (isReversal && consecutiveReversals >= 1) {
            emit({
              step,
              status: 'done',
              assessment: decision.assessment,
              reason: 'The agent is flip-flopping the same control back and forth — stopping at the last settled frame.',
              phase: decision.phase
            })
            return
          }

          const buf = await executor.apply(currentPath, op)
          await storage.writeStep(id, step, buf)
          currentPath = storage.pathFor(id, step)
          lastAppliedStep = step
          consecutiveReversals = isReversal ? consecutiveReversals + 1 : 0

          emit({
            step,
            status: 'applied',
            // Cache-buster: intermediates are served no-store, but this avoids any
            // stale-render edge cases if a step number is ever reused.
            imageUrl: `/api/image/${id}/${step}?t=${Date.now()}`,
            assessment: decision.assessment,
            operation: op,
            reason: decision.reason,
            phase: decision.phase
          })

          history.push({ tool: op.tool, params: op.params })
          appliedOps.push(op)
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
        assessment: `Reached the ${MAX_STEPS}-step limit with ${appliedOps.length} edits applied.`,
        reason: 'Stopping at the step cap; the last applied frame is the final result.'
      })
    }
  })

  return createUIMessageStreamResponse({ stream })
})
