/**
 * Headless A/B: run the REAL agent loop (decideConfig → RT-local render → re-look)
 * for a set of (image, intent) cases under multiple models, changing ONLY the model
 * string so the comparison isolates model quality. Saves every model's final frame
 * plus a per-step JSON log to an output dir for side-by-side review.
 *
 * Operator tooling — never imported by the app. Run from `src/` so RtLocalEngine
 * resolves `looks/` and storage resolves `.data/sessions/` correctly:
 *
 *   tsx --tsconfig scripts/tsconfig.ab.json scripts/ab-model-test.ts
 *
 * Env: AI_GATEWAY_API_KEY (gateway routing), RT_EXECUTION=local, RT_BIN.
 * Optional: AB_MODELS (comma list), AB_MAX_STEPS, AB_OUT.
 */
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'
import type { DevelopConfig } from '~~/shared/types'
import { DEFAULT_CONFIG } from '~~/shared/types'
import { storage } from '~~/server/utils/storage'
import { RtLocalEngine } from '~~/server/utils/engines/rt-local'
import { decideConfig, diffConfig, equalConfig } from '~~/server/utils/agent'

interface Case { image: string, intent: string }

// Scenarios chosen to exercise judgment: geometry+flat, color-cast correction, haze+mood.
const CASES: Case[] = [
  { image: 'public/samples/swirl-mural-portrait.jpg', intent: 'fix it up and make it pop' },
  { image: 'public/samples/strawberry-cake.jpg', intent: 'make it look natural and inviting' },
  { image: 'public/samples/granite-dome-vista.jpg', intent: 'make it dramatic and moody' }
]

const MODELS = (process.env.AB_MODELS || 'anthropic/claude-sonnet-4.6,anthropic/claude-opus-4.8')
  .split(',').map(s => s.trim()).filter(Boolean)
const MAX_STEPS = parseInt(process.env.AB_MAX_STEPS || '10', 10)
const OUT_DIR = resolve(process.cwd(), process.env.AB_OUT || 'internal_docs/ab-model-test')

const slug = (m: string) => m.replace(/[^a-z0-9]+/gi, '-')

interface StepLog {
  iter: number
  done: boolean
  phase: string
  goal: string
  assessment: string
  reason: string
  ops: ReturnType<typeof diffConfig>
  config: DevelopConfig
}

async function runOne(model: string, c: Case, engine: RtLocalEngine) {
  const id = await storage.createSession()
  await storage.writeOriginal(id, await readFile(resolve(process.cwd(), c.image)))

  let currentConfig: DevelopConfig = DEFAULT_CONFIG
  let currentPath = storage.pathFor(id, 'original')
  let lastApplied = 0
  const steps: StepLog[] = []

  for (let iter = 1; iter <= MAX_STEPS; iter++) {
    const decision = await decideConfig(
      { originalPath: storage.pathFor(id, 'original'), currentPath, intent: c.intent, currentConfig },
      model
    )
    const next = decision.config
    steps.push({
      iter,
      done: decision.done,
      phase: decision.phase,
      goal: decision.goal,
      assessment: decision.assessment,
      reason: decision.reason,
      ops: diffConfig(currentConfig, next),
      config: next
    })
    if (decision.done || equalConfig(next, currentConfig)) break

    const buf = await engine.renderConfig({ sessionId: id, originalPath: storage.pathFor(id, 'original'), config: next })
    await storage.writeStep(id, iter, buf)
    currentConfig = next
    currentPath = storage.pathFor(id, iter)
    lastApplied = iter
  }

  const base = basename(c.image).replace(/\.[^.]+$/, '')
  const tag = `${base}__${slug(model)}`
  const finalSrc = lastApplied > 0 ? storage.pathFor(id, lastApplied) : storage.pathFor(id, 'original')
  await copyFile(finalSrc, join(OUT_DIR, `${tag}.jpg`))
  await copyFile(storage.pathFor(id, 'original'), join(OUT_DIR, `${base}__original.jpg`))
  await writeFile(join(OUT_DIR, `${tag}.json`), JSON.stringify({ model, ...c, sessionId: id, renders: lastApplied, steps }, null, 2))

  console.log(`[done] ${tag}: ${lastApplied} renders, ${steps.length} decisions, finalConfig=${JSON.stringify(steps.at(-1)?.config)}`)
  return { model, image: c.image, intent: c.intent, renders: lastApplied, decisions: steps.length, finalConfig: steps.at(-1)?.config }
}

async function main() {
  process.env.RT_EXECUTION ||= 'local'
  await mkdir(OUT_DIR, { recursive: true })
  const engine = new RtLocalEngine()
  const summary: unknown[] = []
  const cases = process.env.AB_LIMIT ? CASES.slice(0, parseInt(process.env.AB_LIMIT, 10)) : CASES
  for (const c of cases) {
    for (const model of MODELS) {
      try {
        summary.push(await runOne(model, c, engine))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[error] ${c.image} @ ${model}: ${message}`)
        summary.push({ model, image: c.image, error: message })
      }
    }
  }
  await writeFile(join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(`\nWrote results to ${OUT_DIR}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
