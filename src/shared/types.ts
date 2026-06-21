// Shared contract between the client (timeline UI) and the server (agent loop +
// executor). Keep this the single source of truth for the wire shapes.

/**
 * The Sharp-backed toolset. All ops run in-process (Sharp + raw-buffer pixel
 * math) — no external binary. See `server/utils/tools.ts` for param specs and
 * `SKILL.md` for when to reach for each.
 */
export type ToolName
  = | 'straighten' // geometry: rotate + inscribed-rect crop
    | 'crop' // geometry: crop for composition / aspect (applied after straighten)
    | 'exposure' // tonal: overall brightness in stops
    | 'contrast' // tonal: true sigmoidal S-curve
    | 'tone' // tonal: independent highlight recovery + shadow lift
    | 'toneCurve' // tonal: parametric 4-zone tone curve (highlights/lights/darks/shadows)
    | 'whiteBalance' // color: temperature (warm/cool) + tint (green/magenta)
    | 'saturation' // color: global saturation multiplier
    | 'vibrance' // color: smart saturation that protects already-saturated/skin tones
    | 'splitTone' // creative: hue+sat tint for shadows and highlights independently
    | 'look' // creative: a named parametric grade
    | 'gradFilter' // regional: a single linear graduated (ND) exposure filter
    | 'dehaze' // finish: cut atmospheric haze, add clarity
    | 'denoise' // finish: luminance + chroma noise reduction
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

/** Aspect-ratio hint for the crop tool. 'free' = no constraint, 'original' = keep source ratio. */
export type CropAspect = 'free' | 'original' | '1:1' | '4:5' | '3:2' | '16:9'

/**
 * The full non-destructive develop "preset": one ABSOLUTE value per slider
 * (not a delta). The server renders it from the original in a fixed order every
 * iteration, so any slider can move up or down freely with no compounding.
 */
export interface DevelopConfig {
  straighten: number // angleDeg  -45..45   (0 = none)
  // Crop (RT `[Crop]` / Sharp `.extract`). Normalized 0..1 of the POST-straighten
  // frame; applied right after straighten so it composes against the leveled
  // image. Identity is the full frame: left/top 0, width/height 1. `cropAspect`
  // is a flat hint enum (schema-safe, like `look`); 'free' = no aspect lock.
  cropLeft: number // 0..1 (0 = none) left edge
  cropTop: number // 0..1 (0 = none) top edge
  cropWidth: number // 0..1 (1 = none) fraction of width kept
  cropHeight: number // 0..1 (1 = none) fraction of height kept
  cropAspect: CropAspect // aspect hint ('free' = none)
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
  // --- Sprint 3: RawTherapee-grade parametric controls (all flat, no nesting) ---
  // Parametric tone curve (RT `[Exposure] Curve=2;...` weights). Each region
  // -100..100, 0 = none. Lets the agent reshape one tonal zone without touching
  // the others — finer than the highlights/shadows tone pair.
  tcHighlights: number // -100..100 (0 = none) brightest zone
  tcLights: number // -100..100 (0 = none) upper mids
  tcDarks: number // -100..100 (0 = none) lower mids
  tcShadows: number // -100..100 (0 = none) darkest zone
  // Split-toning (RT `[ColorToning] Method=RGBSliders`). A hue+saturation tint
  // applied independently to shadows and highlights — the cinematic teal/orange
  // grade. Hue 0..360 (color wheel deg), saturation 0..100 (0 = no tint).
  splitShadowHue: number // 0..360 (sat 0 = none)
  splitShadowSat: number // 0..100 (0 = none)
  splitHighlightHue: number // 0..360 (sat 0 = none)
  splitHighlightSat: number // 0..100 (0 = none)
  splitBalance: number // -100..100 (0 = none) shadow/highlight weighting
  // Dehaze (RT `[Dehaze]`). 0..100, 0 = none. Cuts atmospheric haze, adds clarity.
  dehaze: number // 0..100 (0 = none)
  // Noise reduction (RT `[Directional Pyramid Denoising]`). 0..100, 0 = none.
  nrLuminance: number // 0..100 (0 = none) luminance grain
  nrChroma: number // 0..100 (0 = none) color speckle
  // --- Sprint 3: one linear graduated (ND) filter (RT `[Gradient]`) ---
  // A SINGLE regional exposure gradient — the marquee "darken the bright sky /
  // lift the foreground" local edit, layered over the corrected global base.
  // Flat fixed-slot fields (NO array). `gradEnabled` 0 = off; identity disables
  // the whole filter so it's a no-op by default.
  gradEnabled: number // 0/1 (0 = off)
  gradAngle: number // 0..360 deg gradient direction; 0 = darken the TOP (sky)
  gradPosition: number // 0..1 where the transition sits across the frame; 0.5 = centered
  gradFeather: number // 0..100 transition softness; ~50 = a smooth, natural edge
  gradExposure: number // -3..3 EV; NEGATIVE darkens the masked side (photographer convention)
}

/** Identity config: every slider at its no-change value. */
export const DEFAULT_CONFIG: DevelopConfig = {
  straighten: 0,
  cropLeft: 0,
  cropTop: 0,
  cropWidth: 1,
  cropHeight: 1,
  cropAspect: 'free',
  exposure: 0,
  highlights: 0,
  shadows: 0,
  temp: 0,
  tint: 0,
  contrast: 0,
  vibrance: 0,
  saturation: 1,
  sharpen: 0,
  look: 'none',
  tcHighlights: 0,
  tcLights: 0,
  tcDarks: 0,
  tcShadows: 0,
  splitShadowHue: 0,
  splitShadowSat: 0,
  splitHighlightHue: 0,
  splitHighlightSat: 0,
  splitBalance: 0,
  dehaze: 0,
  nrLuminance: 0,
  nrChroma: 0,
  gradEnabled: 0,
  gradAngle: 0,
  gradPosition: 0.5,
  gradFeather: 50,
  gradExposure: 0
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
   * Single-op field kept for backward compat with older clients. The server
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

/**
 * The swappable develop runner. Renders a full `DevelopConfig` FROM the original
 * to a JPEG buffer — the same stateless seam the executor exposes today, plus a
 * `sessionId` (so a stateful runner can keep a warm worker keyed by session) and
 * a `dispose` hook (so that worker never leaks). Sharp/RT-local implement
 * `dispose` as a no-op; only the future sandbox runner keeps per-session state.
 */
export interface DevelopEngine {
  renderConfig(args: { sessionId: string, originalPath: string, config: DevelopConfig }): Promise<Buffer>
  dispose(sessionId: string): Promise<void>
  /**
   * OPTIONAL cold-start mitigation: pre-provision whatever the first render
   * needs (the sandbox runner uses it to kick off VM creation + the one-time
   * original upload). Fire-and-forget from the caller — best-effort, never
   * awaited on the hot path. Sharp/RT-local omit it (nothing to warm).
   */
  warm?(sessionId: string, originalPath: string): Promise<void>
}
