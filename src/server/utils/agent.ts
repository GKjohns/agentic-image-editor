import { readFile } from 'node:fs/promises'
import { generateObject } from 'ai'
import { z } from 'zod'
import type { Decision, Operation, Phase, ToolName } from '~~/shared/types'
import { describeTools } from '~~/server/utils/tools'
import { EDITING_GUIDE } from '~~/server/utils/editing-guide'

/**
 * Structured-output schema for one decision (Sprint-4, 9 tools).
 *
 * NOTE — schema shape is load-bearing. A nested `operation` object (especially an
 * optional one, or a discriminated union) makes claude-sonnet-4-6 fall into a
 * degenerate repetition loop through the AI Gateway (it never closes the JSON →
 * `finishReason: length` → `AI_JSONParseError`). A FULLY FLAT schema — every
 * field present, no nesting, no optionality — is parsed reliably. So we keep the
 * wire schema flat and reassemble the `Operation` shape the executor expects
 * after validation.
 *
 *   tool: 'none' means done.
 *   Each op reads ONLY the flat params relevant to it; the rest are ignored:
 *     straighten   -> angleDeg              (-45..45)
 *     exposure     -> ev                    (-3..3)
 *     contrast     -> amount               (-1..1)
 *     tone         -> highlights, shadows  (-100..100 each)
 *     whiteBalance -> temp, tint           (-100..100 each)
 *     saturation   -> amount               (0..2)
 *     vibrance     -> amount               (-1..1)
 *     look         -> lookName             (enum)
 *     sharpen      -> amount               (0..1)
 * `amount` is SHARED across contrast/saturation/vibrance/sharpen whose ranges
 * differ; the schema can't enforce a per-tool range on a shared field, so we
 * give it the widest span and CLAMP per-tool during reassembly (and the executor
 * clamps again defensively).
 */
const decisionSchema = z.object({
  assessment: z.string().describe('What you see in the current image versus the intent. One or two sentences.'),
  done: z.boolean().describe('True when the goal is met. When true, set tool to "none".'),
  phase: z.enum(['straighten', 'exposure', 'tone', 'color', 'creative', 'finish'])
    .describe('Which phase this step belongs to.'),
  tool: z.enum(['straighten', 'exposure', 'contrast', 'tone', 'whiteBalance', 'saturation', 'vibrance', 'look', 'sharpen', 'none'])
    .describe('The single op to apply this step, or "none" when done.'),
  angleDeg: z.number().describe('straighten degrees, -45..45 (+ clockwise). 0 unless tool=straighten.'),
  ev: z.number().describe('exposure stops, -3..3 (+ brightens). 0 unless tool=exposure.'),
  amount: z.number().describe('SHARED strength: contrast -1..1, saturation 0..2, vibrance -1..1, sharpen 0..1. Set to the chosen tool\'s range; ignored otherwise.'),
  highlights: z.number().describe('tone highlights, -100..100 (<0 recovers blown highs). 0 unless tool=tone.'),
  shadows: z.number().describe('tone shadows, -100..100 (>0 lifts/opens shadows). 0 unless tool=tone.'),
  temp: z.number().describe('whiteBalance temp, -100..100 (+ warmer, - cooler). 0 unless tool=whiteBalance.'),
  tint: z.number().describe('whiteBalance tint, -100..100 (+ magenta, - green). 0 unless tool=whiteBalance.'),
  lookName: z.enum(['goldenHour', 'tealOrange', 'noir', 'vintageFade', 'crispClean', 'none'])
    .describe('Creative grade name. Used only when tool=look; "none" otherwise.'),
  reason: z.string().describe('Why this op is the right next move (or why the goal is met). One sentence.')
})

type DecisionObject = z.infer<typeof decisionSchema>

/**
 * Batch decision schema (Sprint 1). Stays FULLY FLAT for the same reason the
 * single-op schema is flat — a typed/nested `operations` array makes the model
 * fall into a non-terminating-JSON loop through the Gateway (`AI_JSONParseError`).
 * So the batch travels as a newline-delimited STRING, one op per line, and the
 * server splits + parses + clamps it into `Operation[]`. See `parseBatch`.
 */
const batchSchema = z.object({
  assessment: z.string().describe('What you see in the current image versus the intent. One or two sentences.'),
  done: z.boolean().describe('True when the goal is met. When true, leave operations empty.'),
  phase: z.enum(['straighten', 'exposure', 'tone', 'color', 'creative', 'finish'])
    .describe('Which phase this batch belongs to.'),
  goal: z.string().describe('One sentence stating what THIS batch of ops is trying to accomplish (e.g. "neutralize the cool cast and set the midtone exposure").'),
  operations: z.string().describe(
    [
      'The batch of operations to apply this iteration, as a NEWLINE-DELIMITED string,',
      'ONE op per line, in the order they should be applied. Empty string when done.',
      'Each line is: `tool key=val key=val` (space-separated, no commas, no quotes).',
      'Use ONLY these tools and param keys (out-of-range values are clamped server-side):',
      '  straighten angleDeg=<-45..45>',
      '  exposure ev=<-3..3>',
      '  contrast amount=<-1..1>',
      '  tone highlights=<-100..100> shadows=<-100..100>',
      '  whiteBalance temp=<-100..100> tint=<-100..100>',
      '  saturation amount=<0..2>',
      '  vibrance amount=<-1..1>',
      '  look name=<goldenHour|tealOrange|noir|vintageFade|crispClean>',
      '  sharpen amount=<0..1>',
      'Example (three ops):',
      '  whiteBalance temp=-40 tint=0',
      '  exposure ev=0.3',
      '  contrast amount=0.25'
    ].join('\n')
  ),
  reason: z.string().describe('Why this batch is the right next move (or why the goal is met). One sentence.')
})

/** A compact record of a prior step, fed back so the model sees its own history. */
export interface HistoryEntry {
  tool: string
  params: Record<string, number | string>
}

export interface DecideArgs {
  originalPath: string
  currentPath: string
  intent: string
  history: HistoryEntry[]
  phasePrior: Phase[]
}

function historyText(history: HistoryEntry[]): string {
  if (history.length === 0) {
    return '(none yet — this is the first step)'
  }
  return history
    .map((h, i) => {
      const params = Object.entries(h.params).map(([k, v]) => `${k}=${v}`).join(', ')
      return `${i + 1}. ${h.tool}(${params})`
    })
    .join('\n')
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * Reassemble the executor's `{ tool, params }` shape from the flat schema,
 * clamping each value to its real per-tool range (the shared `amount` field
 * can't be range-validated by zod, so we narrow it here).
 */
function toOperation(o: DecisionObject): Operation {
  switch (o.tool as Exclude<ToolName, never>) {
    case 'straighten':
      return { tool: 'straighten', params: { angleDeg: clamp(o.angleDeg, -45, 45) } }
    case 'exposure':
      return { tool: 'exposure', params: { ev: clamp(o.ev, -3, 3) } }
    case 'contrast':
      return { tool: 'contrast', params: { amount: clamp(o.amount, -1, 1) } }
    case 'tone':
      return { tool: 'tone', params: { highlights: clamp(o.highlights, -100, 100), shadows: clamp(o.shadows, -100, 100) } }
    case 'whiteBalance':
      return { tool: 'whiteBalance', params: { temp: clamp(o.temp, -100, 100), tint: clamp(o.tint, -100, 100) } }
    case 'saturation':
      return { tool: 'saturation', params: { amount: clamp(o.amount, 0, 2) } }
    case 'vibrance':
      return { tool: 'vibrance', params: { amount: clamp(o.amount, -1, 1) } }
    case 'look':
      return { tool: 'look', params: { name: o.lookName } }
    case 'sharpen':
      return { tool: 'sharpen', params: { amount: clamp(o.amount, 0, 1) } }
    default:
      // Should be unreachable: 'none' is handled by the caller before this runs.
      return { tool: 'exposure', params: { ev: 0 } }
  }
}

/** Tools the line-parser accepts (excludes the single-op sentinel 'none'). */
const BATCH_TOOLS = new Set<ToolName>([
  'straighten', 'exposure', 'contrast', 'tone',
  'whiteBalance', 'saturation', 'vibrance', 'look', 'sharpen'
])
const LOOK_NAMES = new Set(['goldenHour', 'tealOrange', 'noir', 'vintageFade', 'crispClean'])

/**
 * Parse ONE `tool key=val key=val` line into a clamped Operation, or null if the
 * line is malformed / names an unknown tool / (for look) names an unknown grade.
 * Reuses the same per-tool clamp ranges as the single-op reassembly above.
 */
function parseOpLine(line: string): Operation | null {
  const tokens = line.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  const tool = tokens[0] as ToolName
  if (!BATCH_TOOLS.has(tool)) return null

  const kv: Record<string, string> = {}
  for (const tok of tokens.slice(1)) {
    const eq = tok.indexOf('=')
    if (eq <= 0 || eq === tok.length - 1) continue // skip tokens without a non-empty key=value shape
    kv[tok.slice(0, eq)] = tok.slice(eq + 1)
  }

  const num = (k: string) => Number(kv[k])

  switch (tool) {
    case 'straighten':
      return { tool, params: { angleDeg: clamp(num('angleDeg') || 0, -45, 45) } }
    case 'exposure':
      return { tool, params: { ev: clamp(num('ev') || 0, -3, 3) } }
    case 'contrast':
      return { tool, params: { amount: clamp(num('amount') || 0, -1, 1) } }
    case 'tone':
      return { tool, params: { highlights: clamp(num('highlights') || 0, -100, 100), shadows: clamp(num('shadows') || 0, -100, 100) } }
    case 'whiteBalance':
      return { tool, params: { temp: clamp(num('temp') || 0, -100, 100), tint: clamp(num('tint') || 0, -100, 100) } }
    case 'saturation':
      return { tool, params: { amount: clamp(Number.isFinite(num('amount')) ? num('amount') : 1, 0, 2) } }
    case 'vibrance':
      return { tool, params: { amount: clamp(num('amount') || 0, -1, 1) } }
    case 'look': {
      const name = kv.name ?? ''
      if (!LOOK_NAMES.has(name)) return null
      return { tool, params: { name } }
    }
    case 'sharpen':
      return { tool, params: { amount: clamp(num('amount') || 0, 0, 1) } }
    default:
      return null
  }
}

/**
 * Split the model's newline-delimited `operations` string into clamped
 * `Operation[]`: drop blank/malformed/unknown lines, then hard-cap at
 * `maxOps` (over-cap lines are dropped). An empty/all-dropped batch returns [].
 */
function parseBatch(operations: string, maxOps: number): Operation[] {
  const ops: Operation[] = []
  for (const line of operations.split('\n')) {
    if (ops.length >= maxOps) break
    const op = parseOpLine(line)
    if (op) ops.push(op)
  }
  return ops
}

/**
 * One vision-in-the-loop decision: the model looks at the CURRENT rendered image
 * (with the ORIGINAL as reference) and chooses the single next op, or stops.
 *
 * Bare `provider/model` strings route through the Vercel AI Gateway when
 * AI_GATEWAY_API_KEY is set in the environment — no provider client needed.
 */
export async function decideNextEdit(
  args: DecideArgs,
  model: string
): Promise<Decision> {
  const { originalPath, currentPath, intent, history, phasePrior } = args

  const [originalBuf, currentBuf] = await Promise.all([
    readFile(originalPath),
    readFile(currentPath)
  ])

  const promptText = [
    'You are an expert photo-editing agent that works ONE operation at a time, looking at the rendered result before each next move.',
    '',
    `USER INTENT: ${intent}`,
    '',
    'EXPERT EDITING POLICY (follow this — it is how a pro would approach the edit):',
    EDITING_GUIDE,
    '',
    'AVAILABLE TOOLS (the live registry — pick exactly one per step):',
    describeTools(),
    '',
    'OPERATIONS APPLIED SO FAR:',
    historyText(history),
    '',
    `SOFT PHASE ORDER (a bias, not a rule): ${phasePrior.join(' -> ')}.`,
    'Move roughly in this order but deviate when the image needs it.',
    '',
    'INSTRUCTIONS:',
    '- Look at the CURRENT image (first image). The ORIGINAL is provided as reference (second image).',
    '- Assess the current image against the intent, naming the top problem (geometry, exposure, clipping, color cast, flatness).',
    '- Choose the SINGLE next operation that best moves it toward the intent. One op per step.',
    '- Set `tool` to that op and fill ONLY its relevant params (per the tool list); leave every other numeric field at 0 (and lookName at "none" unless tool=look).',
    '- Respect the policy\'s restraint and target magnitudes — prefer small, deliberate moves over piling on. A finished edit is usually 3-5 moves.',
    '- Do NOT oscillate or undo a previous move; if you overshot, apply a smaller opposite nudge, never a full reversal.',
    '- When the intent is satisfied (or further edits would not help), set done:true and tool:"none".'
  ].join('\n')

  const { object } = await generateObject({
    model,
    schema: decisionSchema,
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

  // done — or tool=none, or a look with no grade — is a terminal decision with
  // no operation. (If done is false but tool=none, treat as a safe stop.)
  if (object.done || object.tool === 'none' || (object.tool === 'look' && object.lookName === 'none')) {
    return {
      assessment: object.assessment,
      done: true,
      phase: object.phase,
      goal: object.reason,
      operations: [],
      reason: object.reason
    }
  }

  return {
    assessment: object.assessment,
    done: false,
    phase: object.phase,
    goal: object.reason,
    operations: [toOperation(object)],
    reason: object.reason
  }
}

/**
 * One vision-in-the-loop BATCH decision (Sprint 1). The model looks at the
 * CURRENT rendered image (ORIGINAL as reference), states a single `goal`, and
 * proposes a coherent BATCH of ops (as a newline-delimited string) to apply
 * together before the next re-look. The server splits + clamps + caps that
 * string into `Operation[]`.
 *
 * `maxOps` is the per-batch hard cap (passed in from the loop / runtime config).
 */
export async function decideNextBatch(
  args: DecideArgs,
  model: string,
  maxOps: number
): Promise<Decision> {
  const { originalPath, currentPath, intent, history, phasePrior } = args

  const [originalBuf, currentBuf] = await Promise.all([
    readFile(originalPath),
    readFile(currentPath)
  ])

  const promptText = [
    'You are an expert photo-editing agent. You work in BATCHES: each iteration you state ONE goal and apply a coherent bunch of operations toward it, THEN the loop re-renders and you look again.',
    '',
    `USER INTENT: ${intent}`,
    '',
    'EXPERT EDITING POLICY (follow this — it is how a pro would approach the edit):',
    EDITING_GUIDE,
    '',
    'AVAILABLE TOOLS (the live registry — every op in your batch must be one of these):',
    describeTools(),
    '',
    'OPERATIONS APPLIED SO FAR:',
    historyText(history),
    '',
    `SOFT PHASE ORDER (a bias, not a rule): ${phasePrior.join(' -> ')}.`,
    'Move roughly in this order but deviate when the image needs it.',
    '',
    'INSTRUCTIONS:',
    '- Look at the CURRENT image (first image). The ORIGINAL is provided as reference (second image).',
    '- Assess the current image against the intent, naming the top problem (geometry, exposure, clipping, color cast, flatness).',
    '- State a single `goal` for this batch, then list the operations that achieve it, IN the disciplined order of operations.',
    `- LEAN BATCHING: plan 2-4 clearly-RELATED corrections that you are confident move together toward the goal (max ${maxOps}). But DROP TO 1 op when you just made — or are about to make — a large or uncertain move (e.g. a big exposure or look change): apply it alone so you can SEE the result before deciding what is next.`,
    '- Respect the policy\'s restraint and target magnitudes. A finished edit is usually 3-5 ops TOTAL across all batches, not per batch.',
    '- Emit `operations` as a newline-delimited string, one `tool key=val key=val` line per op, in apply order (see the field description for the exact grammar and valid tools/params).',
    '- When the intent is already satisfied (or further edits would not help), set done:true and leave operations empty.'
  ].join('\n')

  const { object } = await generateObject({
    model,
    schema: batchSchema,
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

  const operations = parseBatch(object.operations, maxOps)

  // Terminal: model says done, OR the batch parsed to nothing usable (treated as
  // a safe stop). The loop's no-op guard handles all-identity batches downstream.
  if (object.done || operations.length === 0) {
    return {
      assessment: object.assessment,
      done: true,
      phase: object.phase,
      goal: object.goal,
      operations: [],
      reason: object.reason
    }
  }

  return {
    assessment: object.assessment,
    done: false,
    phase: object.phase,
    goal: object.goal,
    operations,
    reason: object.reason
  }
}
