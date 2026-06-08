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

/** The five named creative grades a `look` can apply. */
export type LookName = 'goldenHour' | 'tealOrange' | 'noir' | 'vintageFade' | 'crispClean'

/**
 * The full non-destructive develop "preset": one ABSOLUTE value per slider
 * (not a delta). The server renders it from the original in a fixed order every
 * iteration, so any slider can move up or down freely with no compounding.
 */
export interface DevelopConfig {
  straighten: number // angleDeg  -45..45   (0 = none)
  exposure: number // ev        -3..3     (0 = none)
  highlights: number // tone      -100..100 (0 = none)
  shadows: number // tone      -100..100 (0 = none)
  temp: number // WB temp   -100..100 (0 = none)
  tint: number // WB tint   -100..100 (0 = none)
  contrast: number // -1..1     (0 = none)
  vibrance: number // -1..1     (0 = none)
  saturation: number // 0..2 multiplier (1 = none)
  sharpen: number // 0..1      (0 = none)
  look: LookName | 'none'
}

/** Identity config: every slider at its no-change value. */
export const DEFAULT_CONFIG: DevelopConfig = {
  straighten: 0,
  exposure: 0,
  highlights: 0,
  shadows: 0,
  temp: 0,
  tint: 0,
  contrast: 0,
  vibrance: 0,
  saturation: 1,
  sharpen: 0,
  look: 'none'
}

/**
 * Structured output of one decision call (vision + structured in one shot).
 * The agent holds a single develop `config` of absolute slider values, looks at
 * the rendered result, and returns the FULL updated config (with `done` when the
 * intent is met → terminal stop).
 */
export interface Decision {
  /** What the model sees in the current image vs. the intent. */
  assessment: string
  /** True when the goal is met — loop stops, no new frame rendered. */
  done: boolean
  /** Which phase this step belongs to. */
  phase: Phase
  /** One-line statement of what this step is trying to accomplish. */
  goal: string
  /** The full updated develop config (absolute slider values). */
  config: DevelopConfig
  /** Why this config is the right next move. */
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
  /** One-line goal this step is working toward. */
  goal?: string
  /** The sliders this step CHANGED (config diff), rendered as timeline chips. */
  operations?: Operation[]
  /** The full develop config after this step (absolute slider values). */
  config?: DevelopConfig
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
