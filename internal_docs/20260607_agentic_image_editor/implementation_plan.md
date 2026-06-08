# Agentic Image Editor — Implementation Plan

**Created:** June 7, 2026
**Status:** Not Started
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

### Sprint 1: Single-page UI shell — Foundational  [Not Started]
**Goal:** The page renders the full editor layout with mock/static data — dropzone, intent box, Run button, and a timeline of placeholder step cards — before any backend exists.
**Estimated effort:** ~2 hours

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
- [ ] `npm run dev`, page renders the editor layout in light + dark mode (Playwright screenshot).
- [ ] Dropzone accepts a file and shows a preview; fake timeline cards render with thumbnails + spinners.
- [ ] `npx nuxi typecheck` clean.

---

### Sprint 2: Storage + Executor + image routes — Foundational  [Not Started]
**Goal:** A session can be created from an uploaded image and intermediates can be served, with a Sharp-backed executor that applies the core operations — all testable by curl, no agent yet.
**Estimated effort:** ~3 hours

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
- [ ] `curl -F image=@test.jpg /api/session` returns an id; `original.jpg` lands in `.data/sessions/<id>/`.
- [ ] A tiny node script calls `EditExecutor.apply` for each of the 4 tools and writes visibly-different outputs.
- [ ] `GET /api/image/<id>/original` returns the image bytes.

---

### Sprint 3: The agent loop + live streaming timeline — Core  [Not Started]
**Goal:** The real thing — `POST /api/edit` runs the manual vision loop through AI Gateway and streams `data-step` events; the timeline renders each step live as it arrives, ending in a downloadable final image.
**Estimated effort:** ~4 hours

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
- [ ] End-to-end in the browser (Playwright): drop a deliberately-crooked, flat image, intent "straighten and add warmth and contrast," watch cards stream in, confirm the final looks corrected. Screenshot the streaming-mid-run state and the final state.
- [ ] Network tab shows the streamed response; cards appear incrementally, not all at once.
- [ ] Download yields the final jpg.

---

### Sprint 4 (Stretch): ImageMagick contrast/LUT + guardrails  [Deferred]
**Goal:** Richer tone control + loop safety. Only after Sprints 1–3 feel good.
**Estimated effort:** ~3 hours

#### Tasks
- 4.1 Add an ImageMagick path in `EditExecutor` for ops Sharp does poorly: `-sigmoidal-contrast` (tuned `contrast`) and `-clut` for a `look` `{ lutName }` tool over named `.cube`/png LUTs. Shell out via `execFile`; keep the executor interface unchanged. Document the ImageMagick binary dependency in README.
- 4.2 Smarter guardrails (spec §Guardrails) — the plain `MAX_STEPS` cap already ships in Sprint 3; here we add: "best so far" return at the cap, oscillation/no-op detection (if two consecutive steps undo each other or assessment stops improving, force `done`), and explicit one-op-per-step enforcement.
- 4.3 (Optional) Final side-by-side confirmation pass (original vs result) before returning done.

#### Verification
- [ ] Sigmoidal contrast visibly better than the Sharp approximation on a flat image.
- [ ] Forcing an oscillation triggers the stop path and returns the best frame.

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

## What's Deferred / Out of Scope (v1)
- ImageMagick (sigmoidal contrast, LUT `look`) → Sprint 4 stretch.
- `crop`, `whiteBalance`, `hueShift`, `tone`, `toneCurve` tools — start with 4 core ops, add as needed.
- `retouch` (blemish/face) — explicit non-goal; leave a stub, needs a separate detection/inpainting pipeline.
- Vercel Sandbox executor/storage swap — seams kept clean now, implemented later.
- Auth, routing, DB, multi-image, persistence beyond the working dir.
- Analytics instrumentation — none; this is a local dev tool, no analytics framework in the project.

## Open Questions
1. **Default model** for the gateway string — Claude (vision-strong) vs GPT vs Gemini for the "look and decide" judgment? Recommend starting with a Claude vision model and A/B from there.
2. **Streaming vs buffered** for v1 — plan targets streaming (better UX, matches the house pattern). A buffered fallback is trivial if streaming fights us; we'll start streaming.
3. **Contrast in Sharp** — the v1 Sharp S-curve is an approximation; acceptable until Sprint 4's sigmoidal path?
