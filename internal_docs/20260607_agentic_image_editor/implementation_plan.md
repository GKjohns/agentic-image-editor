# Agentic Image Editor — Implementation Plan

**Created:** June 7, 2026
**Status:** ✅ Complete — Sprints 1–4 shipped & verified end-to-end. 9-tool Sharp toolset (no ImageMagick), editing know-how baked into the agent (`SKILL.md` + `editing-guide.ts`), loop guardrails, curated practice photos. Verification artifact: `verification/index.html`.
**Context:** A single-page Nuxt tool that takes an image + a natural-language edit intent and produces an edited image via a vision-in-the-loop agent. Each step the model looks at the *current rendered image*, decides one editing operation, the server applies it (Sharp), and the loop continues until the model judges the goal met or hits a cap. The live timeline streaming each step's reasoning + result is the centerpiece UX.

**Goal:** Drop an image, type "warm it up and lift the shadows," click Run, and watch a live timeline of the agent's steps (assessment → operation → new thumbnail) produce a downloadable final image.

**Scope (v1, kept deliberately simple):**
- One page, no auth, no routing, no DB. Sessions live on local disk in `.data/sessions/<id>/`.
- A fixed, small toolset implemented with **Sharp only** (no ImageMagick in v1).
- **One SDK, one key:** Vercel AI SDK + Vercel AI Gateway. The model is a swappable string (`anthropic/...`, `openai/...`, `google/...`) so we can A/B the vision judgment without code changes.
- Manual orchestration loop (not the AI SDK auto tool-roundtrip) so the model sees *new pixels* each step.
- Streaming step events over the AI SDK UI-message stream (`createUIMessageStream` + custom `data-step` parts on the **server**), consumed on the **client** by a plain `fetch` + stream reader — not the `@ai-sdk/vue` `Chat` class (see Sprint 3.3 note).

> **Conscious departure from `~/claude-ops/conventions/ai_sdk_usage.md`.** The convention doc prescribes a two-SDK split (OpenAI SDK Responses API for structured calls that land in a DB, Vercel AI SDK for streaming chat UIs). We deliberately don't follow it here: the per-step decision streams nothing to a DB row, it needs *vision + structured output in one call* (which `generateObject` does cleanly), and **AI Gateway routing is an explicit spec requirement**. One SDK + one key is the simpler, correct fit for this tool. Noted so a future reader doesn't "fix" it back to the convention.

---

## Current State

### What Exists
- `src/` — Nuxt 4.4 + Nuxt UI 4.8 starter, npm, `legacy-peer-deps=true`, dev server verified booting on :3000.
- `src/app/pages/index.vue` — starter marketing hero (will be replaced).
- `src/app/app.config.ts` — primary `green`, neutral `slate`.
- `src/nuxt.config.ts` — `@nuxt/ui` + `@nuxt/eslint`. Note: `routeRules: { '/': { prerender: true } }` — **must be removed** (our index page is interactive/SSR, not static).
- `src/app/components/{AppLogo,TemplateMenu}.vue` — starter chrome, will be trimmed/rebranded.

### What Changes
- Replace `index.vue` with the editor: dropzone + intent textarea + Run + live step timeline + final download.
- Add `ai`, `@ai-sdk/vue`, `zod`, `sharp` deps.
- Add `server/` Nitro routes: `POST /api/session`, `POST /api/edit` (streaming), `GET /api/image/[id]/[step]`.
- Add `server/utils/` for the `StorageAdapter`, `EditExecutor`, toolset, and the agent loop.
- Add `.env.example` documenting the single `AI_GATEWAY_API_KEY`.
- Rebrand chrome (title, logo, color).

### What Stays
- The Nuxt UI design system, ESLint config, and dark mode all untouched — we build on them.

---

## Architecture

```
 Browser (index.vue)
   │  1. POST /api/session  (multipart: original image)  ──► writes .data/sessions/<id>/original.jpg
   │  ◄── { id }
   │
   │  2. POST /api/edit { id, intent }   (streaming response)
   │        server runs the MANUAL LOOP:
   │          for step in 1..MAX_STEPS:
   │            decision = generateObject({ model: gateway, image: current, schema })  ── vision + structured
   │            writer.write({ type:'data-step', data:{ step, assessment, operation, reason, status:'deciding' }})
   │            if decision.done: break
   │            newPath = EditExecutor.apply(current, decision.operation)   ── Sharp
   │            writer.write({ type:'data-step', data:{ step, status:'applied', imageUrl:/api/image/<id>/<step> }})
   │  ◄── stream of data-step parts  ──►  client reads stream (plain fetch), renders each card live
   │
   │  3. GET /api/image/<id>/<step>   ◄── serves each intermediate / final jpg
```

Two clean seams kept swappable for the future Vercel Sandbox (spec §Storage & Execution Seams):
- **`StorageAdapter`** — `read / write / list / pathFor`. v1 = local dir. Later = Blob / Sandbox FS.
- **`EditExecutor`** — `apply(imagePath, operation) → newImagePath`. v1 = in-process Sharp. Later = Sandbox.

---

## Sprint Breakdown

### Sprint 1: Single-page UI shell — Foundational  [Complete]
**Goal:** The page renders the full editor layout with mock/static data — dropzone, intent box, Run button, and a timeline of placeholder step cards — before any backend exists.
**Estimated effort:** ~2 hours

> **Built:** `app/app.vue` rebranded (title "Agentic Image Editor", starter chrome/GitHub/`TemplateMenu` removed — `TemplateMenu.vue` deleted). `app/pages/index.vue` replaced with the editor: two-column on `lg` (sticky input panel left, timeline right), native dashed dropzone with `URL.createObjectURL` preview, intent `UTextarea`, Run/Stop buttons gated on file+intent+running. `app/components/TimelineStep.vue` renders one step card (number badge, phase badge, assessment, op badge, reason, thumbnail/spinner by `status`). Seeded with 3 fake steps (applied / deciding / done) + a gated final-image+Download panel. Typecheck + eslint clean.
> **Deviation:** `creative` phase badge mapped to `secondary` (Nuxt UI doesn't resolve a raw `violet` color in this config). Native `<input type=file>` used over `UFileUpload` for cleaner inline preview/remove control (plan permitted either).

#### Tasks
- 1.1 Rebrand chrome
  - `src/nuxt.config.ts`: remove `routeRules['/'].prerender`. Set app head title to "Agentic Image Editor".
  - `src/app/app.config.ts`: keep `green`/`slate` for now (revisit at polish).
  - Trim `TemplateMenu.vue` / `AppLogo.vue` to a minimal header (app name only).
- 1.2 Replace `src/app/pages/index.vue` with the editor layout (static first):
  - Left/top: a `UFileUpload`-or-dropzone area (accept images) + intent `UTextarea` + a `Run` `UButton`.
  - Right/below: a **timeline** — a vertical list of step cards. Each card: step number, phase badge, assessment text, operation badge (tool + params), reason, and a thumbnail slot. Drive a per-card spinner off a `status` field (`deciding` | `applied`).
  - Final-image panel with a Download button (hidden until done).
  - Hard-code 2–3 fake steps so the layout is real before wiring data.
- 1.3 Define the shared TypeScript types in `src/shared/types.ts`: `ToolName`, `Operation`, `StepEvent`, `Decision`, `Session`. (Used by both client and server.)

#### Verification
- [x] `npm run dev`, page renders the editor layout in light + dark mode (Playwright screenshot — see verification artifact).
- [x] Dropzone accepts a file and shows a preview; fake timeline cards render with thumbnails + spinners.
- [x] `npx nuxi typecheck` clean.

---

### Sprint 2: Storage + Executor + image routes — Foundational  [Complete]
**Goal:** A session can be created from an uploaded image and intermediates can be served, with a Sharp-backed executor that applies the core operations — all testable by curl, no agent yet.
**Estimated effort:** ~3 hours

> **Built:** `server/utils/storage.ts` (`LocalStorageAdapter` + `storage` singleton over `.data/sessions/<id>/`, `original.jpg` + `step-NN.jpg`). `server/utils/tools.ts` (registry + `ToolSpec` types + `describeTools()` for the prompt). `server/utils/executor.ts` (`EditExecutor` + `executor` singleton, 4 Sharp ops). `server/api/session.post.ts` (multipart upload → id). `server/api/image/[id]/[step].get.ts` (serves original/step jpg). Added `@types/node` devDep (was missing — even `nuxt.config.ts` failed typecheck without it). Typecheck + eslint clean.
>
> **Final v1 param conventions (source of truth for Sprint 3 schema):**
> - `exposure` `{ ev }` range −3..3 — `.linear(2**ev, 0)` (multiplicative stops).
> - `saturation` `{ amount }` range 0..2 — `.modulate({ saturation })` (1 = unchanged).
> - `contrast` `{ amount }` normalized −1..1 (0 = none) — mapped to multiplier `m` (≥0 → `1+amount`; <0 → `1/(1−amount)`), clamped [0.5, 2.0], applied as `.linear(m, 128−128*m)` about mid-gray. Linear S-curve approximation; true sigmoidal deferred to Sprint 4.
> - `straighten` `{ angleDeg }` range −45..45 (positive = clockwise) — rotate then center-crop largest inscribed rect (`rotatedRectWithMaxArea`); output smaller than input. Border-aware crop is a documented small-angle approximation.

#### Tasks
- 2.1 `StorageAdapter` — `src/server/utils/storage.ts`
  - Local impl over `.data/sessions/<id>/`. Methods: `createSession()→id`, `writeOriginal(id, buffer)`, `pathFor(id, step)`, `writeStep(id, step, buffer)`, `read(id, step)`, `listSteps(id)`.
  - `id` from `crypto.randomUUID()`.
- 2.2 `EditExecutor` + toolset — `src/server/utils/executor.ts`, `src/server/utils/tools.ts`
  - `apply(inputPath, operation) → outputBuffer/Path` dispatching on `operation.tool`.
  - **v1 Sharp toolset (4 core ops, keep params normalized & small):**
    - `exposure` `{ ev }` → `sharp().linear()` / gamma-ish brightness in stops.
    - `contrast` `{ amount }` → Sharp `linear`/`modulate`-based S-curve approximation (note: true sigmoidal deferred to ImageMagick, see stretch sprint).
    - `saturation` `{ amount }` → `sharp().modulate({ saturation })`.
    - `straighten` `{ angleDeg }` → `sharp().rotate(angleDeg, { background })`. **Note: auto-cropping the rotated borders is non-trivial** — rotation leaves colored/transparent wedges and the clean fix is computing the largest inscribed axis-aligned rectangle (real trig). v1: do the simple `rotate` and a conservative center-crop (e.g. scale-to-cover the inscribed rect); don't over-invest here. Not a one-liner — budget time.
    - `exposure` math note: EV stops are multiplicative, so `sharp().linear(2 ** ev, 0)` (not gamma).
  - `tools.ts` exports the tool registry + a compact human/LLM-readable description of each tool and its params (fed into the decision prompt and reused for the zod schema).
- 2.3 Server routes
  - `POST /api/session` — `src/server/api/session.post.ts`: read the upload with Nitro's `readMultipartFormData(event)` (client sends a `FormData` with the image field), `writeOriginal`, return `{ id }`. (Naming this explicitly — it's the usual stall point.)
  - `GET /api/image/[id]/[step].get.ts` — stream the jpg for a given step (`original` or `step-NN`), correct content-type + cache headers.

#### Verification
- [x] `curl -F image=@test.jpg /api/session` returns an id; `original.jpg` lands in `.data/sessions/<id>/`. (Also: 400 on no-file, 404 on bad session.)
- [x] A tiny node script calls each of the 4 tools and writes visibly-different outputs (4/4 valid + different; straighten shrinks dims as expected).
- [x] `GET /api/image/<id>/original` returns the image bytes (200 image/jpeg; 404 on missing step).

---

### Sprint 3: The agent loop + live streaming timeline — Core  [Complete]
**Goal:** The real thing — `POST /api/edit` runs the manual vision loop through AI Gateway and streams `data-step` events; the timeline renders each step live as it arrives, ending in a downloadable final image.
**Estimated effort:** ~4 hours

> **Built:** `server/utils/agent.ts` (`decideNextEdit` via `generateObject`, current+original images as `{type:'image'}` content parts, gateway model string passed directly). `server/api/edit.post.ts` (bounded manual loop in `createUIMessageStream`, `data-step` events: `deciding` transient → `applied`/`done`/`error` persisted, `MAX_STEPS` hard cap, per-step try/catch). `app/pages/index.vue` wired to real session→edit→stream run with AbortController-backed Stop, per-step merge keyed by step #, final-image fallback + Download. Verified live end-to-end against the gateway with `anthropic/claude-sonnet-4-6` (vision + structured output both working); steps stream incrementally; intermediates written and distinct.
>
> **Deviation 1 (load-bearing) — flat zod schema, not a discriminated union.** The plan's nested/optional `operation` (discriminated union on `tool`) made the model fall into a degenerate repetition loop through the gateway (`finishReason: length` → `AI_JSONParseError`), reproduced across temperatures. Switched the *wire* schema to fully flat: `{ assessment, done, phase, tool: enum[...4 tools,'none'], ev, amount, angleDeg, reason }` — no nesting, no optionality; `tool:'none'` signals done; params always present. `agent.ts` reassembles the executor's `{tool, params:{...}}` shape and range-clamps after validation. Executor + shared types untouched.
> **Deviation 2 — manual SSE parse, not `readUIMessageStream`.** The SDK helper drops `transient` parts (delivers them only via an unexposed `onData`), so it would swallow the `deciding` events. Client parses SSE frames directly to capture both transient and persisted `data-step` chunks.
> **Addition — sample images.** Shipped 4 sample photos in `public/samples/` (`flat-and-crooked.jpg` [the best demo — flat, dark, rotated], `landscape.jpg`, `portrait.jpg`, `street.jpg`) with a "No image? Try a sample" picker in `index.vue`, so a user without a photo can try the tool immediately.

#### Tasks
- 3.1 The decision call — `src/server/utils/agent.ts`
  - `decideNextEdit({ originalPath, currentPath, intent, history, phasePrior })` using AI SDK **`generateObject`** with:
    - `model`: the AI Gateway string from runtime config (e.g. `anthropic/claude-...`). Bare `provider/model` strings route through the Gateway when `AI_GATEWAY_API_KEY` is set — no provider client needed.
    - messages with an **image content part** for the *current* image (the model "looks at" the rendered result) + a text part carrying intent, op history, and the phase prior.
    - `schema` (zod): `{ assessment, done, phase, operation?: { tool, params }, reason }` — matches spec §Decision schema. **Trim the `phase` enum to phases we actually have tools for in v1: `'straighten' | 'exposure' | 'color' | 'creative'`** (drop `'crop'` — no crop tool ships in v1, so leaving it in the enum lets the model pick a phase with no valid op). Constrain `operation.tool` to the 4 v1 `ToolName`s.
  - Two-SDK note considered and rejected: spec mandates AI SDK + Gateway, and `generateObject` does vision + structured output in one call, so we keep a single SDK and a single key (see the Scope departure note above).
- 3.2 The loop + streaming route — `src/server/api/edit.post.ts`
  - Wrap the loop in `createUIMessageStream({ execute: async ({ writer }) => {...} })`, return `createUIMessageStreamResponse({ stream })`.
  - Per step: call `decideNextEdit` → `writer.write({ type:'data-step', transient:true, data:{ step, status:'deciding', assessment, operation, reason, phase }})` → if `done` break → `EditExecutor.apply` → `storage.writeStep` → `writer.write({ ..., status:'applied', imageUrl:'/api/image/<id>/<step>' })`.
  - `PHASE_ORDER` constant: `straighten → exposure → color → creative` (soft prior in the prompt, not enforced).
  - **`MAX_STEPS` hard cap lives HERE** (default 8, from env) — the loop must be bounded to be safe to run at all. Only the smarter "best-so-far" return + oscillation detection are deferred to Sprint 4; the plain cap is non-negotiable for Sprint 3.
- 3.3 Wire the client — `src/app/pages/index.vue`
  - On Run: send the file to `/api/session` via `FormData`, then POST `{ id, intent }` to `/api/edit` with a **plain `fetch`** and read the streamed body (a small stream reader; optionally the SDK's `readUIMessageStream` to parse parts). **Do not use the `@ai-sdk/vue` `Chat` class** — this is a one-shot run, not a chat; there's no messages array or `sendMessage`, so `Chat` would be awkward gold-plating. Keep the server's `createUIMessageStream` (it's the right server primitive); just consume it directly.
  - As each `data-step` part arrives, merge `deciding` then `applied` into one timeline card keyed by step #. Track a global running flag from the fetch lifecycle; an `AbortController` powers a Stop button.
  - The **final image** is the `imageUrl` of the last `applied` step (the terminating `done` decision carries no operation/image — fall back to the previous step's image). Show it + a Download link when the stream closes.

#### Verification
- [x] End-to-end in the browser (Playwright): dropped the deliberately-flat/crooked sample, watched cards stream in, confirmed the final looks corrected. Mid-run + final states screenshotted (see verification artifact).
- [x] Streamed response confirmed incremental (curl `-N` showed `deciding`→`applied` chunks arriving ~seconds apart, not all at once).
- [x] Download yields the final jpg.

---

### Sprint 4: Richer toolset + know-how + guardrails  [Complete]
**Goal:** Richer tone/color control, real photo-editing judgment baked into the agent, and loop safety.
**Estimated effort:** ~3 hours (delivered via parallel subagents)

> **Major deviation (better than planned) — no ImageMagick; everything in Sharp + raw-buffer pixel math.** ImageMagick isn't installed, and rather than add a system binary we implemented the "ops Sharp does poorly" *in-process*: a **true sigmoidal contrast** (256-entry LUT applied per channel), `tone`, `whiteBalance`, and `vibrance` via raw-buffer (`sharp().raw()`) pixel math, and `look` as named parametric grades (not `.cube` files). Zero external dependency, true curves, and it sets up the future Vercel Sandbox path cleanly (no binary to provision). Pure pixel helpers live in `server/utils/pixels.ts`.

#### What shipped
- **Toolset grew 4 → 9** (`server/utils/{executor,tools,pixels}.ts`):
  - `contrast` upgraded from a linear approximation to **true sigmoidal** (α = `min(1,|amount|)·8`; inverse-sigmoid for amount<0 genuinely flattens).
  - **`tone` `{ highlights, shadows }`** (each −100..100) — luminance-masked highlight recovery + shadow lift (smoothstep weights, hue-preserving).
  - **`whiteBalance` `{ temp, tint }`** (each −100..100) — per-channel gain (±30% max), luminance-normalized so exposure is preserved. *Fills the "warm it up" gap that Sprint 3 couldn't satisfy.*
  - **`vibrance` `{ amount }`** (−1..1) — smart saturation in HSL, pushes `amount·(1−s)` so already-saturated/skin tones are protected.
  - **`look` `{ name }`** — named grades `goldenHour | tealOrange | noir | vintageFade | crispClean`, tasteful (≈60%-opacity LUT feel), built from the primitives.
  - **`sharpen` `{ amount }`** (0..1) — Sharp `.sharpen()`, tuned so 1.0 is "crisp" not "crunchy".
- **Editing know-how** (`SKILL.md` + `server/utils/editing-guide.ts`): a real operator playbook — disciplined order of operations with *causal* reasoning (straighten → exposure → tone → whiteBalance → contrast → vibrance → look → sharpen), target-value guard-rails, amateur-mistake avoidance, and an intent→ops translation layer ("warm it up" → `whiteBalance temp+`, "make it pop" → contrast+vibrance not cranked saturation). `EDITING_GUIDE` (~600 words) is injected into every decision prompt; `SKILL.md` is the human-readable canonical doc.
- **Guardrails** (`server/api/edit.post.ts`): `PHASE_ORDER` now the 6-phase order; **no-op detection** (identity params → terminal `done`), **oscillation detection** (a step reversing the previous op, or the same tool 3× with shrinking effect → stop and keep the frame *before* the reversing op — the pragmatic "best so far"; true quality-scored best-frame needs a metric we don't compute), explicit one-op-per-step, and a clear terminal `done` at `MAX_STEPS`.
- **Schema** (`server/utils/agent.ts`): kept **flat** (Sprint 3 lesson), expanded with all 9 tools' param fields + a `lookName` enum + the 6 phases; `agent.ts` reassembles + range-clamps `{tool, params}` per tool after validation.
- **Practice photos**: replaced the picsum stock with 5 curated, minimally-processed, Unsplash-licensed photos that genuinely need editing (flat/hazy, warm cast, crooked horizon) + `public/samples/CREDITS.md`. UI sample picker + `TimelineStep` badges updated for the new tools/phases.

#### Verification
- [x] True sigmoidal contrast (raw-buffer LUT) replaces the linear approximation — 15/15 executor functional tests pass, contrast increases luminance std-dev as expected.
- [x] Oscillation/no-op guardrails implemented; force-stop keeps the pre-oscillation frame as the result.
- [x] Live E2E through the gateway exercises the new tools: warm-café cast → `whiteBalance −45 → exposure → contrast → sharpen`; foggy/hazy → `contrast → whiteBalance → tone → vibrance → sharpen`. The agent follows the editing-guide's pro order.
- [x] Typecheck + eslint fully clean.

### Sprint 4 — original stretch tasks (for reference)
- ~~4.1 ImageMagick `-sigmoidal-contrast` / `-clut`~~ → **superseded**: done in-process with Sharp + raw buffers (see deviation above).
- 4.2 Smarter guardrails — **done** (best-so-far on oscillation, no-op/oscillation detection, one-op-per-step).
- 4.3 (Optional) Final side-by-side confirmation pass — **not done** (deferred; the assess-each-step loop + done-judgment already re-checks against intent every step).

---

## Reference Docs

- Spec: `internal_docs/agentic-image-editor-spec.md`
- Streaming pattern this plan follows on the **server** (UI-message stream + custom `data-*` parts via `writer.write`, the `transient:true` flag for ephemeral progress events): mirror **AIR-Bot** `dashboard/server/api/chats/[id].post.ts` and the **nuxt-ui-templates/chat** `data-chat-title` emit. For per-step *card* rendering, AIR-Bot's `dashboard/app/components/chat/MessageContent.vue` shows the streaming→terminal state morph (spinner while in-flight, result when done) we replicate per timeline card — though we consume via plain `fetch`, not the `Chat` class. Convention docs: `~/claude-ops/conventions/ai_sdk_usage.md`, `~/claude-ops/conventions/nuxt_ui_chat.md` (and our conscious departure from the two-SDK split, noted in Scope).

## Environment / Config Changes

Single key — keep it simple.

| Variable | Required | Description |
|----------|----------|-------------|
| `AI_GATEWAY_API_KEY` | Yes | Vercel AI Gateway key. Routes the vision model. Set the model string in runtime config (default e.g. `anthropic/claude-...`); swap providers without code changes. |
| `AGENT_MODEL` | No | Override the default gateway model string. |
| `MAX_STEPS` | No | Loop cap (default 8). |

Pin versions (from Kyle's current repos): `ai` ^6, `@ai-sdk/vue` ^3, `zod`, `sharp`.

## What's Deferred / Out of Scope
- ~~ImageMagick (sigmoidal contrast, LUT `look`)~~ — **shipped without it** (Sprint 4): true sigmoidal + named-grade `look` done in-process via Sharp + raw buffers. No external binary.
- ~~`whiteBalance`, `tone`~~ — **shipped** in Sprint 4. Still deferred: `crop`, `hueShift`, `toneCurve` (arbitrary control-point curves) — add as needed.
- `retouch` (blemish/face) — explicit non-goal; needs a separate detection/inpainting pipeline.
- Vercel Sandbox executor/storage swap — seams (`StorageAdapter`, `EditExecutor`) kept clean; in-process Sharp (no binary) makes the swap cleaner still.
- Auth, routing, DB, multi-image, persistence beyond the working dir.
- Analytics instrumentation — none; this is a local dev tool, no analytics framework in the project.
- Final side-by-side confirmation pass (Sprint 4.3) — deferred; the per-step assess-vs-intent loop already re-checks each step.

## Open Questions
1. **Default model** for the gateway string — Claude (vision-strong) vs GPT vs Gemini for the "look and decide" judgment? Recommend starting with a Claude vision model and A/B from there.
2. **Streaming vs buffered** for v1 — plan targets streaming (better UX, matches the house pattern). A buffered fallback is trivial if streaming fights us; we'll start streaming.
3. ~~**Contrast in Sharp** — the v1 Sharp S-curve is an approximation~~ — **resolved**: Sprint 4 ships true sigmoidal contrast via a raw-buffer 256-LUT (no ImageMagick).
