// Shared contract between the client (timeline UI) and the server (agent loop +
// executor). Keep this the single source of truth for the wire shapes.

/**
 * The Sharp-backed toolset. All ops run in-process (Sharp + raw-buffer pixel
 * math) — no external binary. See `server/utils/tools.ts` for param specs and
 * `SKILL.md` for when to reach for each.
 */
export type ToolName
  = | 'straighten' // geometry: rotate + inscribed-rect crop
    | 'exposure' // tonal: overall brightness in stops
    | 'contrast' // tonal: true sigmoidal S-curve
    | 'tone' // tonal: independent highlight recovery + shadow lift
    | 'whiteBalance' // color: temperature (warm/cool) + tint (green/magenta)
    | 'saturation' // color: global saturation multiplier
    | 'vibrance' // color: smart saturation that protects already-saturated/skin tones
    | 'look' // creative: a named parametric grade
    | 'sharpen' // finish: output sharpening

/** Phases the planner is softly biased to move through (prior, not enforced). */
export type Phase
  = | 'straighten'
    | 'exposure'
    | 'tone'
    | 'color'
    | 'creative'
    | 'finish'

/** A single editing operation the agent chooses and the executor applies. */
export interface Operation {
  tool: ToolName
  /** Normalized, small params. Shape depends on tool — see tools registry. */
  params: Record<string, number | string>
}

/**
 * Structured output of one decision call (vision + structured in one shot).
 * As of Sprint 1 the agent reasons in BATCHES: it states a `goal` and proposes a
 * list of `operations` to apply together before the next re-look. `operations`
 * is empty when `done` (the goal is met → terminal stop).
 */
export interface Decision {
  /** What the model sees in the current image vs. the intent. */
  assessment: string
  /** True when the goal is met — loop stops, no operations applied. */
  done: boolean
  /** Which phase this batch belongs to. */
  phase: Phase
  /** One-line statement of what this batch of ops is trying to accomplish. */
  goal: string
  /** The ops to apply this iteration, in order. Empty when done. */
  operations: Operation[]
  /** Why this batch is the right next move. */
  reason: string
}

/** Lifecycle of a timeline card. `deciding` → (`applied` | terminal `done`). */
export type StepStatus = 'deciding' | 'applied' | 'done' | 'error'

/**
 * One streamed timeline event (`data-step` part). The server emits a `deciding`
 * event when the model commits to a step, then an `applied` event once the
 * executor has written the new pixels. The client merges both into one card
 * keyed by `step`.
 */
export interface StepEvent {
  step: number
  status: StepStatus
  assessment?: string
  reason?: string
  phase?: Phase
  /** One-line goal the batch is working toward (Sprint 1 batching). */
  goal?: string
  /** The batch of ops decided/applied this iteration (Sprint 1 batching). */
  operations?: Operation[]
  /**
   * Single-op field kept for backward compat with TimelineStep.vue. The server
   * no longer populates it; new clients should read `operations`.
   */
  operation?: Operation
  /** URL of the rendered result for this step (present on `applied`). */
  imageUrl?: string
  /** Present on `error`. */
  error?: string
}

/** A session living on local disk in `.data/sessions/<id>/`. */
export interface Session {
  id: string
  intent?: string
  steps: number
}
