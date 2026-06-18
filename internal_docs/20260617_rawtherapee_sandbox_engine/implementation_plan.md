# RawTherapee Develop Engine on Vercel Sandbox — Implementation Plan

**Created:** June 17, 2026
**Status:** Not Started
**Context:** The agent currently renders each develop pass with hand-rolled Sharp pixel math (`server/utils/pixels.ts` + `executor.ts`) — approximate LUTs that re-implement a fraction of a real raw developer and produce artifacts (e.g. the vibrance "neon" bug, commit `1529cfa`). The (frozen) spec anticipated this exact move: *"The Sandbox payoff arrives when edits move beyond the fixed toolset… keep the executor boundary clean now so that transition is additive."*

**Goal:** Replace the Sharp render engine with **RawTherapee** (`rawtherapee-cli` driven by PP3 processing profiles), executed in a **Vercel Sandbox** in production and a local binary in dev — without the vision agent ever learning the PP3 format, and without rewriting the agent loop or timeline UI.

**Scope:**
- **In:** a `DevelopEngine` seam with three runners (Sharp fallback, RawTherapee-local, RawTherapee-sandbox); a deterministic `DevelopConfig → PP3` mapper; a richer parametric `DevelopConfig`; sandbox lifecycle (snapshot + per-session reuse); adopting `@ai-sdk/vue`'s `useChat` for multi-turn refinement.
- **Out:** full Eve-framework migration; durable Workflow-backed sessions; letting the model author PP3 directly; raw (camera RAW) ingestion — inputs stay JPEG.

---

## Decisions (settled before drafting)

| Fork | Decision | Why |
|------|----------|-----|
| **Engine** | RawTherapee, **Sandbox-primary** with a local `rawtherapee-cli` escape hatch (`RT_EXECUTION=sandbox\|local\|sharp`) | User wants Sandbox primarily but easy dev. Same PP3 builder feeds all runners; only the "run the binary" call differs. No local emulator exists for Sandbox (unlike Inngest) — but the same SDK runs from `npm run dev` against the real microVM via `vercel env pull`, so dev is one `RT_EXECUTION` flag away from either path. |
| **Agent → edits** | Expanded **flat semantic `DevelopConfig`** → deterministic server-side PP3 mapper. Model never sees PP3. | PP3 is a niche corpus that fails *silently* on malformed keys/curves (verified). Models reason reliably about semantic photo concepts. Keeps the flat Zod schema (the documented fix for the sonnet JSON-loop bug) and keeps timeline chips meaningful. |
| **Orchestration** | Adopt `@ai-sdk/vue` `useChat` for the client; keep image state as `data-step` parts + plain client refs. **No** Eve migration. | Server is already `createUIMessageStream`-shaped, so `useChat` deletes ~95 lines of SSE plumbing and gives multi-turn refinement nearly free. Stays in the Vercel ecosystem for robustness. Three known edges (below) are scoped, not blockers. |

---

## Current State

### What Exists
- `server/utils/executor.ts` — `EditExecutor.renderConfig(originalPath, config)` builds an ordered `Operation[]` from the non-identity config fields and chains them through Sharp. **This is the seam we swap.**
- `server/utils/pixels.ts` — the raw-buffer math (`applyTone`, `applyVibrance`, `applyWhiteBalance`, `buildSigmoidalLut`, `applyChannelLut`, `applyGrayscale`). The surface RawTherapee replaces.
- `server/utils/agent.ts` — `decideConfig()` (vision + flat Zod `configSchema`), `clampConfig`, `diffConfig`, `equalConfig`, `configToText`. The schema is **flat by necessity** (nested config → sonnet repetition loop → `AI_JSONParseError`).
- `server/utils/tools.ts` — the 9-tool registry → `describeTools()` prompt block + drives the schema shape.
- `server/utils/editing-guide.ts` — `EDITING_GUIDE`, the 49-line decision policy in the prompt.
- `server/utils/storage.ts` — `LocalStorageAdapter` over `.data/sessions/<id>/` (`original.jpg`, `step-NN.jpg`, `step-NN.json` config snapshots). The **other** documented swappable seam.
- `server/api/edit.post.ts` — the loop: `createUIMessageStream` emitting `data-step` parts (`deciding` transient → `applied`/`done`/`error`), `fromStep` branching, `MAX_STEPS` cap.
- `app/pages/index.vue` — client: raw `fetch('/api/edit')` + manual SSE `readStream()` → `stepMap`; setup/running/done views; `fromStep`, `resultStep`, lightbox state.
- `shared/types.ts` — `DevelopConfig`, `Decision`, `StepEvent`, `DEFAULT_CONFIG`.

### What Changes
- **New** `DevelopEngine` interface — keeps the existing **stateless** `renderConfig` seam, just adds a `sessionId` arg + a `dispose(sessionId)` hook (no-op for Sharp/local). 3 runners (Sharp / RT-local / RT-sandbox) selected by `RT_EXECUTION`. No `open()`/`RenderSession` object — only the sandbox runner has state, and it keeps a warm-VM cache keyed by `sessionId` *internally*.
- **New** `server/utils/pp3.ts` — `configToPp3(config): string`, the only place that knows PP3.
- **New** `server/utils/engines/sandbox.ts` — per-session sandbox lifecycle (snapshot `getOrCreate`, upload original once, render, stop on `dispose`).
- **Expanded (Sprint 4, decoupled)** `DevelopConfig` + Zod schema + tools registry + editing-guide with RawTherapee-grade parametric controls. **Sprints 1+2 ship the engine swap at the current field count first** — the richer config rides on top later so the field-count growth doesn't endanger the flat-schema JSON-loop guard during the swap.
- **Minimal refactor** `edit.post.ts` loop: swap the per-iteration `executor.renderConfig(originalPath, next)` for `engine.renderConfig({ sessionId: id, originalPath, config: next })`; add `engine.dispose(id)` in a `finally`. **No loop restructuring.**
- **Refactored** `index.vue` client to `useChat`.
- `look` enum grades re-expressed as real PP3 base profiles layered under the agent's delta (`-p look.pp3 -p delta.pp3`).

### What Stays
- The vision-in-the-loop agent contract, the flat schema discipline, the timeline UI components (`TimelineStep.vue`, `ImageLightbox.vue`), the storage layout, `fromStep` branching semantics, the AI Gateway model routing. Sharp stays for **input normalization** (`writeOriginal`) and as the `RT_EXECUTION=sharp` fallback.

---

## Architecture

```
                 app/pages/index.vue  ── useChat ──▶  POST /api/edit
                       ▲                                   │
              data-step parts (timeline)                   ▼
                       │                         server/api/edit.post.ts  (loop)
                       │                                   │
                       │                    decideConfig()  │  engine.renderConfig(
                       │                    (flat schema)   │   {sessionId,original,config}) ×N
                       └───────────────────────────────────┘      ▼ engine.dispose(sessionId)
                                                         DevelopEngine  (RT_EXECUTION)
                                                ┌──────────────┼─────────────────┐
                                          SharpEngine    RtLocalEngine     RtSandboxEngine
                                          (fallback)     spawn cli         @vercel/sandbox
                                                              │                 │
                                                              └── configToPp3() ─┘  (shared)
                                                                       │
                                                              rawtherapee-cli -p delta.pp3
```

The agent decides in **semantic sliders**; `configToPp3()` is the single serialization choke point; the engine runner is the only thing that differs across dev/prod.

---

## Sprint Breakdown

### Sprint 1: PP3 mapper + DevelopEngine seam (Sharp + RT-local) — Foundational
**Goal:** Render the **current** `DevelopConfig` (9 ops) through `rawtherapee-cli` locally, behind the existing stateless engine seam, with **no neon vibrance and no artifacts** (the bar is "clean," not pixel-parity — RT's demosaic/sharpen defaults will look *different from* Sharp, and better). No sandbox, no schema changes.
**Estimated effort:** 4–5 hours

#### Tasks
- 1.0 **(critical path, do first)** Write `rawtherapee_pp3_reference.md` from an **authoritative source**: install `rawtherapee-cli` locally, hand-edit one image in the RawTherapee GUI (or use `-O`), and capture a **real emitted `.pp3`** as the ground truth for section/key names and the `Curve=<type>;x;y;…` encoding. Do **not** code the mapper from memory — PP3 keys fail *silently* when wrong. Confirm the keys this plan names (`[Exposure] Compensation`/`Contrast`/`HighlightCompr`/`ShadowCompr`, `[White Balance] Temperature`/`Green`, `[Vibrance] Pastels`/`ProtectSkins`, `[Sharpening]`, `[Rotation] Degree`, `[Crop]`) against that file; correct any that don't match.
- 1.1 `shared/types.ts` — add a **stateless** `DevelopEngine` interface mirroring today's seam: `renderConfig(args: { sessionId: string, originalPath: string, config: DevelopConfig }): Promise<Buffer>` plus `dispose(sessionId: string): Promise<void>`. No `open()`/`RenderSession` object. Sharp/local implement `dispose` as a no-op; only the sandbox runner (Sprint 2) keeps an internal warm-VM cache keyed by `sessionId`.
- 1.2 `server/utils/pp3.ts` — `configToPp3(config: DevelopConfig): string`, driven by the **9-op grouping** the executor already uses (`tone` = highlights+shadows, `whiteBalance` = temp+tint). Map to the section/keys verified in 1.0. Map `vibrance` → `[Vibrance] Pastels` with `ProtectSkins=true` — **this is where the neon/over-saturation bug (commit `1529cfa`) dies**, at the current field count. Emit only changed sections (partial PP3; RT fills defaults). Pure function.
- 1.3 `server/utils/engines/sharp.ts` — wrap the existing `EditExecutor.renderConfig(originalPath, config)` behind `DevelopEngine` (ignore `sessionId`; `dispose` is a no-op). Zero behavior change; the `RT_EXECUTION=sharp` fallback.
- 1.4 `server/utils/engines/rt-local.ts` — `RtLocalEngine.renderConfig`: write `delta.pp3` (+ stage the original) to a temp dir, spawn `rawtherapee-cli -Y -o out.jpg -q -j90 -p look.pp3 -p delta.pp3 -c input.jpg`, return the output buffer; clean the temp dir. Resolve the binary from `RT_BIN` (default `rawtherapee-cli`). Extract a shared `buildRtArgs()` helper here for Sprint 2 to reuse.
- 1.5 `server/utils/engines/index.ts` — `getEngine()` factory keyed on `RT_EXECUTION` (`sharp` | `local` | `sandbox`). **Default `local` for now**; `sandbox` is wired in Sprint 2 (until then it falls back to `local` with a warn).
- 1.6 `server/api/edit.post.ts` — minimal swap: per iteration call `engine.renderConfig({ sessionId: id, originalPath: storage.pathFor(id,'original'), config: next })` in place of `executor.renderConfig(...)`; add `engine.dispose(id)` in a `finally`. No loop restructuring.
- 1.7 `looks/` PP3 base profiles — author the 5 named looks (`goldenHour`, `tealOrange`, `noir`, `vintageFade`, `crispClean`) as committed `.pp3` files layered via the first `-p`. **Note:** these are hand-tuned art-direction (not a mechanical port of `applyLook` in `executor.ts`); budget eyeball iteration. Replaces `applyLook`/`applyChannelGainOffset` for the RT runners (Sharp runner keeps its own).

#### Verification
- [ ] Unit: `configToPp3()` snapshot tests for DEFAULT_CONFIG (→ empty/near-empty), a warm-exposure config, a noir look — assert section/key presence matches the 1.0 ground-truth, no invented keys.
- [ ] `RT_EXECUTION=local` end-to-end on a sample image renders a clean result; the prior neon-vibrance case is gone.
- [ ] `RT_EXECUTION=sharp` reproduces the old behavior (regression guard).
- [ ] `npx nuxi typecheck` + `eslint` clean.

---

### Sprint 2: Vercel Sandbox runner — Production execution
**Goal:** `RT_EXECUTION=sandbox` renders via `@vercel/sandbox` with RawTherapee pre-baked into a snapshot and the sandbox reused per session.
**Estimated effort:** 5–6 hours

#### Tasks
- 2.1 `npm i @vercel/sandbox`. Add env: `RT_EXECUTION`, `VERCEL_OIDC_TOKEN` (dev via `vercel env pull`), `RT_SNAPSHOT_ID`, `RT_BIN`. Update `.env.example` + `nuxt.config.ts` `runtimeConfig`.
- 2.2 `scripts/build-rt-snapshot.ts` — one-time setup: `Sandbox.create({ runtime: 'node24' })`, install RawTherapee (Amazon Linux 2023 = **dnf, not apt**; if no dnf package, vendor the official **AppImage** via `writeFiles` mode `0o755` + `--appimage-extract`, run `squashfs-root/usr/bin/rawtherapee-cli`), verify `rawtherapee-cli --version`, `sandbox.snapshot()`, print the snapshot id for `RT_SNAPSHOT_ID`. Document the AppImage URL + verification in a companion doc.
- 2.3 `server/utils/engines/rt-sandbox.ts` — `RtSandboxEngine` holds an internal `Map<sessionId, Sandbox>`. First `renderConfig` for a `sessionId` lazily `Sandbox.getOrCreate({ name: sessionId, source: { type:'snapshot', snapshotId } })` and uploads `original.jpg` + the `look.pp3` bases **once**; subsequent renders in the same loop reuse the warm VM. Each render: `writeFiles(delta.pp3)` → `runCommand('rawtherapee-cli', buildRtArgs(...))` → `readFileToBuffer(out.jpg)`. `dispose(sessionId)`: `sandbox.stop()` + drop from the map. Reuse `configToPp3()` + `buildRtArgs()` from Sprint 1 so only the *transport* differs from `rt-local`.
- 2.4 **Reuse vs. cleanup (resolved):** the big win is **within-loop** reuse (N renders, one upload, one warm VM). On loop end `dispose()` stops the VM. Cross-turn refinement (Sprint 4) re-`getOrCreate`s from the snapshot, which is fast — we accept a fast recreate over a long-lived idle VM to avoid leaks/cost. (If cross-turn warm reuse later proves worth it, add an idle TTL reaper instead of stopping on dispose — deferred.)
- 2.5 Error/timeout: per-render command timeout, non-zero `exitCode` → throw with `stderr` (already surfaces as a `data-step` `error`). Set the sandbox timeout to cover a full `MAX_STEPS` loop; `dispose()` in the loop's `finally` so a VM never leaks even on error/abort.
- 2.6 Cold-start mitigation: kick off `getOrCreate` (warm the VM + upload original) concurrently with the first `decideConfig()` vision call so provisioning overlaps the model's first decision.

#### Verification
- [ ] `vercel env pull` → `RT_EXECUTION=sandbox npm run dev` → full loop renders against a real iad1 microVM; frames stream into the timeline.
- [ ] Snapshot reuse: second session create is fast (no reinstall); log create vs cold time.
- [ ] Kill a run mid-loop → sandbox is stopped (no leak); check via SDK/dashboard.
- [ ] A forced `rawtherapee-cli` error renders an `error` timeline card with stderr, loop halts cleanly.

---

### Sprint 3: Richer parametric DevelopConfig — the second robustness lever
**Goal:** Grow the flat config with RawTherapee-grade controls the agent can wield, so edits get genuinely more capable than the current global sliders.
**Estimated effort:** 4–5 hours

> **Decoupled from the engine swap.** Sprints 1+2 already deliver "more robust editing" on their own — RT's real algorithms + the neon-bug fix at the *current* field count, independently shippable. This sprint is a separate deliverable layered on top; ship it on its own merits after 1+2 are proven, not as part of the swap.
>
> **JSON-loop risk:** this roughly doubles the flat schema's field count, which is exactly the pressure that triggered the sonnet repetition loop the flat schema was built to avoid. **Mitigation:** add fields incrementally (tone curve first, then split-tone, then dehaze/NR), and after each addition smoke-test a few runs watching for `finishReason: 'length'` / `AI_JSONParseError`. If it regresses, stop adding fields and consider grouping the least-used controls behind a second decision call rather than nesting the schema.

#### Tasks
- 3.1 `shared/types.ts` — extend `DevelopConfig` (stay flat, every field present): parametric tone curve `tcHighlights/tcLights/tcDarks/tcShadows` (-100..100), split-tone `splitShadowHue/splitShadowSat/splitHighlightHue/splitHighlightSat/splitBalance`, `dehaze` (0..100), `nrLuminance/nrChroma` (0..100). Update `DEFAULT_CONFIG`. (The skin-safe `vibrance` → `[Vibrance] Pastels`/`ProtectSkins` mapping already landed in Sprint 1.2.)
- 3.2 `server/utils/pp3.ts` — extend the mapper: parametric tone curve → `[ToneCurve]` parametric form; split-tone → `[ColorToning]` (Method=splitco / L*a*b*); `[Dehaze]`; `[Directional Pyramid Denoising]`/`[RAW]` NR keys. Keep emitting only non-identity sections.
- 3.3 `server/utils/tools.ts` — add registry entries for the new controls (descriptions + ranges) so `describeTools()` teaches them.
- 3.4 `server/utils/agent.ts` — extend the flat `configSchema` + `clampConfig` + `configToText` + `diffConfig` with the new fields. **Hold the flat shape** — no nesting (the JSON-loop guard).
- 3.5 `server/utils/editing-guide.ts` — extend `EDITING_GUIDE`: when to reach for the parametric tone curve vs. exposure/tone, split-toning for cinematic grades (can replace some `look` usage), dehaze for haze, NR sparingly. Preserve the restraint framing ("3–5 sliders").
- 3.6 `TimelineStep.vue` — ensure new ops render as chips (the chip mapper is config-driven via `diffConfig`; confirm labels/units read well).

#### Verification
- [ ] `configToPp3()` snapshot tests for the new fields; assert section/key names against a real binary-emitted PP3 (extend the 1.0 ground-truth with a GUI edit that exercises tone curve / color toning / dehaze / NR). `[Dehaze]` and the parametric `[ToneCurve]` encoding are **unverified** until then — confirm before coding.
- [ ] End-to-end: an intent that needs the tone curve (e.g. "lift the shadows but keep highlights crisp") visibly uses `tc*` and looks better than the old single-tone approach.
- [ ] "make it cinematic" reaches for split-tone, not a heavy-handed `look`.
- [ ] Timeline chips render the new ops cleanly (light + dark mode).

---

### Sprint 4: `useChat` client + multi-turn refinement
**Goal:** Swap the bespoke `fetch`/SSE client for `@ai-sdk/vue` `useChat`, enabling conversational refinement ("now make it warmer") while keeping the timeline and image state intact.
**Estimated effort:** 4–5 hours

#### Tasks
- 4.1 `app/pages/index.vue` — replace `readStream()`/`stepMap` with `useChat({ transport: DefaultChatTransport({ api: '/api/edit' }) })`. Derive the `steps` array from `messages.flatMap(parts).filter(type==='data-step')`.
- 4.2 **Edge 1 — transient `deciding`:** transient parts don't land in `message.parts`; capture them in an `onData` side-buffer for the "Deciding…" spinner (or, simpler, make `deciding` non-transient and dedupe by `id`). Pick one, note the choice.
- 4.3 **Multi-turn refinement:** a follow-up message calls `sendMessage({ text }, { body: { id, fromStep: lastResultStep } })`; server already reads `fromStep`/`id` off the body — derive the base frame from that body field, **not** from message history. Each refinement appends frames (existing branch numbering).
- 4.4 **Edge 2 — unused history:** `useChat` POSTs the full `messages[]` the server ignores; leave it (harmless) but note it so future-us doesn't wire state through it.
- 4.5 **Edge 3 — `fromStep` branching:** keep "continue from step N" and "use as result" as plain client refs alongside `useChat` (confirmed clean); only `render` dispatch goes through `sendMessage`.
- 4.6 Keep `InputPanel.vue`/`TimelineStep.vue`/`ImageLightbox.vue` prop contracts; they already take a `StepEvent`.

#### Verification
- [ ] Run an edit → timeline streams identically to today (data parts).
- [ ] Follow-up "make it warmer" → new turn continues from the prior result, appends frames, doesn't restart from original.
- [ ] `deciding` spinner still shows; `error` cards still render.
- [ ] `fromStep` branch + `use-as-result` + lightbox still work. Typecheck/eslint clean.

---

## Reference Docs (companion files in this folder)
- `rawtherapee_pp3_reference.md` — verified PP3 sections/keys + the curve encoding (`Curve=<type>;x;y;…`), the exact `rawtherapee-cli` flags, and the `configToPp3` field→section mapping table. (Write during Sprint 1.)
- `sandbox_setup.md` — the snapshot build steps, the AppImage URL, auth (`vercel env pull` / OIDC), iad1 + cost notes. (Write during Sprint 2.)

## Environment / Config Changes

| Variable | Required | Description |
|----------|----------|-------------|
| `RT_EXECUTION` | no | `sandbox` \| `local` \| `sharp`. Selects the `DevelopEngine` runner. **Default `local` through Sprint 1; flipped to `sandbox` once Sprint 2 lands** (and that's the production default). |
| `RT_BIN` | no | Path to `rawtherapee-cli` for `local` (default `rawtherapee-cli`). |
| `RT_SNAPSHOT_ID` | for `sandbox` | Snapshot id from `scripts/build-rt-snapshot.ts`. |
| `VERCEL_OIDC_TOKEN` | for `sandbox` (dev) | From `vercel env pull`; auto in Vercel deploys. Refresh ~12h. |
| `AI_GATEWAY_API_KEY`, `AGENT_MODEL`, `MAX_STEPS` | unchanged | Existing. |

## Production Safety (deploy notes — no live users today)
- **Sandbox is iad1-only**: deploy the Nuxt app to a US-East region to minimize per-render round-trip; each `render()` ships a PP3 + reads a JPEG buffer.
- **Cost guard**: a runaway loop = many renders. `MAX_STEPS` already caps it; `close()` in `finally` prevents sandbox leaks. Renders bill ~sub-cent each (active-CPU only).
- **Auth fragility**: OIDC token expires ~12h in dev; surface a clear error ("run `vercel env pull`") rather than a raw 401. Production deploys inject it automatically.
- **Graceful degradation**: if `RT_EXECUTION=sandbox` but auth/snapshot is missing, fall back to `local` (if `RT_BIN` resolves) else `sharp`, logging the downgrade — never hard-crash a render.
- **Snapshot expiry**: snapshots expire 30 days after last use; document re-baking in `sandbox_setup.md`.

## What's Deferred / Out of Scope
- Full **Eve** framework migration / durable Workflow-backed sessions (revisit if sessions need to survive redeploys or run >sandbox-timeout).
- Letting the model author **PP3 directly** or emit free curve control-points.
- **Camera RAW** ingestion (inputs stay JPEG; the engine supports raw later for ~free).
- **Local Adjustments** / masked spot edits (drivable via PP3 but verbose — a later "more robust" round).
- A persistent sandbox **pool** across sessions (current plan is per-session getOrCreate).

## Open Questions
1. Pre-bake RawTherapee via **dnf** (if an Amazon-Linux-2023 package exists) or **vendor the AppImage**? Resolve empirically in Sprint 2.2; AppImage is the safe default.
2. Should `look` grades stay as 5 fixed PP3 bases, or be retired in favor of split-tone params now that the agent has real color-grading sliders? Lean: keep them (one-move convenience) but let the editing-guide prefer parametric grades for nuance.
