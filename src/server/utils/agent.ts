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
    look: raw.look
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
    `- look: ${config.look}`
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
    'You are an expert photo-editing agent. You tune a single develop CONFIG — a set of absolute slider values — and the server re-renders the whole image from the original each iteration. You return the FULL config every step.',
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
    '- Assess the current image against the intent, naming the top problem (geometry, exposure, clipping, color cast, flatness).',
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
