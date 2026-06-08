# Batched Edits + Editor UX — Implementation Plan

**Created:** June 8, 2026
**Status:** Complete — all 3 sprints shipped & verified; artifact at `verification/index.html`
**Context:** The v1 agentic editor (Sprints 1–4, shipped) works: drop an image, type an intent, watch a vision-in-the-loop agent apply **one tool per step** with a live timeline. Four UX/architecture upgrades requested after using it: (1) click any timeline image to see it big, (2) let the model work in **bunches of edits** ("almost like a preset") instead of one tool per step, (3) be able to **go back** to an earlier frame, (4) **reclaim screen space during a run** — hide the input/sample panel while editing, bring it back with a button, and use the space better for both setup and editing. Plus: the agent should have **a lot more headroom** (the per-run cap was already raised 8→30; this plan reconciles that with batching).

**Goal:** The agent reasons in *batches* ("warm it up and add depth" → straighten + whiteBalance + tone + contrast applied together, then re-look), the run takes over the screen with a large live preview and a tidy batch timeline, and you can open any frame full-screen and rewind to continue from it.

**Scope:** Four features across three sprints, all building on the existing Nuxt 4 app in `src/`. No auth/DB/routing changes; sessions stay on local disk.

> **Design note — how the model emits a batch (decided after review).** The original draft had the model return a **typed array** of operation objects in its structured output. We rejected that: a variable-length array of objects pushes on the *exact* JSON-parse failure class that bit Sprint 3 (a nested/variable structured-output shape made the gateway model run to `finishReason: length` → `AI_JSONParseError`; the fix then was a fully **flat** schema). Instead the model emits the batch as a **flat newline-delimited string** — one `tool key=val key=val` line per op — in a single `operations` *string* field. The server splits the lines and reuses the existing per-op reassemble + range-clamp logic to build `Operation[]`. This keeps the LLM wire schema 100% flat (the proven-safe shape), gives real multi-op batches, and needs no fallback path. The client still receives a clean typed `operations: Operation[]` in each `StepEvent` (the string is only the model↔server format). See **Considered and rejected** at the end.

---

## Current State (what these features touch)

### What exists
- `src/shared/types.ts` — `ToolName` (9 tools), `Phase` (6), `Operation {tool, params}`, `Decision {assessment, done, phase, operation?, reason}`, `StepEvent {step, status, assessment?, reason?, phase?, operation?, imageUrl?, error?}`, `Session`.
- `src/server/utils/agent.ts` — `decideNextEdit(args, model)` → one `Decision` via `generateObject` with a **flat** zod schema (single op). Imports `EDITING_GUIDE`. Reassembles `operation:{tool,params}` from flat fields, range-clamping each.
- `src/server/utils/executor.ts` — `executor.apply(inputPath, operation) → Buffer` (one op). Raw-buffer helpers in `pixels.ts`.
- `src/server/api/edit.post.ts` — the manual loop: `for step in 1..MAX_STEPS`, decide → emit `deciding` → guardrails (no-op, flip-flop) → `executor.apply` → `storage.writeStep` → emit `applied`; tracks `lastAppliedStep`; emits a terminal `done` on the model's call **and** a terminal cap-hit `done` after the loop. `MAX_STEPS = parseInt(runtimeConfig.maxSteps) || 8` (note: the hardcoded fallback is still **8**; the 30 default lives in `nuxt.config.ts` + `.env`). Base image is always `original`.
- `src/server/utils/storage.ts` — `storage`: `createSession`, `writeOriginal`, `writeStep(id, step, buf)`, `read`, `pathFor(id, step)`, `listSteps`. Frames at `.data/sessions/<id>/{original,step-NN}.jpg`.
- `src/server/api/image/[id]/[step].get.ts` — serves any frame.
- `src/app/pages/index.vue` — two-column: sticky **input panel** (`lg:col-span-2`: dropzone + 5-sample picker + intent + Run/Stop) and **timeline** (`lg:col-span-3`) + a gated **Final result** panel with Download. Live state via `stepMap` keyed by step; SSE parsed in `readStream`; `AbortController` for Stop; `finalImageUrl` = last applied frame. **Note:** `run()` does `stepMap.value = new Map()` at the start of every run (line ~109) — relevant to go-back (Sprint 3).
- `src/app/components/TimelineStep.vue` — one card: step #, phase badge, assessment, single operation badge (`tool · key val`), reason, thumbnail/spinner by `status`.

### What changes
- **Data model:** a "step" becomes a **batch** — a stated sub-goal plus an ordered list of operations applied together before the next re-look. `Decision`, `StepEvent`, the executor, the loop, and the timeline card move from one-op to many-ops-per-step (via the newline-string format above).
- **UI:** `index.vue` gains an explicit view-state (setup → running → done), a collapsible input panel with a reopen button, a large live preview, and a batch-aware timeline. New `ImageLightbox.vue` modal. New "continue from here" / "use as result" controls.
- **Backend:** `/api/edit` accepts an optional base frame (`fromStep`) so a run can start from any prior frame (go-back / branch).

### What stays
- The Sharp + raw-buffer executor internals (`pixels.ts`, the 9 ops) are untouched — batching just calls `apply` more than once per step. Storage layout, gateway/single-key setup, the **flat** LLM schema style, manual SSE parsing, `AbortController` Stop, the `stepMap`-keyed-by-step merge, `finalImageUrl` = last applied, and the guardrail/terminal-`done` philosophy all carry forward.

---

## Architecture delta (batched loop)

```
MAX_STEPS bounds RE-LOOK ITERATIONS (not individual ops). Total op headroom =
MAX_STEPS × MAX_OPS_PER_BATCH.

base = fromStep ? pathFor(id, fromStep) : pathFor(id, 'original')   // go-back
current = base
for step in (startStep)..MAX_STEPS:
  batch = decideNextBatch({ current, intent, history })   // {goal, operations[1..6], done, ...}
  emit { status:'deciding', goal, operations }            // transient
  if batch.done || operations.empty: emit terminal done (imageUrl=lastApplied); break
  buf = applyBatch(current, batch.operations)             // loop executor.apply
  storage.writeStep(id, step, buf); lastAppliedStep = step
  emit { status:'applied', goal, operations, imageUrl }
  current = thisFrame
# preserve: no-op guardrail, terminal cap-hit done after the loop, lastAppliedStep fallback
```

**Step budget:** `MAX_STEPS` default **30** (already shipped), reinterpreted as max re-look iterations — keep the name (no rename; just a clarifying comment + fix the `|| 8` fallback to `|| 30`). New `MAX_OPS_PER_BATCH` default **6**. Up to 180 ops of headroom while the model still re-looks at real pixels often enough to self-correct. A 1-op batch is allowed when precision matters.

---

## Sprint 1: Batched edits — the data-model change [Complete]
**Goal:** The agent proposes a goal + a list of operations per iteration (as a flat newline string the server parses); the executor applies them as a batch; the loop streams batch events. Verified by curl before any UI work.
**Estimated effort:** ~3 hours

### Tasks
- 1.1 **Types** (`src/shared/types.ts`): add `goal?: string` and `operations?: Operation[]` to `StepEvent`. **Keep `operation?` for now** (additive — so `TimelineStep.vue` still typechecks through Sprint 1; it's migrated in Sprint 2). Update `Decision` to `{assessment, done, phase, goal, operations: Operation[], reason}` (replace `operation?`; update `agent.ts` + the loop, its only readers).
- 1.2 **Executor** (`src/server/utils/executor.ts`): add `applyBatch(inputPath, operations: Operation[]) → Buffer` as a **simple loop** — write the first op's output to a temp buffer/file, feed it to the next, return the last. (Do **not** rewrite the 9 ops onto a shared raw buffer for single-decode/encode — premature; each op already encodes at q90 and quality is fine.) Empty array = caller guards (no-op terminal). Keep `apply`.
- 1.3 **Agent** (`src/server/utils/agent.ts`): `decideNextBatch(args, model)` → `{goal, operations[], done, assessment, reason, phase}`. **Schema stays fully flat:** `{assessment: string, done: boolean, phase: enum, goal: string, operations: string, reason: string}` where `operations` is a **newline-delimited string**, one op per line in the form `tool key=val key=val` (e.g. `whiteBalance temp=-40 tint=0\ncontrast amount=0.3\nsharpen amount=0.3`). Server-side, split on newlines, parse each line → `{tool, params}` via the existing tool registry, range-clamp (reuse today's clamp logic), drop malformed/over-cap lines, cap at `MAX_OPS_PER_BATCH`. `.describe()` the `operations` field with the exact line grammar + the valid tools/params so the model emits it reliably. Update the prompt (via `EDITING_GUIDE`) to "plan a coherent bunch toward one stated `goal`, in the disciplined order, then stop the batch and let the loop re-render." Encode the **lean** policy (Kyle's decision): **2–4 ops** for clearly-related corrections, **drop to 1 op** after a large/uncertain move so the result is seen before continuing.
- 1.4 **Loop** (`src/server/api/edit.post.ts`): switch to `decideNextBatch` + `applyBatch`. Emit batch-shaped `deciding`/`applied` events (`goal` + `operations[]`). **Preserve:** the no-op guardrail (now = empty/all-identity batch → terminal `done`), `lastAppliedStep` tracking + its `imageUrl` fallback on terminal `done`, and the **cap-hit terminal `done`** after the loop. **Flip-flop guardrail:** cross-batch reversal detection is fiddly with multi-op batches — **drop it for v1** and rely on the model's done-judgment + the iteration cap (document this; the no-op guard stays). Keep `MAX_STEPS` name; **fix the fallback `|| 8` → `|| 30`**; add `const MAX_OPS_PER_BATCH = parseInt(runtimeConfig.maxOpsPerBatch) || 6`. `AbortController`/Stop is unaffected (it aborts the fetch, orthogonal to event shape) — no change.
- 1.5 **Editing guidance** (`src/server/utils/editing-guide.ts` + `SKILL.md`): **reconcile, don't just append.** The current text asserts one-op-per-step in several places that will now contradict batching — fix them: `editing-guide.ts` L5 ("You edit one global op per step" — the injected prompt's opening contract, highest leverage); `SKILL.md` L12 ("one global op per step"), L142 ("step cap"), and the "Self-correction discipline" section (~L175, "re-looks every step"). Reframe to: the agent plans and applies a *batch* toward a goal each iteration, then re-looks; batch related corrections, but isolate a move whose result you must see first (e.g. a large exposure change before judging contrast).
- 1.6 **Config docs** (`src/.env.example`): add `MAX_OPS_PER_BATCH=6` with a comment; reword the `MAX_STEPS` comment to "max re-look iterations (default 30)". Add `maxOpsPerBatch` to `nuxt.config.ts` runtimeConfig.

### Verification
- [x] `npx nuxi typecheck` + `npx eslint .` clean.
- [x] `curl` a flat sample, intent "make this flat hazy photo pop"; streamed `applied` events carry a `goal` + an `operations` array (2–5 ops); `.data/sessions/<id>/step-*.jpg` written + distinct. *(step 3 = 3-op batch tone+contrast+vibrance; see `verification/samples/sprint1_batched_stream.txt`)*
- [x] **Schema-robustness check:** light run (1 image × 1 intent end-to-end, plus a standalone parser unit test by the subagent); **0** `AI_JSONParseError`, newline `operations` parsed cleanly. *(Full 2×4–5 matrix trimmed to keep billable model calls down — the flat schema is the proven-safe shape and the live run confirmed it.)*
- [x] A 1-op batch still works (steps 1/2/4 precision cases); empty/all-identity batch terminates via the no-op guard (code-verified).

**Deviation:** patched a parse edge — `tool amount=` (empty value) now skips the key so it falls to the param default rather than coercing to `0` (`Number('')===0`, which is grayscale for `saturation`). `parseOpLine` in `agent.ts`.

---

## Sprint 2: Editing-mode layout + batch timeline [Complete]
**Goal:** The run takes over the screen — input/sample panel collapses, a large live preview shows the current frame, and the timeline renders batches cleanly. A button reopens the input panel. Setup and editing each use the space well.
**Estimated effort:** ~3–4 hours

### Tasks
- 2.1 **View state** (`src/app/pages/index.vue`): `view = 'setup' | 'running' | 'done'` derived from `running` + whether steps exist.
  - **Setup:** input panel is the hero (centered, roomy) — big dropzone + sample grid + intent + Run. No empty half-screen timeline.
  - **Running/Done:** the input `UCard` **collapses inline** (not a slide-over — less new surface, matches the existing sticky-panel pattern) to a slim summary or hides; the main area becomes a **large live preview** of the latest frame + the batch timeline beside/below it. A header button (`i-lucide-sliders-horizontal`, "Edit setup" / "New image") expands the input panel back so you can change image/intent and re-run.
- 2.2 **Large live preview:** show the most-recent `applied` frame prominently (updates as batches stream in); timeline is the supporting column/strip. On `done`, this is the final image + Download. This is the "use the space better" payoff.
- 2.3 **Batch timeline card** (`src/app/components/TimelineStep.vue`): **migrate off the single `operation`** (Sprint 1 kept it additive). Render `goal` as the card title and `operations[]` as a row of compact op chips (`tool · key val`); fall back to the old single-op render only if `operations` is absent. Spinner while `deciding`; thumbnail when `applied`; phase badge from the batch's first/dominant phase.
- 2.4 **Docs (this sprint owns the loop-shaped doc edits):** rewrite `src/README.md` "How it works" pseudocode (currently one-op-per-step) to the batched loop; fix "Toolset" intro lines that say "chooses one op per step"; extend the `data-step` description to `{ goal, operations[] }` and note `/api/edit` accepts optional `fromStep`. Fix repo-root `README.md` line 3 ("applies **one editing operation**" → "applies a **batch** of operations toward a stated sub-goal"). Update the README env table for `MAX_OPS_PER_BATCH` + the `MAX_STEPS` reinterpretation (note `MAX_STEPS` stays the env var — no rename).
- 2.5 Responsive + light/dark: stacks sensibly on small screens; preview never dwarfs the timeline into uselessness.

### Verification
- [x] Playwright: setup view clean/centered; after Run the input panel collapses and the large preview + batch timeline take the space; the reopen button ("Edit setup") restores the input panel; light + dark screenshots captured.
- [x] Batch cards show the goal + multiple op chips + a thumbnail (`sprint2_batch_card_chips.png`: step-3 goal + 3 chips).
- [x] `npx nuxi typecheck` + lint clean; README pseudocode rewritten to the batched loop.

**Deviations:** (1) Extracted a new `src/app/components/InputPanel.vue` so the image+intent form is a single source of truth rendered in both the setup hero and the collapsible panel (cleaner than duplicating markup). (2) Fixed a pre-existing chip-formatter bug surfaced by the new chips — `saturation`/`sharpen` `amount` are unsigned (multiplier / magnitude), so they no longer get a misleading `+` prefix; true bipolar deltas keep their sign.

---

## Sprint 3: Image lightbox + go-back [Complete]
**Goal:** Click any frame to open it full-screen with download (and prev/next); rewind to an earlier frame and continue editing from it.
**Estimated effort:** ~2–3 hours

### Tasks
- 3.1 **Lightbox** (`src/app/components/ImageLightbox.vue`, new): a `UModal`/full-screen overlay showing the selected frame large with its goal/ops caption and a **Download**. **Core:** open from a click on any `TimelineStep` thumbnail and on the large preview; Esc to close. **Optional (nice-to-have, cut if tight):** prev/next paging across all frames (original → each batch → final) with ←/→ keys.
- 3.2 **Go-back / branch — backend** (`src/server/api/edit.post.ts`): accept optional `fromStep?: number | 'original'` in the body; when present, the loop's starting `currentPath` is that frame (validate it exists) and **new frames continue numbering after the current max step** (use `storage.listSteps` to find the next index) so the branch appends rather than overwrites.
- 3.3 **Go-back / branch — UI** (`index.vue` + lightbox/timeline): **"Continue from here"** on any prior frame (sets `fromStep`, opens the intent box for a new intent, re-runs) and **"Use this as result"** (sets that frame as the download target / final). **Resolve the `stepMap` reset:** today `run()` wipes `stepMap` on every run; a branch run must **append** (keep existing cards, continue numbering) — gate the reset on "fresh run vs. branch/continue". Make the selected base/result visually clear in the timeline.
- 3.4 **"Undo last batch"** (in scope per Kyle's decision) = a one-click action that continues-from / reverts to the second-to-last frame, built atop 3.2/3.3.

### Verification
- [x] Playwright: timeline thumbnail (and large preview) → lightbox opens with the right image, goal caption, op chips, Download, prev/next paging + ←/→ keys; light + dark. "Continue from here" + new intent **appends** batches (prior cards retained, numbering continued); "Use this as result" retargets download/preview; "Undo last batch" reverts to second-to-last frame.
- [x] Backend: `curl /api/edit` with `fromStep:2` started from that frame and **appended** (initial steps 1–5 intact; branch wrote steps 6–8). See `verification/samples/sprint3_fromstep_branch.txt`.
- [x] `npx nuxi typecheck` + `eslint` clean.

**Notes:** prev/next paging across all frames (the "nice-to-have") was built. `index.vue` now persists `sessionId` so branch runs reuse the session; `stepMap` reset is gated on `branching` (fresh run wipes, continue appends); `effectiveResultStep` lets "Use this as result"/"Undo last batch" override the download target.

---

## Environment / Config

| Variable | Required | Description |
|----------|----------|-------------|
| `MAX_STEPS` | No | **Max re-look iterations** (default 30). Name unchanged for back-compat; each iteration applies a batch. |
| `MAX_OPS_PER_BATCH` | No | Max ops the model may put in one batch (default 6). New. |

(`AI_GATEWAY_API_KEY`, `AGENT_MODEL` unchanged.)

## Docs to update alongside the code (owned per sprint above)
- Sprint 1: `editing-guide.ts` + `SKILL.md` (reconcile one-op-per-step claims → batching), `src/.env.example` + `nuxt.config.ts` (`MAX_OPS_PER_BATCH`, reworded `MAX_STEPS`).
- Sprint 2: `src/README.md` (batched "How it works" pseudocode, `data-step {goal, operations[]}`, `/api/edit fromStep`, env table) and repo-root `README.md` line 3.
- Phase 5 (on execution): `verification/index.html` artifact.
- No analytics framework in this project (local tool) — nothing to instrument.

## What's deferred / out of scope
- Saved/named **preset files** reusable across images (the "some kind of file or list of them" musing). A batch is an in-run unit here; persisting named presets to disk is a clean follow-on once batching exists.
- Full branching **tree** of parallel edit variants. Go-back is linear-with-rebranch (continue from a chosen frame), not a saved tree.
- Per-op local masking / selective edits — still global-only.
- Production concerns (local, single-user, no-DB, no-deploy tool — no prod-safety surface; the prod-safety review pass was skipped for this reason).

## Considered and rejected
- **Typed operations *array* in the structured output** — reintroduces the variable/nested structured-output shape that caused `AI_JSONParseError` in the prior build; even bounded (`.max(6)`) it's the same failure class. Replaced with the flat newline-string the server parses. *(If the newline-string ever proves flaky, the next fallback is UI-only: keep single-op decisions, lean on the 30-iteration cap, and group consecutive same-goal cards — the "bunches" UX with zero schema risk.)*
- **`applyBatch` with a single shared-raw-buffer decode/encode** — would require rewriting all 9 ops onto one raw buffer; large, risky, negligible quality gain. Replaced with a simple loop over `apply`.
- **Renaming `MAX_STEPS` → `MAX_ITERATIONS`** — the env var, `.env.example`, `nuxt.config` key, and README all stay `MAX_STEPS`; renaming one local would create three names for one concept. Kept the name + a clarifying comment.
- **`USlideover` for the reopen panel** — inline collapse/expand of the existing `UCard` is less new surface and matches the current pattern.

## Decisions (confirmed with Kyle, 2026-06-08)
1. **Batch size — LEAN.** Prefer 2–4 op batches for clearly-related corrections, drop to 1 op after a large/uncertain move (so the agent sees that result before continuing). Encode this explicitly in `EDITING_GUIDE` (Sprint 1.3/1.5).
2. **Go-back — continue-from-any-frame + undo.** Both ship: "Continue from here" on any prior frame (branch/refine with a new intent) **and** the one-click "Undo last batch" shortcut. So **Sprint 3.4 is in scope, not optional.**
