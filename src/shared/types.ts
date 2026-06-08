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

/** Structured output of one decision call (vision + structured in one shot). */
export interface Decision {
  /** What the model sees in the current image vs. the intent. */
  assessment: string
  /** True when the goal is met — loop stops, no operation applied. */
  done: boolean
  /** Which phase this step belongs to. */
  phase: Phase
  /** The op to apply this step. Omitted when done. */
  operation?: Operation
  /** Why this op is the right next move. */
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
