# Editor Tools & Inspect — Implementation Plan

**Created:** June 20, 2026
**Status:** ✅ Complete — all 4 sprints shipped and verified (June 20, 2026). Verification artifact at `verification/index.html`. Not yet committed (awaiting Kyle's go).
**Context:** Kyle flagged three rough edges in the Agentic Image Editor: (1) the in-page header eats a band of vertical space and forces scrolling in the editing view; (2) the agent lacks the geometry + local-edit tools a real editor would reach for (crop, straightening guides, gradient/regional masks); (3) the lightbox is a static `object-contain` image with no zoom, no inspect, and no way to compare against the original.

**Goal:** Reclaim the header's space so the cockpit fits the viewport, give the agent a crop tool + a straightening grid and a regional graduated-filter edit, and turn the lightbox into a real inspection surface (zoom/pan + before/after compare).

**Scope:**
- **In:** Header/layout slimming; a `crop` tool (native RawTherapee `[Crop]`); a human rule-of-thirds/crop grid overlay; stronger straighten guidance; one regional **linear graduated filter** (darken-sky / brighten-foreground); lightbox zoom/pan, fit/100%, before/after slider, keyboard shortcuts.
- **Out (v1):** Radial masks, per-region color/contrast adjustments, >1 mask slot, brush/AI-object masks, healing/clone, generative fill, side-by-side compare, DB persistence. See "What's Deferred." Several of these are out specifically because RawTherapee's pp3 doesn't natively/verifiably support them yet (see the Engine Reality section).

---

## ⚠️ Engine Reality (read before anything else — this reframes the whole backend)

The earlier draft of this plan was wrong about the rendering engine. The corrected facts, verified against the code on this machine:

- The renderer is a swappable **`DevelopEngine`** (`src/shared/types.ts:177`) chosen by `getEngine()` (`src/server/utils/engines/index.ts`) keyed on `RT_EXECUTION`. Engines: `engines/rt-local.ts` (RawTherapee CLI), `engines/rt-sandbox.ts` (RT in a Vercel microVM, **prod**), `engines/sharp.ts` (Sharp fallback).
- **The default is `local` = RawTherapee, and `rawtherapee-cli` IS installed here** (`~/.local/bin/rawtherapee-cli`). So on Kyle's dev box and in prod, the live renderer is **RawTherapee**, not Sharp. Sharp is only the degraded fallback.
- `edit.post.ts:76,170` calls `engine.renderConfig({ sessionId, originalPath, config })` (the object-arg `DevelopEngine` seam), NOT `executor.renderConfig(originalPath, config)` directly. The Sharp engine bridges the two (`engines/sharp.ts`).
- RawTherapee rendering is driven by **`src/server/utils/pp3.ts`** (`configToPp3`) — it serializes a `DevelopConfig` to a partial RawTherapee pp3. This is where the advanced fields (toneCurve/splitTone/dehaze/denoise) actually render; the Sharp `EditExecutor` does NOT implement them. **Any new tool must be added to `pp3.ts` to work in the running app.**
- **pp3 fails SILENTLY on a wrong/invented key.** Only emit keys verified in the authoritative reference `internal_docs/20260617_rawtherapee_sandbox_engine/rawtherapee_pp3_reference.md` (round-trip-verified against the RT 5.12 binary).

What this means per tool:
- **Crop is easy and safe on RT:** `[Crop]` is verified in the reference doc — keys `Enabled, X, Y, W, H, FixedRatio, Ratio, Orientation, Guide` (X/Y/W/H in pixels; `X=-1 Y=-1` = auto).
- **Regional masks are the hard part on RT:** `[Graduated Filter]`, radial filters, and Locallab are **NOT in the reference doc and NOT verified.** They cannot be emitted blind (silent failure). So Sprint 3 needs a **verification spike** (emit candidate keys, render against the binary, confirm the output changes and round-trips) BEFORE wiring the tool — or implement masks Sharp-only and accept they no-op on RT. The plan takes the spike-first path and scopes v1 to a single linear graduated filter.

**Backend implementation order for every new field:** `types.ts` (DevelopConfig + DEFAULT_CONFIG + ToolName) → `tools.ts` (registry) → `agent.ts` (flat zod field + clamp + configToText + diffConfig + equalConfig) → `pp3.ts` (RT render, verified keys) → `executor.ts` (Sharp parity) → `editing-guide.ts` + root `SKILL.md` + `src/README.md` (docs). Miss `pp3.ts` and the feature is invisible in the running app; miss the docs and they drift.

---

## Handoff / Execution Notes (read first — this plan is self-contained)

**Repo & runtime**
- App root: `/Users/kylejohnson/Programming/Workspace/agentic-image-editor`. The Nuxt app is under `src/` (`app/`, `server/`, `shared/`, `public/`, `package.json`). **Docs live at repo-root `internal_docs/` and root `SKILL.md`/`README.md`** (NOTE: `README.md` is at `src/README.md`; `SKILL.md` is at repo root — confirm each path before editing).
- Commands (from `src/`): `npm run dev` (port 3000), `npm run typecheck`, `npm run lint`. Confirm exact script names in `src/package.json`. **No automated test suite** — verification is typecheck + lint + Playwright + live agent runs.
- The agent loop calls a live model via the Vercel AI Gateway (`AI_GATEWAY_API_KEY`, `AGENT_MODEL` default `anthropic/claude-sonnet-4-6`) — needs a key in `src/.env` for end-to-end. RawTherapee renders locally (no key). UI sprints (1, 4) verify without a model key (load a sample, open the lightbox); backend sprints (2, 3) need the key to watch the agent pick the new tools.

**Conventions to match**
- UI: **Nuxt UI v4** + Tailwind v4, monochrome theme (`--ui-primary` black/white via `src/app/assets/css/main.css`; primary `neutral` in `src/app/app.config.ts`). Font: Public Sans. Use semantic tokens (`text-highlighted`, `text-muted`, `text-dimmed`, `bg-elevated`, `bg-elevated/40`, `ring-default`, `text-inverted`) — mirror `EditorStage.vue`, `Filmstrip.vue`, `CommandBar.vue`.
- State lives in composables under `src/app/composables/` (`useImageInput.ts`, `useLightbox.ts`, `useEditTimeline.ts`); `src/app/pages/index.vue` wires them. Keep new client state in composables.
- TS, `<script setup lang="ts">`, Vue 3. Moderate comments — a short "why" header per file/function (see `types.ts`, `pixels.ts`).

**THE load-bearing schema constraint (`src/server/utils/agent.ts:8-21`)**
The structured-output schema fed to `generateObject` **must be fully flat — every field present, no nesting, no arrays, no optionality** — or claude-sonnet-4-6 falls into a JSON repetition loop through the Gateway (`finishReason: length` → `AI_JSONParseError`). This is why `splitTone`'s sub-params are flattened (`splitShadowHue`, …). **Every new tool here — crop and the mask — must use flat, fixed-slot prefixed fields. Do NOT add a `masks: LocalMask[]` array.**

**Contracts spelled out inline**
- `DevelopConfig` (`src/shared/types.ts`): flat, one ABSOLUTE value per slider, identity values in `DEFAULT_CONFIG`. Server re-renders the whole image FROM the original each iteration in a fixed order (no compounding). New fields MUST get a `DEFAULT_CONFIG` identity.
- Agent emits the FULL config every step; `clampConfig` enforces ranges; `equalConfig` (eps 1e-3) is the convergence guard; `diffConfig` builds the timeline chips. All three must learn any new field or convergence/diff breaks.
- Render order — RT (`pp3.ts` is section-ordered) and Sharp (`executor.ts:333-368`: straighten → exposure → tone → whiteBalance → contrast → vibrance → saturation → look → sharpen). **Crop is geometry → right after straighten. The graduated filter is regional polish → after global tonal/color, before sharpen.**
- Image URLs: original = `/api/image/<sessionId>/original` (immutable, cached 1y); step = `/api/image/<sessionId>/<n>` (no-store). Storage: `.data/sessions/<id>/original.jpg`, `step-NN.jpg`, `step-NN.json`.

**Execution order & rules**
- **1 → 2 → 3 → 4.** Sprint 1 (header) is independent and fastest. Sprints 2 & 3 edit the same backend files and 3 builds on 2 — sequential. Sprint 4 reuses the grid overlay from Sprint 2.
- Per-sprint loop: implement → `npm run typecheck` + `npm run lint` → Playwright walkthrough (UI) or live agent run (backend) → update this file's Status + checkboxes (incl. the docs-updated checkbox) → report to Kyle before the next sprint.
- **Commit/push only when Kyle asks.** Keep the tree clean of stray screenshots (promote keepers to `verification/screenshots/`, delete the rest).

---

## Current State

### What Exists
- **Layout/header:** `src/app/pages/index.vue` — `<UContainer class="py-8 sm:py-12">`; in-page header (`mb-8 sm:mb-10`) with `<h1>` "Agentic Image Editor" (≈line 414) + subtitle + (editing view) "Steps"/"Undo last step"/"New image". Editing grid locked to `lg:h-[calc(100vh-13rem)]` (≈line 487). The **global `UHeader`** in `src/app/app.vue` (≈lines 30-35) already shows the product name — the in-page `<h1>` is redundant with it.
- **Engine + agent contract:** `src/server/utils/engines/{index,rt-local,rt-sandbox,sharp}.ts`, `src/server/utils/pp3.ts` (RT render), `src/server/utils/executor.ts` (Sharp fallback render), `src/shared/types.ts`, `src/server/utils/tools.ts`, `src/server/utils/agent.ts`, `src/server/utils/editing-guide.ts`, `src/server/utils/pixels.ts`.
- **Geometry today:** only `straighten` (RT `[Rotation]` / Sharp rotate + inscribed-rect crop). No crop, no masks, no regional edits — all ops global.
- **Lightbox:** `src/app/components/ImageLightbox.vue` (UModal, static `object-contain`, prev/next + arrow keys, op-chip footer, download); `src/app/composables/useLightbox.ts` (builds `LightboxFrame[]` from original + applied steps); `EditorStage.vue` opens it via `@open`. No zoom/pan/compare.
- **Docs:** root `SKILL.md` (tool table + magnitudes), `src/README.md` (Toolset table + a "Deferred" list that currently includes `crop`), `editing-guide.ts` (ORDER OF OPERATIONS prose), `src/.env.example` (env vars). No analytics, no DB, no auth.

### What Changes
- `index.vue`/`app.vue`: remove the redundant in-page header in editing view, relocate its buttons, slim setup padding, shrink the `calc()`. (Sprint 1)
- `types.ts`/`tools.ts`/`agent.ts`/`pp3.ts`/`executor.ts`/`editing-guide.ts`/`SKILL.md`/`README.md`: add `crop` and one `gradFilter`. (Sprints 2, 3)
- New `GridOverlay.vue` (thirds + crop frame), used in stage + lightbox. (Sprint 2)
- New `useZoomPan.ts`; `ImageLightbox.vue` gains zoom/pan, fit/100%, before/after slider, keyboard map. (Sprint 4)

### What Stays
- Non-destructive render-from-original model; flat-schema discipline; the `DevelopEngine` seam; `Filmstrip.vue`, `AgentRail.vue`, `CommandBar.vue`, storage format, image API URLs.

---

## Sprint Breakdown

### Sprint 1: Reclaim the header — fastest win
**Status:** Complete
**Goal:** Editing view fits the viewport without scrolling; setup view stays welcoming but tighter.
**Estimated effort:** 1.5–2 hours

#### Tasks
- 1.1 Editing view (`view !== 'setup'`): remove the in-page `<h1>` + subtitle block from `index.vue` (~410–419). The global `UHeader` already carries the name.
- 1.2 **(DECIDED — slim in-page toolbar.)** Relocate editing-view actions ("Steps" mobile toggle, "Undo last step", "New image") into a slim toolbar row directly above the editing grid (replacing the removed header block). Keep the row compact (single line, `shrink-0`, modest vertical padding) and only shown when `view !== 'setup'`. Group the buttons right-aligned to mirror the prior header layout. (Kyle chose the in-page toolbar over the global `UHeader #right` slot.)
- 1.3 Setup view: keep title + subtitle (onboarding copy) but tighten `UContainer` `py-8 sm:py-12` → ~`py-6` and header `mb-8 sm:mb-10` → ~`mb-6`.
- 1.4 Recompute the editing-grid height `lg:h-[calc(100vh-13rem)]` (≈line 487) for the smaller chrome (global `UHeader` + container padding + footer only). Measure actual chrome in-browser and set `calc()` so stage + filmstrip + command bar fit exactly. Check the `UFooter` (`app.vue`) doesn't reintroduce a scroll in editing view (condense/hide if needed).

#### Verification
- [x] Editing view: no page scroll at 1080p and ~800px-tall laptop heights. (Measured `scrollHeight - innerHeight = 0` at both 1920×1080 and 1440×800, running + done states.)
- [x] Undo / New image / mobile Steps still work, only in editing view. (Toolbar only renders when `view !== 'setup'`; mobile "Steps" opens the slideover; Undo correctly hidden when <2 applied steps via `canUndo`.)
- [x] Setup view still a clean hero; light + dark correct.
- [x] Screenshots captured (setup, editing, mobile) — in `verification/screenshots/sprint1_*.png`.

#### Outcome / Deviations
- **Removed the in-page `<h1>` + subtitle in editing view** and relocated the actions into a slim right-aligned toolbar row (`mb-3`, `shrink-0`) directly above the grid — as decided. Setup view keeps its title/subtitle, tightened to `UContainer py-6` + header `mb-6`.
- **The real scroll culprit was `UMain`, not the in-page header.** Nuxt UI's `UMain` carries `min-h-[calc(100vh-var(--ui-header-height))]`, which alone fills the viewport below the header and pushes the separator + footer *below the fold* (a guaranteed ~53px scroll) regardless of the page's own grid height. Fixed in `app.vue` by subtracting the footer chrome from `UMain`'s min-height (`min-h-[calc(100vh-var(--ui-header-height)-2.5rem)]`) **and** condensing the `UFooter` (`:ui="{ container: 'py-2 lg:py-2' }"` → ~36px tall, down from ~68px). The plan's "condense/hide the footer if needed" note covered this.
- **Editing-grid height: `lg:h-[calc(100vh-13rem)]` → `lg:h-[calc(100vh-13.5rem)]`.** Chosen from in-browser measurement: above-grid chrome = header 64 + container `py-6` top 24 + toolbar 40 = 128px; below-grid = container bottom 24 + separator 1 + condensed footer 36 ≈ 61px. 13.5rem (216px) reserves slightly more than the measured ~189px so the grid sits comfortably inside the reduced `UMain` with a small safety buffer — verified zero page scroll at 1920×1080 and 1440×800 in both running and done states. (The old 13rem was tuned for the larger pre-removal header.)

---

### Sprint 2: Crop tool + straightening grid
**Status:** Complete
**Goal:** The agent can crop for composition/aspect (native RT `[Crop]`), with a rule-of-thirds/crop grid overlay for the human and stronger straighten guidance for the agent.
**Estimated effort:** 4–5 hours

#### Tasks — crop (backend contract)
- 2.1 `types.ts`: add flat crop fields to `DevelopConfig` — `cropLeft, cropTop, cropWidth, cropHeight` (normalized 0..1 of the **post-straighten** frame; identity `0,0,1,1`). Optional flat string `cropAspect` enum (`'free'|'original'|'1:1'|'4:5'|'3:2'|'16:9'`, identity `'free'`) — a single string field is schema-safe (cf. `look`). Add to `DEFAULT_CONFIG`; add `'crop'` to `ToolName`.
- 2.2 `tools.ts`: add a `crop` registry entry (numeric params + optional aspect enum) with a tight LLM description ("Crop for composition: strengthen framing, remove dead space / edge distractions, or set an aspect ratio. Normalized 0..1, applied after straighten. Don't crop reflexively — only when it serves the intent."). `describeTools()` picks it up.
- 2.3 `agent.ts`: add the flat zod fields (ABSOLUTE) to `configSchema`; clamps in `clampConfig` (left/top 0..1, width/height min ~0.1..1, and `left+width<=1`, `top+height<=1`); lines in `configToText`; `diffConfig` emits a `crop` op on any crop change; `equalConfig` compares crop fields. Keep descriptions terse — the flat schema is already large.
- 2.4 **RT render (`pp3.ts`):** emit a `[Crop]` section (verified keys `Enabled=true, X, Y, W, H`) converting normalized → pixels via the original/post-rotation dimensions. **Note the straighten interaction:** RT auto-crops the rotation wedge; the crop is relative to the rotated frame, so compute against the rotated output dims, not raw original metadata (verify against a tilted sample). Skip when identity.
- 2.5 **Sharp parity (`executor.ts`):** add a `crop` case using `.extract({left,top,width,height})` (normalized→px via metadata; guard zero-size) and insert into `renderConfig` immediately after `straighten`. Skip when identity.
- 2.6 Docs: `editing-guide.ts` ORDER OF OPERATIONS prose (`straighten -> crop -> exposure -> …`) + a "when to crop" note; root `SKILL.md` toolset table + magnitudes; `src/README.md` Toolset table **and remove `crop` from the Deferred list** (lines ~101-106). Keep numbers in lockstep.

#### Tasks — grid overlay + straighten guidance
- 2.7 New `src/app/components/GridOverlay.vue`: absolutely-positioned SVG overlay — rule-of-thirds grid + optional crop rectangle from the active config. Toggleable, theme-aware (semi-transparent white/black). Props `show`, optional `crop`. Presentational only.
- 2.8 Wire `GridOverlay` into `EditorStage.vue` with a small grid-toggle button so the human can check level/composition. (Reused in the lightbox, Sprint 4.)
- 2.9 Straighten guidance (cheap, zero-token): strengthen the straighten section of `editing-guide.ts` (what to align to — true horizon, building verticals, door frames — and to prefer small angles). **Do NOT** composite a grid onto the agent's vision images (corrupts color/exposure reads). The grid-overlaid-reference-image experiment from the earlier draft is cut; revisit only if straightening is observably weak after this.

#### Verification
- [x] `typecheck` + `lint` clean. (typecheck clean; lint clean except the KNOWN pre-existing `ab-model-test.ts` max-statements-per-line error — untouched, no new errors introduced.)
- [x] Live run with a crop-inviting intent ("tighten the composition and make it square") → agent emitted `crop` (chip: `crop · left 0 · top +0.04 · width +1 · height +0.67 · aspect 1:1`), the rendered step is a visibly cropped 1:1 square, timeline chip shows it. (Live run was on the **Sharp** engine — the dev server's `.env` is `RT_EXECUTION=sharp` — which proved emission + Sharp parity; **RT correctness was proven separately** against the real `rawtherapee-cli` binary, below.)
- [x] **RT render correctness (authoritative):** rendered samples through the actual `rawtherapee-cli` 5.12 binary. Crop-only (`Enabled,X,Y,W,H`) 1600×1067 → exact 800×533 / 960×640; the `[Crop]` round-trips byte-exact in the expanded pp3 (X/Y/W/H preserved). Crop on a tilted/straightened image (`[Rotation] Degree=3` + crop) → exact 960×640, **no black wedge** — confirming the wedge interaction. Evidence: `verification/screenshots/sprint2_rt_crop_*.png`, `sprint2_tilted_crop.png`.
- [x] Crop on a tilted/straightened image lands correctly (wedge interaction handled); no zero/negative extract; clamps hold. (RT tilt+crop verified above; Sharp `.extract` guards zero/full-frame and recomputes pixels against the post-straighten metadata; `clampConfig` enforces left/top 0..0.9, width/height 0.1..(1-edge).)
- [x] Grid overlay toggles in the stage; lines visible both themes; crop rect matches applied crop. (Verified light + dark via Playwright — `sprint2_grid_overlay_light.png` / `_dark.png`; crop rectangle + dimmed margins match the applied 1:1 crop on the result frame.)
- [x] **Docs updated:** `SKILL.md` + `editing-guide.ts` ORDER OF OPERATIONS + `README.md` (crop removed from Deferred) all reflect crop.
- [x] Screenshots: crop before/after, grid overlay on. (All under `verification/screenshots/sprint2_*`.)

#### Outcome / Deviations
- **Files changed:** `shared/types.ts` (crop fields + `CropAspect` + `'crop'` ToolName + DEFAULT_CONFIG identity), `server/utils/tools.ts` (crop registry entry), `server/utils/agent.ts` (flat zod fields + clamp w/ in-bounds rect enforcement + configToText + diffConfig + equalConfig), `server/utils/pp3.ts` (`[Crop]` section + `dims` param), `server/utils/engines/rt-local.ts` + `rt-sandbox.ts` (read original dims via sharp when crop active, pass to `configToPp3`), `server/utils/executor.ts` (Sharp `crop` case + inserted after straighten in `renderConfig`), `server/utils/editing-guide.ts` (ORDER OF OPERATIONS + straighten guidance 2.9 + crop magnitudes/intent), `SKILL.md` + `src/README.md` (toolset/order/intent + removed crop from Deferred), new `app/components/GridOverlay.vue`, `app/components/EditorStage.vue` (grid toggle + overlay wiring + `crop` prop), `app/pages/index.vue` (`selectedConfig`/`selectedCrop` + pass to stage), `app/utils/stepFormat.ts` (crop params unsigned).
- **DEVIATION — `configToPp3` signature:** the plan implied computing crop against "rotated output dims." Verified against the 5.12 binary that **RT keeps the rotated output at the ORIGINAL dimensions** (it scales the rotated content to fit; no wedge in the output), and `[Crop] X/Y/W/H` are in that same original-dimension space even with `[Rotation]` active. So crop pixels are computed against the **original** metadata dims — simpler than the plan feared, and no separate rotated-dim math is needed. `configToPp3(config, dims?)` gained an optional `dims` param (the engines read original metadata via sharp only when crop is non-identity).
- **No flat-schema repetition-loop bug.** Adding 5 crop fields (4 numbers + 1 enum string `cropAspect`) to the flat schema parsed reliably across the live run — no `AI_JSONParseError` / `finishReason: length`. The enum string mirrors the existing schema-safe `look` pattern.
- **Note (not a bug):** the agent emitted the crop under `phase: straighten` (the geometry phase), so the step's phase badge reads "Straighten" while the op chip correctly reads `crop`. Correct behavior — crop is geometry.

---

### Sprint 3: One regional graduated filter — highest risk, do last
**Status:** Complete
**Goal:** The agent can apply a single **linear graduated (ND) filter** — the marquee "darken the bright sky / lift the foreground" local edit — layered over the corrected global base.
**Estimated effort:** 6–9 hours (includes an RT key-verification spike; budget for iteration)

> **Why scoped this tight.** Two constraints force it: (a) the flat-schema rule forbids a `masks[]` array (use fixed flat fields); (b) **RawTherapee's `[Graduated Filter]` keys are NOT in the verified reference doc**, and pp3 fails silently on wrong keys — so they must be verified against the binary before use, and RT's native graduated filter is an *exposure* gradient (no per-region color/contrast). Radial filters and per-region color need RT **Locallab** (complex, unverified) or a Sharp-only matte pipeline. Shipping **one linear exposure graduated filter** delivers the highest-value local edit with the least risk. Radial + per-region color are explicitly deferred.

#### Step 0 — RT key-verification spike (do FIRST; gates the rest)
- 3.0 Verify RawTherapee's graduated-filter pp3 keys against the local 5.12 binary: emit a candidate `[Graduated Filter]` section (likely `Enabled, Degree, Feather, Strength, Centerx, Centery` — but DO NOT trust this list blind), render a test image via `rawtherapee-cli`, confirm the output visibly changes in the expected direction and round-trips. Record the verified keys in `internal_docs/20260617_rawtherapee_sandbox_engine/rawtherapee_pp3_reference.md`. **If the keys can't be verified, fall back to a Sharp-only matte implementation and note that the filter no-ops on the RT engine until Locallab is researched** (then this becomes a smaller, Sharp-only sprint or a deferral decision for Kyle).

#### Design (flat fixed-slot — NO arrays; ONE slot for v1)
A single graduated-filter slot of flat fields (identity disables it):
- `gradEnabled` (0/1, identity 0) — or model it as `gradStrength` where 0 = off.
- Geometry (normalized): `gradAngle` (0..360, gradient direction), `gradPosition` (0..1, where the transition sits across the frame), `gradFeather` (0..100, transition softness).
- Effect: `gradExposure` (-3..3 EV, the ND strength; negative darkens the masked side). (v1 = exposure only, matching RT's native capability.)

~5 flat fields. (No second slot, no per-region color/contrast in v1.)

#### Tasks
- 3.1 `types.ts`: add the grad fields + identity defaults to `DevelopConfig`/`DEFAULT_CONFIG`; add `'gradFilter'` to `ToolName`.
- 3.2 `tools.ts`: registry entry describing the graduated filter (angle/position/feather/exposure) and that strength 0 = unused. Tight description.
- 3.3 `agent.ts`: add the flat fields to `configSchema`, `clampConfig`, `configToText`, `diffConfig` (emit a `gradFilter` op when active), `equalConfig`. Re-confirm the schema still parses reliably across several live runs after this addition (the flat-schema constraint is most likely to bite when the config grows). If repetition loops appear, trim fields. Check whether `maxOutputTokens: 2048` (`agent.ts:290`) still comfortably fits the restated config.
- 3.4 **RT render (`pp3.ts`):** emit the verified `[Graduated Filter]` section (from 3.0), mapping `gradExposure`→strength, `gradAngle`→degree, position/feather→their verified keys. Place after global tonal/color. Skip when off.
- 3.5 **Sharp parity (`pixels.ts` + `executor.ts`):** add `linearMask(w,h,angle,position,feather)` → grayscale matte; in `executor.ts` render the exposure adjustment on a full copy and alpha-blend over the base via the matte (`out = base*(1-a) + adj*a`), inserted after global ops, before sharpen. Skip when off.
- 3.6 Docs: add a "LOCAL / REGIONAL EDITS" section to `editing-guide.ts` + root `SKILL.md` (when to reach for a graduated filter — skies/horizons; "most edits need none; correct globally first"; magnitudes); add the graduated stage to the ORDER OF OPERATIONS prose; add to `README.md` Toolset table. Lockstep.
- 3.7 Smoke check: a bright-sky sample + intent "darken the sky / hold the foreground" → agent engages the graduated filter, the sky darkens and the foreground is untouched, on the **RT engine**.

#### Verification
- [x] 3.0 spike complete: verified `[Gradient]` keys (NOT `[Graduated Filter]`) recorded in the reference doc §9. Section name + `CenterX`/`CenterY` casing + sign all verified against the RT 5.12 binary.
- [x] `typecheck` + `lint` clean. (typecheck clean; lint clean except the KNOWN pre-existing `ab-model-test.ts` max-statements-per-line error — untouched, no new errors.)
- [x] **Schema parses reliably** across several live runs. 3 live agent runs on the bright-sky sample, all `POST /api/edit` → 200, 0 console errors, no `AI_JSONParseError` / `finishReason: length` / repetition loop. The full ~32-field flat config (5 grad fields added) fits `maxOutputTokens: 2048` comfortably — no fields trimmed; the full set shipped.
- [x] "Darken the sky" → top-of-frame graduated darkening, foreground held; off = no-op. **Confirmed on the RT engine (authoritative):** rendered `granite-dome-vista.jpg` through the de-sandboxed `rawtherapee-cli` 5.12. Baseline top(sky) 192.2 / bot(land) 107.2 → darken (`gradExposure -2` → `Strength +2`, `Degree 0`, `Feather 50`) top **192.2→106.0** (sky darkened ~86 levels) / bot 107.2→100.6 (foreground held). `Enabled=false` render was **byte-identical** to baseline (md5 match) = no-op confirmed. Geometry/sign verified in the §9 spike (degree 0=top, 180=bottom, 90=left; feather 0=hard, 100=soft).
- [x] Sharp fallback produces the equivalent matte result. The live app runs `RT_EXECUTION=sharp`, so the 3 live runs exercised the Sharp matte path (smooth feather, no banding); a direct Sharp `linearMask`+`blendWithMask` darken-sky reproduction took top(sky) 192→58 / bottom held — same direction, slightly more aggressive at the top edge than RT's gentler Strength falloff (acceptable; both darken the sky and hold the foreground).
- [x] **Docs updated** — `editing-guide.ts` (new "LOCAL / REGIONAL EDITS" section + ORDER OF OPERATIONS includes `gradFilter` + intent-routing line), `SKILL.md` (toolset row + order + corrected the stale "no local masking" line to name the gradFilter as the one local tool), `README.md` (graduated filter listed; radial/per-region deferred).
- [x] Screenshots: `sprint3_rt_darken_sky_before.png` / `sprint3_rt_darken_sky_after.png` (RT authoritative), `sprint3_grad_result.png` (live Sharp darken-sky result), `sprint3_agent_grad_chip.png` (timeline gradFilter chip), plus the `sprint3_spike_grad_*.jpg` evidence kept.

#### Outcome / Deviations
- **Backend was already fully implemented across all 7 tasks before this verification pass** (`types.ts` grad fields + DEFAULT_CONFIG + `'gradFilter'` ToolName; `tools.ts` registry entry; `agent.ts` flat zod fields + `clampConfig` + `configToText` + `diffConfig` + `equalConfig`; `pp3.ts` `[Gradient]` section; `pixels.ts` `linearMask`/`blendWithMask`; `executor.ts` `gradFilter` case inserted after look/before sharpen; docs). This pass verified correctness end-to-end and corrected one stale doc line.
- **Final field set (5 flat, no arrays):** `gradEnabled` (0/1, identity 0), `gradAngle` (0..360, identity 0 = darken top/sky), `gradPosition` (0..1, identity 0.5), `gradFeather` (0..100, identity 50), `gradExposure` (-3..3 EV, identity 0, NEGATIVE darkens). No fields trimmed.
- **RT mapping used (`pp3.ts`):** `Degree = ((gradAngle+180)%360)-180`; `Strength = -gradExposure` (RT positive darkens, our gradExposure negative darkens — **sign flip verified empirically**); `Feather = gradFeather`; center offset `offsetMag = (0.5-gradPosition)*200`, `CenterX = offsetMag*sin(angle)`, `CenterY = offsetMag*cos(angle)`, clamped ±100; always `Enabled=true`, section skipped when `gradEnabled≠1` or `gradExposure==0`. Placed AFTER global tonal/color/creative sections.
- **DEVIATION — section name + casing (already captured by the 3.0 spike):** the plan guessed `[Graduated Filter]`; the verified RT section is **`[Gradient]`** with keys `CenterX`/`CenterY` (capital X/Y). The plan's `Centerx`/`Centery` and `[Graduated Filter]` guesses were wrong and would have silently no-op'd.
- **DEVIATION — gradExposure→Strength sign:** confirmed RT `Strength` is POSITIVE-darkens, so `Strength = -gradExposure`. "Darken sky" = `gradAngle 0` + `gradExposure -2` → `Degree 0` + `Strength +2` → sky darkens (192→106). Verified, not assumed.
- **Sandbox parity (deferred line update):** `rt-sandbox.ts` reuses the same `configToPp3()` as `rt-local.ts`, so it inherits the `[Gradient]` section automatically — **no sandbox change needed for grad.** CenterX/Y are percentages (no pixel dims required), unlike crop which needed `dims`. The prod RT path will render the graduated filter identically once `RT_EXECUTION` points at the sandbox.

---

### Sprint 4: Lightbox as a real inspection surface
**Status:** Complete
**Goal:** Zoom/pan + fit/100%, an easy before/after comparison with the original, and keyboard-driven inspection.
**Estimated effort:** 4–6 hours

#### Tasks
- 4.1 New `src/app/composables/useZoomPan.ts`: scale + translate with wheel-zoom-to-cursor, drag pan, pinch (touch), double-click toggles fit ↔ 100%, clamped scale (~0.5×–8×), `reset()`. Frame-agnostic.
- 4.2 `ImageLightbox.vue`: integrate `useZoomPan` on the main image; add controls — zoom out / zoom % / zoom in / fit / 100%; reset zoom on frame nav. Keep prev/next + arrow keys.
- 4.3 Before/after compare: reveal the original under a draggable vertical divider over the current frame. The original URL is already available (`/api/image/<id>/original` or `previewUrl`) — extend `useLightbox.ts`/`LightboxFrame` so each frame carries its compare-against-original source. Hide the slider when the current frame IS the original.
- 4.4 Grid overlay in the lightbox: reuse `GridOverlay.vue` (Sprint 2) with a toggle.
- 4.5 Keyboard map: arrows = prev/next (existing), `+`/`-`/`0` = zoom in/out/reset, `c` = toggle compare, `g` = toggle grid, `Esc` closes (existing). Surface zoom % + active mode in the footer; small legend/tooltips.
- 4.6 Keep `EditorStage.vue` click-to-open landing on the right frame, opening at fit zoom.

> **Cut from v1:** side-by-side split compare — the before/after slider covers the need; revisit if Kyle wants it.

#### Verification
- [x] Wheel/pinch zoom centers on cursor; drag pans; double-click toggles 100%/fit; `0` resets; clamp holds. (Wheel toward the top-left quadrant produced the correct compensating translate, anchor stays put; drag pan tracked the pointer delta; double-click toggled fit↔1:1 and back; `0`/Reset returned to fit; clamp held exactly at MIN 0.5× and MAX 8×. All via Playwright synthetic wheel/pointer/dblclick events.)
- [x] Before/after slider reveals the original and tracks drag; hidden on the original frame. (Compare clips the edited frame to the right of the divider and the original to the left; dragging the handle to 28% updated both clip-paths + divider `left` in lockstep. On the Original frame the compare button is `disabled` and the slider/labels don't render.)
- [x] Grid overlay toggles; keyboard shortcuts fire; nav resets zoom. (`g` toggled the reused `GridOverlay` rule-of-thirds SVG; `+`/`-`/`0`/`c`/`g`/arrows/`Esc` all fired; ArrowLeft/Right paged frames AND reset zoom to fit each time.)
- [x] Light + dark; mobile touch pan/pinch sane. (Both themes render correctly. At 390×844, two-finger pinch from 40→200px spread zoomed to scale 5 centered on the pinch midpoint; one-finger drag panned at the zoomed scale.)
- [x] Screenshots: zoomed 100%, before/after mid-drag, grid on. (Plus light + dark + mobile, under `verification/screenshots/sprint4_*`.)

#### Outcome / Deviations
- **Files changed:** new `app/composables/useZoomPan.ts` (frame-agnostic scale+translate; wheel-zoom-to-cursor, drag pan, two-finger pinch, double-click fit↔1:1, clamped 0.5×–8×, `reset()` — ~190 lines, no npm dep); `app/composables/useLightbox.ts` (each non-original `LightboxFrame` now carries `originalUrl`; the Original frame gets `isOriginal: true` and no `originalUrl`); `app/components/ImageLightbox.vue` (integrated zoom/pan, zoom controls, before/after slider, grid toggle reusing `GridOverlay`, keyboard map, footer mode+zoom readout). `EditorStage.vue`/`index.vue` needed **no change** — the existing `openStage` already lands on the right frame and the new `watch(open)` opens at fit (4.6 satisfied as-is).
- **DEVIATION — "100%" is true 1:1, not a fixed multiple.** The plan's double-click "fit↔100%" was implemented honestly: the 1:1 scale is derived per-image from `naturalWidth / clientWidth` (via an `imageEl` ref), so the "100%" button and the footer percent readout report *actual pixels* (e.g. a fit-rendered frame reads ~34%, double-click jumps to a real 100%). A fixed heuristic multiple was rejected as it would have mislabeled the readout. `scale` internally stays relative to fit (1 = fit); `percent = scale / hundredScale * 100`.
- **DEVIATION (robustness) — guarded pointer capture.** `setPointerCapture`/`releasePointerCapture` throw if the pointer id isn't active (surfaced by Playwright's synthetic events). Wrapped all four call sites (zoom-pan + divider) in try/catch so a stray/ended pointer can't break dragging. No behavior change for real input.
- **Compare alignment:** the original and edited images share the same zoom/pan `transform`, so before/after stays pixel-aligned while zoomed; each is clipped by a `clip-path: inset(...)` driven by the divider position (0..1). Slider hidden + compare button disabled whenever the current frame `isOriginal` or lacks `originalUrl`.
- **Note:** the live verification run used `RT_EXECUTION=sharp` (dev `.env`) and the AI gateway key was present — the agent produced a real 2-step edit (whiteBalance + splitTone) on the Granite-dome sample, giving an original + two frames to inspect/compare. Console errors observed during testing were all from synthetic-pointer dispatch and are now guarded; no real-input errors.

---

## Reference Docs
- `internal_docs/20260617_rawtherapee_sandbox_engine/rawtherapee_pp3_reference.md` — **authoritative** verified pp3 keys (round-tripped vs RT 5.12). `[Crop]` is verified; `[Graduated Filter]` is NOT (Sprint 3.0 must add it). Only emit verified keys — pp3 fails silently.
- `src/server/utils/engines/` + `src/server/utils/pp3.ts` — the live RawTherapee render path. `src/server/utils/executor.ts` — Sharp fallback.
- Root `SKILL.md` + `src/server/utils/editing-guide.ts` — human + model tool references; update in lockstep with every new tool. `src/README.md` — Toolset + Deferred + env tables; also update.

## Environment / Config Changes
No new required env. (The earlier draft's `AGENT_GEOMETRY_GRID` experiment is cut — Sprint 2.9 strengthens guidance text instead.) `AI_GATEWAY_API_KEY` / `AGENT_MODEL` / `RT_EXECUTION` / `RT_BIN` already documented in `src/.env.example`.

## What's Deferred / Out of Scope
- **Radial masks & per-region color/contrast** — need RT Locallab (complex/unverified) or a richer Sharp-only pipeline; v1 ships the native linear exposure graduated filter only.
- More than one mask slot; brush/AI-subject/sky auto-detection; healing/clone; generative fill.
- Side-by-side split compare (before/after slider covers v1).
- RawTherapee `rt-sandbox` (prod) parity is automatic IF the new pp3 sections render in `rt-local` (same `configToPp3`); confirm in Sprint 3 that the sandbox path inherits the new sections. **CONFIRMED (Sprint 3):** `rt-sandbox.ts` calls the same `configToPp3()`, so it inherits the `[Gradient]` section with no change. CenterX/Y are percentages (no dims needed), so grad needs none of the dims plumbing crop required.
- DB persistence / multi-image batch.

## Considered and Rejected
- **Targeting the Sharp `EditExecutor` as the primary backend** — rejected: RawTherapee is the live engine here and in prod; Sharp-only work would no-op in the running app. pp3.ts is primary, Sharp is parity.
- **`masks: LocalMask[]` nested array** — rejected: violates the flat-schema rule (`agent.ts:8-21`); risks the JSON repetition-loop bug. Fixed flat slot instead.
- **Radial filter + per-region color in v1** — rejected: not natively/verifiably supported in RT pp3; would balloon scope and the schema. Deferred.
- **Baking a grid onto the agent's vision images** — originally rejected (corrupts color/exposure reads). **REVISITED per Kyle's request and IMPLEMENTED** as a SEPARATE additive grid-reference image gated to geometry-active iterations — the original color-read concern is avoided because the clean current+original images stay untouched (the grid only ever lands on a third image). See "Post-plan enhancement" below.
- **A zoom/pan npm dependency** — rejected: a ~100-line `useZoomPan` composable covers wheel/drag/pinch; the project keeps deps minimal.
- **Keeping but shrinking the in-page header** — rejected: it duplicates the global `UHeader`; removing it in editing view reclaims the most space.

## Post-plan enhancement — agent alignment grid (June 20, 2026)

Kyle asked to revisit the cut "grid baked into vision" idea in a way that avoids the
color-read problem. Shipped:
- **`gridReference(buf)` in `src/server/utils/pixels.ts`** — composites a rule-of-thirds
  SVG (2 vertical lines at w/3 & 2w/3, 2 horizontal at h/3 & 2h/3; scaled white stroke on a
  darker halo, mirroring `GridOverlay.vue`) onto a copy of the image via `sharp().composite()`
  and returns a gridded JPEG. SVG-composite path confirmed rendering crisply
  (`verification/screenshots/followup_grid_reference.jpg`).
- **`agent.ts` `decideConfig`** — computes `geometryActive` from `args.currentConfig`
  (straighten≠0 OR any crop field non-identity). When active, it generates the grid and pushes
  it as a THIRD image after the clean current+original (try/catch → graceful 2-image fallback
  with a warning log, never breaks the loop). The grid sentence is appended to the prompt ONLY
  when the grid is attached, and explicitly tells the model to read color/exposure from the
  clean images, never the gridded one.
- **Docs** — `editing-guide.ts` straighten section, root `SKILL.md`, and `src/README.md` all
  note the geometry-gated alignment-grid reference.
- **Why it's safe now:** the clean current+original images are never touched, so color/exposure
  reads stay honest — the original deferral concern only applied to gridding the primary images.
- **Live proof:** train-station sample + "straighten this and level the horizon" → agent
  applied `straighten +0.6` on iter 1 (no grid), then on iter 2 (geometry active) a temporary
  `[grid-ref]` log confirmed the grid image was attached, and the agent assessed the frame as
  square and converged (temp log removed after; the try/catch warn log kept). Result:
  `verification/screenshots/followup_straighten_result.png`.

## Decisions (resolved with Kyle — execute as written)
1. **Regional masks scope — DECIDED:** ship **one linear graduated (exposure) filter** in v1; defer radial + per-region color. (Sprint 3 is already scoped to this.)
2. **Header actions placement — DECIDED:** slim in-page toolbar above the grid (Sprint 1.2), not the global `UHeader` slot.
3. **If the Sprint 3.0 spike fails** to verify `[Graduated Filter]` keys against the RT 5.12 binary — **DEFAULT: defer the whole graduated-filter sprint** (ship Sprints 1, 2, 4) and flag to Kyle, rather than shipping a Sharp-only filter that silently no-ops on the live RT engine. Do not ship a regional tool that doesn't work in the running app. (The executing agent should surface the spike result before proceeding with Sprint 3.)
