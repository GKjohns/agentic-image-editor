# Parametric DevelopConfig — Implementation Plan

**Created:** June 8, 2026
**Status:** Both sprints complete + verified; one pre-existing render bug found & fixed during verification (see Sprint 1 "Bug found" note).
**Context:** The agent currently bakes edits sequentially — each batch is applied on top of the previous frame's pixels (`executor.applyBatch` chains ops; `edit.post.ts` feeds the last frame back to the model). When the agent decides "contrast is a touch too high," that contrast is already cooked into the JPEG; it can only pile an inverse-ish op on top, which compounds JPEG loss, is order-dependent, and makes the agent fight its own nonlinearity. Kyle's ask: have the agent hold one "config"/preset of slider values and *tweak that*, re-applying from the original — "a little more of this, a little less of that" without the nonlinearity getting in the way.

**Goal:** The agent maintains a single non-destructive **DevelopConfig** (one absolute value per slider). Each iteration it sees the rendered result, emits the *full updated config*, and the server re-renders the whole ordered stack **from `original.jpg`**. No compounding, no hysteresis — any slider can move up or down freely.

**Scope:** Backend refactor of the decision schema, executor, loop, storage (per-step config snapshots), and the editing guide. The timeline UI is largely untouched (it keeps rendering `goal` + per-step changed-slider chips + thumbnails). No auth/DB/routing changes; sessions stay on local disk.

---

## Current State

### What exists
- `src/shared/types.ts` — `ToolName` (9), `Phase` (6), `Operation {tool, params}`, `Decision {assessment, done, phase, goal, operations: Operation[], reason}`, `StepEvent {step, status, goal?, operations?, operation?, imageUrl?, ...}`, `Session`.
- `src/server/utils/agent.ts` — `decideNextBatch(args, model, maxOps)` → `Decision`, using a **flat** zod schema whose `operations` is a **newline-delimited string** the server parses (`parseBatch`/`parseOpLine`) + clamps into `Operation[]`. Also a now-legacy `decideNextEdit` (single-op). `historyText()` feeds prior ops back to the model.
- `src/server/utils/executor.ts` — `EditExecutor.apply(path, op) → Buffer` (the 9 ops, Sharp + raw-buffer math) and `applyBatch(path, ops) → Buffer` (chains ops via temp files). `applyLook` for the 5 named grades. Raw-buffer helpers in `pixels.ts` (untouched).
- `src/server/utils/tools.ts` — the tool registry (`tools`, `describeTools()`); single source of truth for slider names/ranges, fed into the prompt. **Reused as-is.**
- `src/server/api/edit.post.ts` — the loop: `for iter in 1..MAX_STEPS`, `decideNextBatch` → emit `deciding` → no-op guard → `applyBatch(currentPath, ops)` → `writeStep` → emit `applied`; `currentPath` = last frame (sequential); tracks `lastAppliedStep`; supports `fromStep` branch (base = a prior **frame's pixels**).
- `src/server/utils/storage.ts` — `storage`: `createSession`, `writeOriginal`, `writeStep(id, step, buf)`, `read`, `pathFor`, `listSteps`. Frames at `.data/sessions/<id>/{original,step-NN}.jpg`.
- `src/server/utils/editing-guide.ts` — `EDITING_GUIDE`, injected into the prompt; currently framed around "plan and apply a BATCH of global ops toward one goal, then re-look."
- `src/app/components/TimelineStep.vue` — renders `step.goal` as title, `step.operations[]` as `tool · key val` chips, `step.imageUrl` thumbnail; "Continue from here" / "Use this as result" actions.
- `src/app/pages/index.vue` — view-state (`setup`/`running`/`done`), `stepMap` keyed by step, SSE parse, large live preview, `fromStep` branch wiring, `effectiveResultStep` download target.

### What changes
- **The agent's output becomes the full config, not a batch of deltas.** `Decision` carries a `DevelopConfig`. The decision schema stays **fully flat** — but now naturally so: a config is a *fixed* set of fields (one per slider), so each slider is its own flat numeric/enum field. The newline-string batch hack is no longer needed and is removed.
- **A new `executor.renderConfig(originalPath, config)`** renders the full ordered stack from the original each iteration (reusing `apply`/`applyBatch` internally).
- **The loop re-renders from `original` every step**, tracks a `currentConfig`, and stops when the model says done *or* returns a config identical to the current one (converged).
- **Storage persists a config snapshot per step** (`step-NN.json`) so "continue from here" seeds the agent with that step's config (the natural meaning of branching in a parametric model) rather than a baked frame.
- **The per-step `operations[]` sent to the client becomes the *diff*** between the previous and new config (the sliders this step changed), so `TimelineStep.vue` renders unchanged.
- `editing-guide.ts` reframes from "emit a batch of ops" to "adjust the develop config; it is always re-rendered from the original, so move any slider up or down freely."

### What stays
- The Sharp + raw-buffer executor internals (`pixels.ts`, the 9 `apply` ops, `applyLook`, `applyBatch`) are **untouched** — `renderConfig` just calls them in a fixed order from the original. `tools.ts` registry, the gateway/single-key setup, the **flat** LLM schema philosophy, manual SSE parsing, `AbortController` Stop, `stepMap`-keyed-by-step merge, `effectiveResultStep` download target, storage layout (`.jpg` frames), and the `TimelineStep` card shape all carry forward.

---

## Architecture delta (parametric loop)

```
DevelopConfig = one absolute value per slider (the "preset"):
  straighten, exposure, highlights, shadows, temp, tint,
  contrast, vibrance, saturation, look, sharpen.

DEFAULT_CONFIG = identity (all 0; saturation 1; look 'none').

base config = fromStep ? readConfig(id, fromStep) : DEFAULT_CONFIG
current     = renderConfig(original, base)        // seed frame
for iter in 1..MAX_STEPS:
  next = decideConfig({ original, currentFrame, intent, currentConfig })  // FULL config + done
  emit { status:'deciding', goal, operations: diff(currentConfig, next) }  // transient
  if next.done || equalConfig(next, currentConfig):                        // converged
      emit terminal done (imageUrl = lastApplied); break
  buf = renderConfig(original, next)               // ALWAYS from original — no compounding
  writeStep(id, step, buf); writeConfig(id, step, next)
  emit { status:'applied', goal, operations: diff(currentConfig, next), imageUrl }
  currentConfig = next; lastAppliedStep = step
# preserve: terminal cap-hit done after the loop, lastAppliedStep fallback
```

**Why this kills "stuck."** Render order is fixed (`straighten → exposure → tone → whiteBalance → contrast → vibrance → saturation → look → sharpen`, the existing order of operations) and always runs from the original. So "less contrast" is literally `contrast: 0.25 → 0.18` — the rendered result reflects exactly that, with no leftover from the prior render. The agent reasons over a stable parameter space instead of a moving pixel target.

**Step budget:** `MAX_STEPS` (default 30) is unchanged — still the max re-look iterations. `MAX_OPS_PER_BATCH` is now meaningless (no batches) and is **fully removed in Sprint 1** (all four references: `edit.post.ts:100,138`, `nuxt.config.ts:25` `maxOpsPerBatch`, `src/.env.example:16`, `src/README.md:36,91`) — a half-wired knob is worse than the rename churn it would avoid, and it's the same edit session as the loop rewrite.

---

## DevelopConfig shape

```ts
// src/shared/types.ts
export type LookName = 'goldenHour' | 'tealOrange' | 'noir' | 'vintageFade' | 'crispClean'

/** The full non-destructive develop "preset": one absolute value per slider.
 *  Rendered from the original in a fixed order every iteration. */
export interface DevelopConfig {
  straighten: number   // angleDeg  -45..45   (0 = none)
  exposure: number     // ev        -3..3     (0 = none)
  highlights: number   // tone      -100..100 (0 = none)
  shadows: number      // tone      -100..100 (0 = none)
  temp: number         // WB        -100..100 (0 = none)
  tint: number         // WB        -100..100 (0 = none)
  contrast: number     // -1..1     (0 = none)
  vibrance: number     // -1..1     (0 = none)
  saturation: number   // 0..2 multiplier (1 = none)
  look: LookName | 'none'
  sharpen: number      // 0..1      (0 = none)
}

export const DEFAULT_CONFIG: DevelopConfig = {
  straighten: 0, exposure: 0, highlights: 0, shadows: 0, temp: 0, tint: 0,
  contrast: 0, vibrance: 0, saturation: 1, look: 'none', sharpen: 0
}
```

Note this is the same flat field set the current single-op schema already uses (`angleDeg`, `ev`, `highlights`, `shadows`, `temp`, `tint`, `amount×N`, `lookName`) — minus the shared-`amount` collision, since each slider now gets its own named field (`contrast`, `vibrance`, `saturation`, `sharpen`). That removes the per-tool clamp-on-a-shared-field hazard entirely.

---

## Sprint 1: Parametric core — schema, render, loop [Complete]
**Status:** Complete — typecheck/lint/grep clean; live curl proves convergence + clean reductions; samples at `verification/samples/sprint1_*`.
**Goal:** End-to-end, the agent emits a full `DevelopConfig`, the server renders it from the original each iteration, and the run converges. Verified by curl before any branching/doc work.
**Estimated effort:** ~3–4 hours

### Tasks
- **1.1 Types** (`src/shared/types.ts`): add `LookName`, `DevelopConfig`, `DEFAULT_CONFIG`. Change `Decision` to `{assessment, done, phase, goal, config: DevelopConfig, reason}` (replace `operations`). Add `config?: DevelopConfig` to `StepEvent` (keep `operations?`/`operation?` — `operations` now carries the per-step diff for the chips; the client is unchanged). Keep `Operation` (still the executor's internal unit).
- **1.2 Render from original** (`src/server/utils/executor.ts`): add `renderConfig(originalPath: string, config: DevelopConfig): Promise<Buffer>`. Build an ordered `Operation[]` from the non-identity fields, in the canonical order (`straighten, exposure, tone, whiteBalance, contrast, vibrance, saturation, look, sharpen`), then `return this.applyBatch(originalPath, ops)`. If every field is identity, return `sharp(originalPath).jpeg({quality:90}).toBuffer()` (don't call `applyBatch` with `[]`). **No change to `apply`/`applyBatch`/`pixels.ts`.**
- **1.3 Config-shaped decision** (`src/server/utils/agent.ts`): add `decideConfig(args, model): Promise<Decision>`. Flat zod schema: the narration fields (`assessment`, `done`, `phase`, `goal`, `reason`) + one field per slider (`straighten, exposure, highlights, shadows, temp, tint, contrast, vibrance, saturation, sharpen` as numbers; `look` as the look enum incl. `'none'`). `.describe()` each with its range and "this is an ABSOLUTE value, not a delta." Server-side, clamp each field to its real range and assemble a `DevelopConfig`. Add helpers: `configToText(config)` (a compact "current settings" block for the prompt) and `diffConfig(prev, next): Operation[]` (one `Operation` per tool whose value changed, carrying the new absolute value — used only for the timeline chips). Remove now-dead `decideNextBatch`, `decideNextEdit`, `parseBatch`, `parseOpLine`, `toOperation`, `batchSchema`, `decisionSchema`, `historyText`, `HistoryEntry` (verify no other importers first).
- **1.4 Loop** (`src/server/api/edit.post.ts`): rewrite to the parametric loop in the architecture sketch. Track `currentConfig` (seeded from `DEFAULT_CONFIG`); each step call `decideConfig`, render via `executor.renderConfig(originalPath, next)`, `writeStep`, emit `applied` with `operations: diffConfig(currentConfig, next)`. **Terminal guards:** model `done`, OR `equalConfig(next, currentConfig)` (converged — replaces the all-identity no-op guard), plus the existing cap-hit terminal `done` and `lastAppliedStep` fallback. **Remove `MAX_OPS_PER_BATCH` entirely** (lines 100 + 138) and the `isNoOp` batch filter. Seed-frame note: rendering `DEFAULT_CONFIG` produces a copy of the original — so on a fresh run the first decision sees the original as "current" (correct). **Converged-on-step-1 / branch-converges-immediately:** if the seed config and the model's first config are equal (a fresh run where the model returns all-defaults, or a `fromStep` branch where the model immediately agrees), the run writes **zero new frames** and the terminal `imageUrl` falls back to `lastAppliedStep` (`0`→none for a fresh run, or the base step for a branch) — preserve today's `baseStep === 'original' ? 0 : baseStep` fallback so this path closes cleanly.
- **1.4b Config knob cleanup** (`src/nuxt.config.ts`, `src/.env.example`, `src/README.md`): remove `maxOpsPerBatch` from `runtimeConfig` (`nuxt.config.ts:25`), `MAX_OPS_PER_BATCH=6` from `.env.example:16`, and the README env-table row + pseudocode mention (`src/README.md:36,91`). Same session as the loop rewrite — no dangling knob.
- **1.5 Editing guide** (`src/server/utils/editing-guide.ts`): reframe the opening + self-correction sections. New framing: "You tune a single develop CONFIG — a set of sliders (the same 9 tools as absolute values). Each iteration you see the rendered result and the current slider values; return the FULL updated config (copy unchanged sliders as-is, adjust only what needs changing). The image is ALWAYS re-rendered from the original, so you can freely raise OR lower any slider — there is no penalty for reducing a value, and no compounding to fear. Converge by nudging toward the intent; when the sliders are right, set done." Keep the READ-FIRST diagnosis, the order-of-operations rationale, the magnitude guard-rails, and the INTENT→sliders translation (all still valid). Drop the "do not oscillate / never full-reversal" warnings — they were artifacts of the baked model and now actively mislead (lowering a slider is free).

### Verification
- [x] `npm run typecheck` (`nuxt typecheck`) + `npx eslint .` clean.
- [x] `curl /api/edit` on `flat-and-crooked.jpg`, intent "make this flat, crooked photo pop": 6 `applied` events each carrying a `goal` + `operations` diff + full `config`; `src/.data/sessions/<id>/step-01..06.jpg` written, distinct hashes, visibly progressing; terminated on the model's `done` before the 30 cap. *(`verification/samples/sprint1_parametric_stream.txt`)*
- [x] **Convergence / "less of that" check:** the run overshot at step 2 (vibrance 0.45, contrast 0.30) then **reduced** them at step 3 (→0.25 / →0.20) and again at step 6 (vibrance →0.15). Confirmed the reduction renders as genuinely *less* saturated — step-06 < step-02 by eye and by JPEG size (236KB→207KB), i.e. re-rendered from original, not an inverse op piled on. *(`verification/samples/sprint1_config_trail.md`)*
- [x] **0 `AI_JSONParseError`** across the run — the flat full-config schema held.
- [x] Converged-guard path code-verified (`equalConfig` / `done`); all-default step-1 would terminate immediately with `imageUrl` undefined fallback.

**🐞 Bug found & fixed during verification (pre-existing, not introduced by this refactor): `applyVibrance` neon.**
The parametric model re-renders the full config from the original every pass, which exposed a latent bug in `src/server/utils/pixels.ts` `applyVibrance`. The formula was `newS = s + amount * (1 - s)` — the `(1 - s)` term boosts LOW-saturation pixels the *most*, so at amount 0.45 every faintly-tinted gray (clouds, buildings) was shoved to ~0.45 saturation and pure grays picked up a red cast from the undefined-hue→0 fallback. Result: psychedelic neon renders. Because the agent saw neon on *every* pass, it could never converge ("over-processed and can't be corrected" — Kyle's report). Bisected via direct `renderConfig` calls (exposure+contrast alone = beautiful; vibrance 0.45 alone = neon). **Fix:** make the boost saturation-proportional — `newS = s + amount * s * (1 - s)` — so neutrals stay neutral, muted mid-saturation colors get the lift, and already-vivid colors are protected. Re-rendered the bisection (clean) and ran a fresh end-to-end agent pass: 0 errors, converged on `done` (not the cap) with a natural punchy result, final config `vibrance 0.4` with no neon. *(This also improves the legacy batch model, which had the same latent bug.)* **Follow-up (not blocking):** the agent still took ~27 small steps to converge (re-nudges the straighten angle a lot) — a prompt/guide tuning matter, separate from this architecture; the output is correct.

**Other deviations:** (1) replaced the loop's `history.length` cap-summary with an `editCount` counter (per-op history is gone in the parametric model — cosmetic, only the cap-hit summary string). (2) Removed the now-unused `PHASE_ORDER` const + `Phase`/`Operation` imports from `edit.post.ts`. **Observation (not a blocker):** the agent overshot hard on the first pop pass (vibrance 0.45 on an already-saturated sunset) before walking it back — the parametric model is exactly what let it recover, but the magnitude guard-rails in `editing-guide.ts` could be tightened in a later tuning pass. Architecture is sound.

---

## Sprint 2: Config-snapshot branching + docs/UI reconcile [Complete]
**Status:** Complete — typecheck/lint/grep clean; live `fromStep` branch verified (seeds the stored config snapshot, appends frames); UI verified in-browser. Two UI bugs found during verification and fixed (see below).
**Goal:** "Continue from here" / "Undo last batch" work in the parametric model (seed the agent from a prior step's config), and every doc/comment that asserts the sequential/batched model is corrected.
**Estimated effort:** ~2–3 hours

### Tasks
- **2.1 Persist config per step** (`src/server/utils/storage.ts`): add `writeConfig(id, step, config)` → `step-NN.json` and `readConfig(id, step): Promise<DevelopConfig>` (return `DEFAULT_CONFIG` for `'original'` or a missing file). Call `writeConfig` alongside `writeStep` in the loop (Sprint 1.4 already writes the frame; this adds the sidecar).
- **2.2 Branch from a config snapshot** (`src/server/api/edit.post.ts`): when `fromStep` is present, seed `currentConfig = await storage.readConfig(id, fromStep)` and render the seed frame from the original (not from the prior baked pixels). New frames still append after the current max step (`startOffset` logic unchanged). This makes "continue from here" mean "keep tweaking that step's preset," which is the natural parametric semantics — and is strictly cleaner than the old pixel-branch.
- **2.3 UI sanity + vocabulary pass** (`src/app/pages/index.vue`, `TimelineStep.vue`, `ImageLightbox.vue`): (a) confirm the diff-as-`operations` chips read well (changed sliders, absolute values) — no structural change needed. (b) **Reconcile the user-facing "batch" wording**, which the new model makes misleading: `index.vue:140,152` lightbox frame label `Batch ${s.step}` → `Pass ${s.step}` (or `Step`); `index.vue:177-178` `undoLastBatch()` + `:322` button label "Undo last batch" → "Undo last step"; `index.vue:71` comment; `index.vue:469` count badge `'batch'/'batches'` → `'step'/'steps'` (or `'pass'/'passes'`); plus the stale `TimelineStep.vue:60,70,152` and `ImageLightbox.vue:4` comments. Pick one noun (`step` or `pass`) and use it consistently. Optional (cut if tight): a small "current settings" readout on the large preview showing the live config like a develop panel.
- **2.4 Docs reconcile** (env-knob removal already landed in 1.4b):
  - `SKILL.md` — order-of-operations stays; replace any "one global op per step" / batch framing with the config-tuning model.
  - `src/README.md` "How it works" pseudocode → the parametric loop (`renderConfig` from original, render-from-original each pass); `data-step` description (`operations` = per-step slider diff; add `config`); note `/api/edit fromStep` seeds a config snapshot. Also re-point any agent-seam reference to `decideConfig` and drop any oscillation/no-reversal note (no longer true).
  - repo-root `README.md` line 3 → "tunes a develop config (sliders) and re-renders from the original each pass."
  - `internal_docs/agentic-image-editor-spec.md` — **left frozen** as the original v1 one-pager (the prior batched-edits plan also left it untouched); not reconciled. Stated here so a future reader knows it's a historical record, not the current model.

### Verification
- [x] `curl /api/edit` with `fromStep: 2`: seeded step 2's stored config (carried its `sharpen 0.25`/`vibrance 0.2` forward — proof it seeded the snapshot, not defaults), rendered the seed from the original, appended steps 18+ (prior 17 frames intact). Confirmed against `step-02.json` vs `step-18.json`.
- [x] Playwright in-browser: timeline shows "N steps" (not "batches") with per-step slider-diff chips; live preview updates; thumbnail click opens the matching frame (lightbox bug fixed below); 0 console errors.
- [x] `npm run typecheck` + `eslint` clean.
- [x] **Grep gate:** `grep -rniE "max_ops_per_batch|maxopsperbatch|one op per step|decidenextbatch|decidenextedit|oscillation" src/ SKILL.md README.md` → no matches; `grep -rni "batch" src/app/` → no matches (zero, comments included).

**🐞 UI bug found & fixed during verification: lightbox opened the wrong frame.** Clicking a timeline thumbnail could open the modal on **Original** instead of the clicked frame (Kyle's report: "the preview image on the card doesn't match the image in the modal"). Root cause (`src/app/pages/index.vue` `openLightbox`): it resolved the frame by reconstructing a `Step ${step}` label and doing a `findIndex` that **silently fell back to index 0 (Original) on any miss**. The terminal `done` card has a `step` number with no own frame in `lightboxFrames` (its thumbnail aliases the last applied frame), so it always missed → Original. **Fix:** resolve the frame by the **`imageUrl` path the thumbnail is actually showing** (cache-buster stripped), with the label as fallback — the modal is now guaranteed to match the clicked thumbnail, and the `done` card opens its underlying frame. Reproduced and confirmed fixed in-browser (`verification/screenshots/lightbox_fixed_matches_thumbnail.png`).

---

## Environment / Config
| Variable | Required | Description |
|----------|----------|-------------|
| `MAX_STEPS` | No | Max re-look iterations (default 30). Unchanged. |
| `MAX_OPS_PER_BATCH` | — | **Removed** (Sprint 1.4b) — no batches in the parametric model; deleted from `.env.example`, `nuxt.config.ts`, loop, and README. |

(`AI_GATEWAY_API_KEY`, `AGENT_MODEL` unchanged.)

## What's deferred / out of scope
- **Tunable look intensity.** Looks are still all-or-nothing (`applyLook` is a fixed stack). A `lookIntensity` 0..1 blend would let the agent dial a grade "a little more/less" in the parametric spirit — a clean follow-on, but it needs `applyLook` to blend against the pre-look buffer. Not in this plan.
- **Saved/named preset files across images.** A `DevelopConfig` is now a first-class, serializable object (Sprint 2.1 persists per step) — exporting/importing it as a named preset is a natural next step, but out of scope here.
- **Per-op masking / local adjustments** — still global-only.
- **Render-cost optimization** (`renderConfig` re-encodes JPEG between ops via `applyBatch`'s temp-file chaining — up to ~9 round-trips for a full config). Invisible at q90 and configs rarely use all 9 sliders; a single-decode raw-buffer render is a future optimization, not needed now.
- **Production safety pass** — N/A: local single-user, no DB, no deploy pipeline (same rationale as the prior plan in this repo).

## Considered and rejected
- **Keep the newline-string batch schema, just always render from original.** The string format only existed to carry a *variable-length* op list. A config is fixed-shape, so a flat one-field-per-slider object is both simpler and the proven-safe schema form. No reason to keep the parser.
- **Emit only the changed sliders (a delta) from the model.** Rejected: the whole point is one stable source of truth. The model emits the FULL absolute config (restating the preset); the *server* computes the diff for display. Asking the model for deltas reintroduces the "what's my current state" ambiguity the baked model suffered from.
- **Diff the config client-side instead of a server-side `diffConfig` → `Operation[]` (review suggestion).** Considered. Kept server-side because the loop already holds *both* `currentConfig` and `next` at emit time, so the diff is free there; the client (`TimelineStep.vue`) renders one step in isolation and would have to thread the previous step's config in to diff — more plumbing, not less. With `toOperation` deleted, `diffConfig` becomes the *single* owner of the config→display-op mapping (not a duplicate), and it keeps `TimelineStep`/`ImageLightbox`/`index.vue` chip rendering 100% unchanged. The full `config` is still added to `StepEvent` (task 1.1) for a future "current settings" panel.
- **Branch from baked pixels (keep the old `fromStep`).** In a from-original render model, the frame's pixels aren't the state — the config is. Seeding from the stored config snapshot is the correct and simpler semantics.
- **Single shared-raw-buffer render in `renderConfig`.** Same call as the prior plan: reuse `applyBatch`'s loop over the existing `apply` ops; a one-pass raw render is a premature optimization.

## Decisions (confirmed with Kyle, 2026-06-08)
1. **Look intensity — deferred.** Looks ship all-or-nothing for now; the tunable `lookIntensity` blend is a separable follow-on (see Deferred). The one place "a little more/less" still can't apply.
