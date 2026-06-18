import { readFile } from 'node:fs/promises'
import { generateObject } from 'ai'
import { z } from 'zod'
import type { Decision, DevelopConfig, LookName, Operation } from '~~/shared/types'
import { describeTools } from '~~/server/utils/tools'
import { EDITING_GUIDE } from '~~/server/utils/editing-guide'

/**
 * Structured-output schema for one config decision.
 *
 * NOTE — schema shape is load-bearing. A nested `config` object (especially an
 * optional one, or a discriminated union) makes claude-sonnet-4-6 fall into a
 * degenerate repetition loop through the AI Gateway (it never closes the JSON →
 * `finishReason: length` → `AI_JSONParseError`). A FULLY FLAT schema — every
 * field present, no nesting, no optionality — is parsed reliably. A develop
 * config is naturally flat: one field per slider, so we ask for each slider as
 * its own field and assemble the `DevelopConfig` after validation.
 *
 * Every slider field is an ABSOLUTE value (the full preset), not a delta — the
 * model restates the whole config each step, adjusting only what needs changing.
 */
const configSchema = z.object({
  assessment: z.string().describe('What you see in the current image versus the intent. One or two sentences.'),
  done: z.boolean().describe('True when the goal is met. When true, the config is left as-is and the run stops.'),
  phase: z.enum(['straighten', 'exposure', 'tone', 'color', 'creative', 'finish'])
    .describe('Which phase this step belongs to.'),
  goal: z.string().describe('One sentence stating what THIS step is trying to accomplish (e.g. "neutralize the cool cast and set the midtone exposure").'),
  straighten: z.number().describe('straighten angleDeg, -45..45 (+ clockwise). ABSOLUTE value (not a delta). 0 = no rotation.'),
  exposure: z.number().describe('exposure stops, -3..3 (+ brightens). ABSOLUTE value (not a delta). 0 = unchanged.'),
  highlights: z.number().describe('tone highlights, -100..100 (<0 recovers blown highs). ABSOLUTE value (not a delta). 0 = unchanged.'),
  shadows: z.number().describe('tone shadows, -100..100 (>0 lifts/opens shadows). ABSOLUTE value (not a delta). 0 = unchanged.'),
  temp: z.number().describe('whiteBalance temp, -100..100 (+ warmer, - cooler). ABSOLUTE value (not a delta). 0 = unchanged.'),
  tint: z.number().describe('whiteBalance tint, -100..100 (+ magenta, - green). ABSOLUTE value (not a delta). 0 = unchanged.'),
  contrast: z.number().describe('contrast strength, -1..1 (+ steeper S-curve, - flatter). ABSOLUTE value (not a delta). 0 = unchanged.'),
  vibrance: z.number().describe('vibrance strength, -1..1 (+ smart boost, - desaturate). ABSOLUTE value (not a delta). 0 = unchanged.'),
  saturation: z.number().describe('saturation multiplier, 0..2 (0 = grayscale, 1 = unchanged, 2 = double). ABSOLUTE value (not a delta). 1 = unchanged.'),
  sharpen: z.number().describe('sharpen strength, 0..1 (0 = none, 1 = max crisp). ABSOLUTE value (not a delta). 0 = unchanged.'),
  look: z.enum(['goldenHour', 'tealOrange', 'noir', 'vintageFade', 'crispClean', 'none'])
    .describe('Creative grade name, or "none" for no grade. ABSOLUTE value (not a delta).'),
  // --- Sprint 3 parametric controls (flat — every field present, no nesting) ---
  tcHighlights: z.number().describe('toneCurve highlights zone, -100..100 (+ brightens brightest tones). ABSOLUTE value. 0 = unchanged. Leave 0 unless the simple tone tool is too coarse.'),
  tcLights: z.number().describe('toneCurve lights zone (upper mids), -100..100. ABSOLUTE value. 0 = unchanged.'),
  tcDarks: z.number().describe('toneCurve darks zone (lower mids), -100..100. ABSOLUTE value. 0 = unchanged.'),
  tcShadows: z.number().describe('toneCurve shadows zone (darkest tones), -100..100 (+ lifts/opens). ABSOLUTE value. 0 = unchanged.'),
  splitShadowHue: z.number().describe('splitTone shadow hue, 0..360 deg (40=orange, 210=teal). Only matters when splitShadowSat>0. ABSOLUTE value.'),
  splitShadowSat: z.number().describe('splitTone shadow tint strength, 0..100 (0 = no shadow tint). ABSOLUTE value. 0 = unchanged.'),
  splitHighlightHue: z.number().describe('splitTone highlight hue, 0..360 deg. Only matters when splitHighlightSat>0. ABSOLUTE value.'),
  splitHighlightSat: z.number().describe('splitTone highlight tint strength, 0..100 (0 = no highlight tint). ABSOLUTE value. 0 = unchanged.'),
  splitBalance: z.number().describe('splitTone balance, -100..100 (- favors shadows, + favors highlights). ABSOLUTE value. 0 = unchanged.'),
  dehaze: z.number().describe('dehaze strength, 0..100 (cuts haze/adds clarity). ABSOLUTE value. 0 = unchanged. Use only on genuinely hazy images.'),
  nrLuminance: z.number().describe('denoise luminance, 0..100 (reduces grain). ABSOLUTE value. 0 = unchanged. Use sparingly.'),
  nrChroma: z.number().describe('denoise chroma, 0..100 (reduces color speckle). ABSOLUTE value. 0 = unchanged. Use sparingly.'),
  reason: z.string().describe('Why this config is the right next move (or why the goal is met). One sentence.')
})

type ConfigObject = z.infer<typeof configSchema>

export interface DecideArgs {
  originalPath: string
  currentPath: string
  intent: string
  currentConfig: DevelopConfig
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Epsilon for float slider compares (diff + equality). */
const EPS = 1e-3

/**
 * Clamp each flat field of a raw decision into its real per-slider range and
 * assemble a valid `DevelopConfig`. The schema can't express per-field ranges,
 * so this is where the slider bounds are enforced (the executor clamps again
 * defensively).
 */
function clampConfig(raw: ConfigObject): DevelopConfig {
  return {
    straighten: clamp(raw.straighten, -45, 45),
    exposure: clamp(raw.exposure, -3, 3),
    highlights: clamp(raw.highlights, -100, 100),
    shadows: clamp(raw.shadows, -100, 100),
    temp: clamp(raw.temp, -100, 100),
    tint: clamp(raw.tint, -100, 100),
    contrast: clamp(raw.contrast, -1, 1),
    vibrance: clamp(raw.vibrance, -1, 1),
    saturation: clamp(raw.saturation, 0, 2),
    sharpen: clamp(raw.sharpen, 0, 1),
    look: raw.look,
    tcHighlights: clamp(raw.tcHighlights, -100, 100),
    tcLights: clamp(raw.tcLights, -100, 100),
    tcDarks: clamp(raw.tcDarks, -100, 100),
    tcShadows: clamp(raw.tcShadows, -100, 100),
    splitShadowHue: clamp(raw.splitShadowHue, 0, 360),
    splitShadowSat: clamp(raw.splitShadowSat, 0, 100),
    splitHighlightHue: clamp(raw.splitHighlightHue, 0, 360),
    splitHighlightSat: clamp(raw.splitHighlightSat, 0, 100),
    splitBalance: clamp(raw.splitBalance, -100, 100),
    dehaze: clamp(raw.dehaze, 0, 100),
    nrLuminance: clamp(raw.nrLuminance, 0, 100),
    nrChroma: clamp(raw.nrChroma, 0, 100)
  }
}

/**
 * A compact "CURRENT SETTINGS" block for the prompt — every slider's current
 * value, so the model sees the full preset it must restate (copying unchanged
 * sliders as-is, adjusting only what needs changing).
 */
export function configToText(config: DevelopConfig): string {
  return [
    'CURRENT SETTINGS (the develop config rendered into the image you see):',
    `- straighten: ${config.straighten} (deg, -45..45, 0 = none)`,
    `- exposure: ${config.exposure} (EV, -3..3, 0 = none)`,
    `- highlights: ${config.highlights} (-100..100, 0 = none)`,
    `- shadows: ${config.shadows} (-100..100, 0 = none)`,
    `- temp: ${config.temp} (-100..100, 0 = none)`,
    `- tint: ${config.tint} (-100..100, 0 = none)`,
    `- contrast: ${config.contrast} (-1..1, 0 = none)`,
    `- vibrance: ${config.vibrance} (-1..1, 0 = none)`,
    `- saturation: ${config.saturation} (0..2, 1 = none)`,
    `- sharpen: ${config.sharpen} (0..1, 0 = none)`,
    `- look: ${config.look}`,
    `- tcHighlights: ${config.tcHighlights} (-100..100, 0 = none)`,
    `- tcLights: ${config.tcLights} (-100..100, 0 = none)`,
    `- tcDarks: ${config.tcDarks} (-100..100, 0 = none)`,
    `- tcShadows: ${config.tcShadows} (-100..100, 0 = none)`,
    `- splitShadowHue: ${config.splitShadowHue} (0..360 deg)`,
    `- splitShadowSat: ${config.splitShadowSat} (0..100, 0 = none)`,
    `- splitHighlightHue: ${config.splitHighlightHue} (0..360 deg)`,
    `- splitHighlightSat: ${config.splitHighlightSat} (0..100, 0 = none)`,
    `- splitBalance: ${config.splitBalance} (-100..100, 0 = none)`,
    `- dehaze: ${config.dehaze} (0..100, 0 = none)`,
    `- nrLuminance: ${config.nrLuminance} (0..100, 0 = none)`,
    `- nrChroma: ${config.nrChroma} (0..100, 0 = none)`
  ].join('\n')
}

const numChanged = (a: number, b: number) => Math.abs(a - b) > EPS

/**
 * One `Operation` per TOOL whose value(s) changed between `prev` and `next`,
 * carrying the NEW absolute value(s). Grouped by tool (tone = highlights+shadows,
 * whiteBalance = temp+tint). Used ONLY for the timeline chips — it is the single
 * owner of the config→display-op mapping.
 */
export function diffConfig(prev: DevelopConfig, next: DevelopConfig): Operation[] {
  const ops: Operation[] = []

  if (numChanged(prev.straighten, next.straighten)) {
    ops.push({ tool: 'straighten', params: { angleDeg: next.straighten } })
  }
  if (numChanged(prev.exposure, next.exposure)) {
    ops.push({ tool: 'exposure', params: { ev: next.exposure } })
  }
  if (numChanged(prev.highlights, next.highlights) || numChanged(prev.shadows, next.shadows)) {
    ops.push({ tool: 'tone', params: { highlights: next.highlights, shadows: next.shadows } })
  }
  if (numChanged(prev.tcHighlights, next.tcHighlights)
    || numChanged(prev.tcLights, next.tcLights)
    || numChanged(prev.tcDarks, next.tcDarks)
    || numChanged(prev.tcShadows, next.tcShadows)) {
    ops.push({
      tool: 'toneCurve',
      params: { hi: next.tcHighlights, lt: next.tcLights, dk: next.tcDarks, sh: next.tcShadows }
    })
  }
  if (numChanged(prev.temp, next.temp) || numChanged(prev.tint, next.tint)) {
    ops.push({ tool: 'whiteBalance', params: { temp: next.temp, tint: next.tint } })
  }
  if (numChanged(prev.contrast, next.contrast)) {
    ops.push({ tool: 'contrast', params: { amount: next.contrast } })
  }
  if (numChanged(prev.vibrance, next.vibrance)) {
    ops.push({ tool: 'vibrance', params: { amount: next.vibrance } })
  }
  if (numChanged(prev.saturation, next.saturation)) {
    ops.push({ tool: 'saturation', params: { amount: next.saturation } })
  }
  if (numChanged(prev.splitShadowHue, next.splitShadowHue)
    || numChanged(prev.splitShadowSat, next.splitShadowSat)
    || numChanged(prev.splitHighlightHue, next.splitHighlightHue)
    || numChanged(prev.splitHighlightSat, next.splitHighlightSat)
    || numChanged(prev.splitBalance, next.splitBalance)) {
    const params: Record<string, number> = {}
    if (next.splitShadowSat > 0) {
      params.shHue = next.splitShadowHue
      params.shSat = next.splitShadowSat
    }
    if (next.splitHighlightSat > 0) {
      params.hiHue = next.splitHighlightHue
      params.hiSat = next.splitHighlightSat
    }
    if (numChanged(prev.splitBalance, next.splitBalance)) {
      params.bal = next.splitBalance
    }
    ops.push({ tool: 'splitTone', params })
  }
  if (numChanged(prev.dehaze, next.dehaze)) {
    ops.push({ tool: 'dehaze', params: { amount: next.dehaze } })
  }
  if (numChanged(prev.nrLuminance, next.nrLuminance) || numChanged(prev.nrChroma, next.nrChroma)) {
    ops.push({ tool: 'denoise', params: { luma: next.nrLuminance, chroma: next.nrChroma } })
  }
  if (numChanged(prev.sharpen, next.sharpen)) {
    ops.push({ tool: 'sharpen', params: { amount: next.sharpen } })
  }
  if (prev.look !== next.look && next.look !== 'none') {
    ops.push({ tool: 'look', params: { name: next.look as LookName } })
  }

  return ops
}

/**
 * Deep-ish config equality: epsilon for the numeric sliders, exact for `look`.
 * Used by the loop's converge guard (a config identical to the current one means
 * the model has nothing left to change → stop).
 */
export function equalConfig(a: DevelopConfig, b: DevelopConfig): boolean {
  return !numChanged(a.straighten, b.straighten)
    && !numChanged(a.exposure, b.exposure)
    && !numChanged(a.highlights, b.highlights)
    && !numChanged(a.shadows, b.shadows)
    && !numChanged(a.temp, b.temp)
    && !numChanged(a.tint, b.tint)
    && !numChanged(a.contrast, b.contrast)
    && !numChanged(a.vibrance, b.vibrance)
    && !numChanged(a.saturation, b.saturation)
    && !numChanged(a.sharpen, b.sharpen)
    && a.look === b.look
    && !numChanged(a.tcHighlights, b.tcHighlights)
    && !numChanged(a.tcLights, b.tcLights)
    && !numChanged(a.tcDarks, b.tcDarks)
    && !numChanged(a.tcShadows, b.tcShadows)
    && !numChanged(a.splitShadowHue, b.splitShadowHue)
    && !numChanged(a.splitShadowSat, b.splitShadowSat)
    && !numChanged(a.splitHighlightHue, b.splitHighlightHue)
    && !numChanged(a.splitHighlightSat, b.splitHighlightSat)
    && !numChanged(a.splitBalance, b.splitBalance)
    && !numChanged(a.dehaze, b.dehaze)
    && !numChanged(a.nrLuminance, b.nrLuminance)
    && !numChanged(a.nrChroma, b.nrChroma)
}

/**
 * One vision-in-the-loop decision: the model looks at the CURRENT rendered image
 * (with the ORIGINAL as reference) plus the current slider values, and returns
 * the FULL updated develop config (or `done`). The server clamps each field into
 * its real range and assembles the `DevelopConfig`.
 *
 * Bare `provider/model` strings route through the Vercel AI Gateway when
 * AI_GATEWAY_API_KEY is set in the environment — no provider client needed.
 */
export async function decideConfig(
  args: DecideArgs,
  model: string
): Promise<Decision> {
  const { originalPath, currentPath, intent, currentConfig } = args

  const [originalBuf, currentBuf] = await Promise.all([
    readFile(originalPath),
    readFile(currentPath)
  ])

  const promptText = [
    'You are a seasoned photo editor with taste — opinionated, but you serve the photo, not your ego. You tune a single develop CONFIG — a set of absolute slider values — and the server re-renders the whole image from the original each iteration. You return the FULL config every step. The best edit is invisible: do the least that serves the intent, and stop.',
    '',
    `USER INTENT: ${intent}`,
    '',
    'EXPERT EDITING POLICY (follow this — it is how a pro would approach the edit):',
    EDITING_GUIDE,
    '',
    'AVAILABLE TOOLS (the live registry — these are the sliders of the config):',
    describeTools(),
    '',
    configToText(currentConfig),
    '',
    'INSTRUCTIONS:',
    '- Look at the CURRENT image (first image). The ORIGINAL is provided as reference (second image).',
    '- Run the diagnostic read: what is this photo and what does it want (genre + feeling), where should the eye land, and what is the SINGLE biggest problem (geometry, exposure, clipping, color cast, flatness). Fix the worst thing first.',
    '- State a single `goal` for this step, then return the FULL updated config: copy the sliders that are already right AS-IS (restate their current values), and adjust ONLY what needs changing.',
    '- Every slider field is an ABSOLUTE value, not a delta. The image always re-renders from the original, so you can freely raise OR lower any slider — reducing a value is free and lands exactly where you set it.',
    '- Respect the policy\'s restraint and target magnitudes — prefer small, deliberate moves. A finished edit usually touches 3-5 sliders.',
    '- When the intent is already satisfied (or further edits would not help), set done:true (the current config is kept as the result).'
  ].join('\n')

  const { object } = await generateObject({
    model,
    schema: configSchema,
    maxOutputTokens: 2048,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: promptText },
          { type: 'image', image: currentBuf },
          { type: 'image', image: originalBuf }
        ]
      }
    ]
  })

  return {
    assessment: object.assessment,
    done: object.done,
    phase: object.phase,
    goal: object.goal,
    config: clampConfig(object),
    reason: object.reason
  }
}
