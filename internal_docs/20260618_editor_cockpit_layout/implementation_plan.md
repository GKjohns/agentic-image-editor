# Editor Cockpit Layout — Implementation Plan

**Created:** June 18, 2026
**Status:** Complete
**Context:** The editing-in-progress experience treats an agentic photo edit like a chat transcript. While the agent runs, the only progress signal is a single spinning "Editing…" badge (`index.vue:428`); steps stream into a vertical card list *below* the preview, so comparing frames means scrolling up and down; and the intervention controls (Stop, "Continue from here", "Use as result") are buried in a collapsed panel or hidden behind hover (`TimelineStep.vue:198`). Kyle asked to redesign this into a "Lightroom Cockpit."

**Goal:** Replace the stacked preview-over-timeline layout with a fixed cockpit — a big sticky live **stage**, a horizontal **filmstrip** of every frame, a compact agent/history **rail** with the active step pinned and reasoning on demand, and a persistent **command bar** for steering + an always-visible Stop — so the user always sees the picture, always knows the agent is working, and can branch/stop/steer without scrolling or hunting.

**Scope:** Frontend only (`src/app/`). No changes to the agent loop, the `/api/edit` stream, the `StepEvent` contract, or storage. The stream already emits everything the new UI needs (`goal`, `operations`, `assessment`, `reason`, `imageUrl`, `status` per step). This is a layout + interaction redesign, not a capability change.

---

## Handoff / Execution Notes (read first — this plan is self-contained)

**This plan is written to be executed by a fresh agent with no prior conversation context.** Everything you need is below; you should not need to ask the requester questions to start.

**Repo & runtime**
- App root is **`src/`** (Nuxt 4 app — `package.json`, `nuxt.config.ts`, `app/`, `server/`, `shared/` all live under `src/`). Run all `npm` commands from `src/`.
- Scripts: `npm run dev` (starts dev server — note it sets `TMPDIR=/tmp`), `npm run typecheck` (`nuxt typecheck`), `npm run lint` (`eslint .`). **There is no unit-test suite** — verification is typecheck + lint + Playwright (MCP `mcp__playwright__browser_*`) against the running dev server.
- A session is created by uploading an image to `/api/session`; frames are served from `/api/image/{sessionId}/{step|original}`. Sample images exist under `src/public/samples/` (used by the setup screen) — use one of those to drive a run during verification rather than needing a real upload.

**Conventions (match the existing code)**
- UI is **Nuxt UI** (`UCard`, `UButton`, `UBadge`, `UTextarea`, `UAlert`, `UIcon`, `UModal`, `USeparator`, `USlideover`/`UDrawer` for the mobile rail). Icons are `i-lucide-*`. Colors/tokens: `text-muted`, `text-highlighted`, `text-dimmed`, `bg-elevated`, `ring-default`, `color="primary|neutral|error|success|…"`. Match the tokens already used in `index.vue`/`TimelineStep.vue` — do not introduce raw hex.
- State is **plain `ref`/`computed` in `index.vue`** — no Pinia, no new store. Child components take props down and emit events up; two-way values use `defineModel` (see `InputPanel.vue`).
- TypeScript throughout; import shared wire types from `#shared/types` (e.g. `StepEvent`, `Operation`, `Phase`, `ToolName`, `DevelopConfig`).
- Keep comments at the density of the surrounding files (the existing files are heavily commented explaining *why* — preserve that style for the non-obvious bits like the pin rule and interrupt-and-steer settle logic).

**The wire contract (do not change it — just consume it)** — `StepEvent` from `#shared/types`:
`{ step: number; status: 'deciding'|'applied'|'done'|'error'; goal?: string; phase?: Phase; operations?: Operation[]; assessment?: string; reason?: string; config?: DevelopConfig; imageUrl?: string; error?: string }`. The server emits a `deciding` event when the model commits to a step, then `applied` once pixels are written (same `step` id, merged client-side). `done` is terminal. The current de-dupe/merge logic lives in the `steps` computed (`index.vue:96–107`) — preserve it.

**Execution order & rules**
- Sprint 1 is foundational (the shell + state + stage) — **it must land before 2, 3, 4**, which all mount into the shell. Sprints 2 and 3 are independent of each other; Sprint 4 assumes 1–3 exist.
- All sprints edit the same `index.vue`, so **run them sequentially, not in parallel**, to avoid clobbering.
- After each sprint: run `npm run typecheck` + `npm run lint`, do the sprint's Playwright check, then update this file (sprint **Status** badge + check the verification boxes + note any deviation inline). Do not silently diverge — the plan is the record.
- After the final sprint, build the **verification artifact** at `internal_docs/20260618_editor_cockpit_layout/verification/index.html` (screenshots in `verification/screenshots/`, already created) per the implementation-plan skill's Phase 5 — embed inline `<img>` proof for each sprint and an end-to-end golden-path run. Do not report "done" without it.
- Do not commit/push unless the requester asks.

---

## Current State

### What Exists
- **`src/app/pages/index.vue`** (517 lines) — owns all state (plain refs/computed, no Pinia) and the whole layout. Three views via the `view` computed (`:135`): `setup` (centered InputPanel hero), `running`/`done` (a `lg:grid-cols-5` grid: collapsible InputPanel left, big preview + vertical timeline right, `:391–507`).
- **`src/app/components/InputPanel.vue`** — image dropzone + sample picker + intent textarea + Run/Stop buttons. Rendered twice (setup hero and the collapsible running column).
- **`src/app/components/TimelineStep.vue`** — a full-width `UCard` per step: number rail, phase badge, goal, op chips, assessment, reason, 80–96px thumbnail, hover-revealed branch/result actions.
- **`src/app/components/ImageLightbox.vue`** — full-screen frame viewer with prev/next + download. Reused as-is.
- **State already in `index.vue` we build on:** `steps` (`:96`), `appliedSteps` (`:110`), `lastAppliedStep` (`:113`), `resultStep` override (`:88`) + `effectiveResultStep` (`:120`), `fromStep` branch point (`:85`), `previewImageUrl` (`:156`), `lightboxFrames` (`:178`), and the actions `continueFrom`/`useAsResult`/`undoLastStep`/`run`/`stop`/`newImage`.
- **The stream contract** (`#shared/types` `StepEvent`): `step`, `status` (`deciding|applied|done|error`), `goal`, `phase`, `operations`, `assessment`, `reason`, `config`, `imageUrl`, `error`. No backend change needed.

### What Changes
- `index.vue` template is restructured from the stacked grid into the cockpit shell (stage + rail + filmstrip + command bar) with a fixed-height, internally-scrolling layout instead of one long page scroll.
- A new **`selectedStep`** state (which frame the stage/rail/filmstrip are focused on) is introduced, distinct from `resultStep` (the download target). Auto-follows the latest frame while running; pins when the user clicks a frame.
- New components: `EditorStage.vue`, `Filmstrip.vue`, `AgentRail.vue` (with `AgentStepRow.vue`), `CommandBar.vue` — plus a plain `src/app/utils/stepFormat.ts` for the shared label helpers. The rail row **expands inline** to show the selected step's reasoning (no separate detail component).
- `TimelineStep.vue` is retired (its rendering logic — phase colors, `opLabel`, signed/unsigned params — moves into `utils/stepFormat.ts`, consumed by `AgentStepRow`).
- `InputPanel.vue` is used **only** for the setup view; its Run/Stop role in running/done is taken over by `CommandBar`.

### What Stays
- The agent loop, `/api/edit`, `/api/image/...`, `/api/session`, `engine`, and all server code — **untouched**.
- The `StepEvent` / `DevelopConfig` contract — **untouched**.
- `ImageLightbox.vue` — reused unchanged (the stage and filmstrip open it).
- Branch/result/undo semantics — same `fromStep`/`resultStep` model, just surfaced in better places.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│ HEADER   title · status pill · Undo · New image                │   index.vue
├──────────────────────────────────────────┬────────────────────┤
│                                           │  AgentRail.vue      │
│  EditorStage.vue                          │  ┌──────────────┐   │
│   ┌─────────────────────────────────────┐ │  │AgentStepRow ◉│   │ ← active pinned
│   │  selected frame (sticky, object-    │ │  │AgentStepRow ▼│   │ ← selected row
│   │  contain, click → ImageLightbox)    │ │  │  goal/chips/ │   │   expands inline:
│   │                                     │ │  │  assessment/ │   │   reasoning +
│   │  ┌ working caption (running only) ┐ │ │  │  reason      │   │   branch/result
│   │  │ Step 4 · raising contrast  ▁▃▅▇│ │ │  │AgentStepRow ✓│   │
│   │  └────────────────────────────────┘ │ │  └──────────────┘   │
│   └─────────────────────────────────────┘ │                     │
├──────────────────────────────────────────┤                     │
│  Filmstrip.vue                            │                     │
│   [○ orig][1][2][3][▶4]…  click=scrub     │                     │
│   ⌥click / visible btn = branch           │                     │
├──────────────────────────────────────────┴────────────────────┤
│  CommandBar.vue   [ steer the edit… ____________ ][Send][■ Stop]│
└───────────────────────────────────────────────────────────────┘

State flow (all in index.vue, props down / events up):
  steps ──┬─> AgentRail (list + active emphasis)
          ├─> Filmstrip (frames + active marker)
          └─> EditorStage (selected frame + working caption)
  selectedStep (new) <── click from Rail / Filmstrip ; auto-follows latest while running
  resultStep (existing) <── "use as result" from Rail / Filmstrip
  fromStep (existing) <── "continue from here" → CommandBar steer → run()
  CommandBar Send ── running? stop()+branch-run : run()
```

**Key state addition — `selectedStep` (one pin rule, stated once):**
- `selectedStep: Ref<number | 'original' | null>` — the frame the cockpit is focused on.
- A single `userPinned` flag governs auto-follow. **Auto-follow is on whenever `userPinned` is false.** When on: while `running`, `selectedStep` tracks `lastAppliedStep`; on the `running→done` transition, `selectedStep` is set to `effectiveResultStep`.
- `userPinned` is set `true` by clicking a filmstrip thumb or rail row. It is cleared (`false`) by exactly two actions: starting a new `run()`, and "Jump to latest." **Nothing else touches it** — so a pin set mid-run survives the `done` transition (the done-default only applies when not pinned). This resolves the pin-vs-done conflict: a pin always wins until the user explicitly unpins or starts a new run.
- The stage shows `selectedStep`'s image; the caption/working state always reflects the *active* (latest streaming) step regardless of selection, so scrubbing back never hides "it's still working."
- **Before the first applied frame exists** (`lastAppliedStep === null`), `selectedImageUrl` falls back to the local `previewUrl` / original (preserving today's `previewImageUrl` behavior at `index.vue:156-159`), so the stage is never blank during the first "deciding" beat.

---

## Sprint Breakdown

### Sprint 1: Cockpit shell + EditorStage — Foundational
**Status:** Complete
**Goal:** Stand up the fixed cockpit layout and a prominent live stage that replaces the tiny "Editing…" badge with a captioned, animated working state.
**Estimated effort:** 3–4 hours

#### Tasks
- 1.1 **Restructure `index.vue` layout shell.**
  - File: `src/app/pages/index.vue`
  - Keep the `setup` view as-is (InputPanel hero). For `running`/`done`, replace the `lg:grid-cols-5` block (`:391–507`) with the cockpit grid: a main column (stage on top, filmstrip beneath) and a right rail column, with a command bar pinned below. Use a viewport-bounded height (e.g. `lg:h-[calc(100vh-…)]`) so the stage stays put and the rail/filmstrip scroll *internally* instead of the whole page scrolling. Filmstrip and rail can be simple placeholders this sprint.
  - Remove the "Edit setup" toggle button (`:349–357`) and the collapsible InputPanel column (`:396–416`); `setupOpen` state is no longer needed for running/done (setup is reached via "New image").
- 1.2 **Rewire the `setupOpen` dependents (explicit — not just template deletion).**
  - File: `src/app/pages/index.vue`
  - `setupOpen` is referenced by the `watch(view…)` (`:144–146`) and by `continueFrom` (`:236`, sets `setupOpen = true`). Removing the ref leaves both dangling. Delete the `watch`, and rewrite `continueFrom` to set `fromStep` + clear the result override + focus the command bar's intent input (Sprint 4) instead of opening a panel. Until Sprint 4 lands, `continueFrom` just sets `fromStep`/`resultStep` and leaves intent empty — verify no remaining reference to `setupOpen` compiles away.
- 1.3 **Add `selectedStep` state + auto-follow.**
  - File: `src/app/pages/index.vue`
  - Add `selectedStep` + `userPinned` refs and a `selectedImageUrl` computed (resolves `'original'`/`null`-before-first-frame → `/api/image/{id}/original` or local `previewUrl`; a step number → that applied frame's `imageUrl`). Implement the single pin rule from Architecture: a `watch` follows `lastAppliedStep` while `running && !userPinned`, and sets `effectiveResultStep` on `running→done` when `!userPinned`.
  - Add an `activeStep` computed = the latest step in `steps` (the one currently `deciding`/just `applied`) — drives the stage caption independently of `selectedStep`.
- 1.4 **Build `EditorStage.vue`.**
  - File: `src/app/components/EditorStage.vue` (new)
  - Props: `imageUrl`, `running`, `view`, `activeStep: StepEvent | null`, `isResult`. Emits: `open` (carries the currently-shown `imageUrl` so the lightbox opens the *selected* frame, not the result — `openLightbox` already resolves by image path, `index.vue:209–222`).
  - Big `object-contain` image in a framed container (reuse the styling from `index.vue:450–474`). Click → emit `open`.
  - **Working state (the headline fix):** when `running`, overlay a caption bar — `Step {activeStep.step} · {activeStep.goal}` (or "Deciding the next move…" when `activeStep.status === 'deciding'`) plus an indeterminate progress treatment (animated bar / shimmer along the image edge). When not running, show a subtle "Result" / "Original" tag. Honest: no fake "N of M" since the agent stops early — indeterminate is correct.
  - Download button stays accessible here on `done` (move from `index.vue:438`).
- 1.5 **Wire stage into `index.vue`** using `selectedImageUrl` + `activeStep`; confirm `ImageLightbox` opens the selected frame.

#### Verification
- [x] `npm run typecheck` and `npm run lint` pass; grep confirms no remaining `setupOpen` reference. (Lint: only the pre-existing `src/scripts/ab-model-test.ts:116` `max-statements-per-line` baseline error remains; no new errors. `grep -rn setupOpen src/app` → no matches.)
- [x] Playwright: loaded a sample, ran an edit. The stage stays fixed while frames stream; the working caption shows the current step's goal (`Step N · {goal}`) with an indeterminate animated progress bar (not a static badge); the stage shows the original during the first "deciding" beat — never blank. (See `verification/screenshots/sprint1_stage_running.png` — original frame + "Deciding the next move…" + animated bar.)
- [x] On done, the stage shows the result frame with a Download button and a "Result" tag; clicking the stage opens the lightbox on the correct frame (Step 6, 7/7, matching the Download URL). (See `verification/screenshots/sprint1_stage_done.png`.)

**Deviations / notes:**
- `finalImageUrl`/`showFinal`/`latestImageUrl`/`previewImageUrl` computeds in `index.vue` were removed (their only consumers were the deleted stacked-preview template); the stage now derives its image from `selectedImageUrl` and its Download from the shown frame. `openPreviewLightbox()` was replaced by `openStageLightbox(imageUrl)` driven by the stage's `open` emit.
- `continueFrom`/`useAsResult` have no template consumer yet (their filmstrip/rail callers land in Sprint 2/3). To satisfy `no-unused-vars` without weakening the rule, they're kept live via a `defineExpose({ continueFrom, useAsResult })` with an explanatory comment — remove the expose when Sprints 2/3 wire real consumers.
- The right rail placeholder is `hidden lg:flex` (desktop-only) this sprint; the responsive mobile rail (slideover/drawer) is Sprint 4 scope.
- Verification ran against a dev server that was already running on :3000 (started before this task); the task's own `npm run dev` no-op'd on the lock. That pre-existing server was left running (not started by this sprint).

---

### Sprint 2: Filmstrip
**Status:** Complete
**Goal:** A horizontal strip of every frame so the user navigates the edit history with one glance + one click instead of scrolling — and can branch from any frame.
**Estimated effort:** 3 hours

#### Tasks
- 2.1 **Build `Filmstrip.vue`.**
  - File: `src/app/components/Filmstrip.vue` (new)
  - Props: `frames` (reuse/derive from `lightboxFrames`: original + each applied step, each with `step`, `imageUrl`, `label`), `selectedStep`, `resultStep`, `running`. Emits: `select(step)`, `branch(step)`, `useAsResult(step)`.
  - Horizontal scroll row of fixed-size thumbnails (~`size-16`), original first. Each thumb: active ring when `selectedStep` matches, a small "result" flag when `resultStep` matches, step number label. A trailing "deciding…" shimmer tile while `running` and the latest step has no image yet.
  - **Auto-scroll to the newest thumb while running** (scroll the container to the end on new applied frame), unless the user has scrolled/pinned.
  - Branch affordance that is **not** hover-only on touch: a small always-visible "⑂" button on each thumb (plus modifier-click on desktop as a shortcut) → emit `branch(step)`. A right-click/long-press context isn't needed; keep it a visible button.
- 2.2 **Wire filmstrip into `index.vue`.**
  - `select(step)` → set `selectedStep` + `userPinned = true`. `branch(step)` → call existing `continueFrom(step)` (sets `fromStep`, opens the command bar focus). `useAsResult(step)` → existing `useAsResult`.
  - Add a "Jump to latest" control (button or clicking the last thumb) that clears the pin so auto-follow resumes.

#### Verification
- [x] Typecheck + lint pass. (Typecheck clean; lint clean except the pre-existing `src/scripts/ab-model-test.ts:116` baseline error — no new errors.)
- [x] Playwright: during a run, thumbnails appear left→right (Original → Step 1 → trailing "…" shimmer tile) and the strip auto-follows the newest; the stage caption shows `Step N · {goal}` while frames stream (see `verification/screenshots/sprint2_filmstrip_running.png`). Clicking an earlier thumb (Step 1) pins the stage to that frame and surfaces a "Jump to latest" button; the active ring follows the selection (see `sprint2_pinned_step1.png`). "Jump to latest" clears the pin and snaps back to the latest/result frame.
- [x] Branch button ("⑂" / `i-lucide-git-branch`, always-visible per-thumb, plus ⌥-click) on an earlier frame sets the branch point (`continueFrom` → `fromStep`); "use as result" moves the result flag from Step 2 to Step 1 (see `sprint2_result_moved.png`).

**Deviations / notes:**
- **`useAsResult` affordance added to the filmstrip.** Task 2.1 declares a `useAsResult(step)` emit and 2.2 says wire it, and the verification calls for "use as result moves the result flag" — but the Architecture wireframe only sketched select + branch on the strip. To honor the emit/verification within Sprint 2 (the rail isn't built yet), each non-result applied thumb gets a small always-visible flag button (`i-lucide-flag`, bottom-right) that emits `useAsResult`; the current result thumb hides it (it already shows the solid result flag). The rail (Sprint 3) will be the richer surface, but the flag now moves from the filmstrip too.
- **`resultStep` prop is fed `effectiveResultStep`, not the raw `resultStep` ref.** The strip's result flag should mark the *actual* download target, which defaults to the last applied frame when no manual override is set (`resultStep` ref is null until "use as result" is clicked). Passing `effectiveResultStep` keeps the flag consistent with the stage's "Result" tag (which already uses it). The prop is still named `resultStep` per the plan.
- **Mid-run pin caught structurally, not in a live screenshot.** Sample runs completed in 1–2 applied steps in well under a second, so "click an earlier thumb *mid-run* while the caption still shows the agent working" wasn't catchable as a single live frame. The behavior is correct by construction: the stage caption binds to `activeStep` (the latest streaming step), fully independent of `selectedStep`/the pin, per the Sprint 1 stage contract — selecting a frame never touches the caption.
- **Filmstrip auto-scroll uses a local `userScrolled` flag, not `index.vue`'s `userPinned`.** `userPinned` governs the *stage* (which frame is shown). The strip's auto-scroll is purely scroll position: it follows the newest thumb while running unless the user has scrolled the strip away from the end (re-engaging once they scroll back near the end). This keeps "I clicked an earlier thumb to inspect it" from also freezing the strip's scroll while new frames stream in.
- **`defineExpose({ continueFrom, useAsResult })` removed from `index.vue`.** Per the Sprint 1 note, the expose was a placeholder to keep those actions live with no consumer; the filmstrip now wires `@branch="continueFrom"` and `@use-as-result="useAsResult"`, so the real consumers exist and the expose is gone.
- **Single-file ESLint override for `Filmstrip.vue`.** The plan mandates the filename `Filmstrip.vue`, but `vue/multi-word-component-names` flags a one-word component name. Added a scoped override in `src/eslint.config.mjs` turning that rule off for just `app/components/Filmstrip.vue` (the filmstrip is a single named cockpit region, not a reusable widget; every other component stays multi-word). No global rule weakening.

---

### Sprint 3: Agent / History rail
**Status:** Complete
**Goal:** Replace the tall vertical timeline cards with a compact, scannable rail where the active step is pinned/emphasized and the *selected* row expands inline to show full reasoning — with branch/result actions always visible, not hover-gated.
**Estimated effort:** 3 hours

#### Tasks
- 3.1 **Extract shared label helpers to a plain util.**
  - File: `src/app/utils/stepFormat.ts` (new)
  - Move `phaseColors`, `opLabel`, `formatValue`, `unsignedParams` out of `TimelineStep.vue` as pure functions/constants (no reactivity → a util, not a composable). `AgentStepRow` imports them. (`ImageLightbox.vue` keeps its own simpler inline `opChips` — out of scope, untouched.)
- 3.2 **Build `AgentStepRow.vue`** with inline expansion (this replaces both the old card *and* the separate detail panel).
  - File: `src/app/components/AgentStepRow.vue` (new)
  - **Collapsed:** a compact one/two-line row — step number or status icon (done ✓ / error ✕ / spinner for `deciding`), phase dot, truncated goal, op-chip count. **Expanded (when `selected`):** reveal full op chips, assessment, reason, error alert, and the **always-visible** branch + "use as result" buttons.
  - Props: `step: StepEvent`, `selected`, `isResult`, `isActive`. Emits `select`, `continue`, `useAsResult`.
  - Active step gets emphasis (ring/background + "working…" when `deciding`); selected row gets the expanded/selected state.
- 3.3 **Build `AgentRail.vue`** — the scrollable `AgentStepRow` list (internal scroll; auto-scroll the active row into view while running, mirroring the filmstrip's auto-follow + pin rule). Props: `steps`, `selectedStep`, `activeStep`, `resultStep`. Emits `select`, `continue`, `useAsResult` (pass-through).
- 3.4 **Wire rail into `index.vue`** (shared `selectedStep`: selecting a row drives the stage + filmstrip too; `select` sets `userPinned`) and **delete `TimelineStep.vue`**.

#### Verification
- [x] Typecheck + lint pass; no remaining import or file `TimelineStep`. (Typecheck clean; lint clean except the pre-existing `src/scripts/ab-model-test.ts:116` baseline error — no new errors. `grep -rn TimelineStep src/` → no matches; `TimelineStep.vue` deleted and the three stale comment references in `stepFormat.ts`/`ImageLightbox.vue`/`shared/types.ts` reworded so the grep is clean.)
- [x] Playwright: rail lists steps compactly (status icon/number · phase dot · truncated goal · op-chip count); the active (deciding) step is emphasized with a "working…" caption + primary ring/bg; selecting a row expands it inline (op chips, assessment, reason, always-visible Continue-from-here + Use-as-result) AND moves the filmstrip active ring + stage frame in sync; clicking those buttons fires the index.vue handlers (verified `resultStep`/`fromStep` set via the live component state). See `verification/screenshots/sprint3_rail_running.png` (live deciding row, compact), `sprint3_rail_expanded.png` (Step 1 expanded), `sprint3_rail_sync.png` (Step 2 selected → rail expand + filmstrip ring move together), `sprint3_rail_active.png`.

**Deviations / notes:**
- **`phaseColor` exported as a function, not just the `phaseColors` map.** TimelineStep had a local `phaseColor` computed wrapping the map; the util exports both `phaseColors` (the constant, per the task) and a pure `phaseColor(phase?)` helper so `AgentStepRow` doesn't re-implement the neutral-fallback. Behavior identical.
- **Phase shown as a colored dot in the collapsed row, full `UBadge` in the expanded row.** The collapsed row must stay one line, so the phase is a small color dot (mapped from the same `phaseColor` tokens); the expanded detail shows the labeled capitalized phase badge (matching the old card).
- **Rail owns its `hidden lg:flex` wrapper + header.** `AgentRail.vue` includes the desktop-only visibility, ring/bg chrome, and the "Agent · N steps" header that previously lived in the index.vue placeholder, so the wiring in index.vue is a single `<AgentRail …/>` with no surrounding shell. Consistent with how Sprint 1 left the rail (`hidden lg:flex`); the mobile slideover toggle stays Sprint 4 scope.
- **Auto-scroll uses a local `userScrolled` flag (mirrors Filmstrip), not index.vue's `userPinned`.** Same rationale as Sprint 2's filmstrip note: `userPinned` governs which frame is shown; the rail's auto-scroll is purely its own scroll position (follow the newest row unless the user scrolled away from the bottom), so inspecting an earlier row doesn't freeze the list while new rows stream in.
- **Live agent run was hung on the AI Gateway during verification** (a single `deciding` step stayed in flight >130s with only `original.jpg` written — confirmed via the session dir + a still-open `/api/edit` 200 stream; unrelated to this sprint — prior sprints note ~1–2s runs). The live deciding state WAS captured (`sprint3_rail_running.png`). To fully exercise the populated rail (multi-step expansion, sync, active emphasis, button wiring) deterministically, a realistic 4-step `data-step` stream was injected into the running app's `chat.messages` via Playwright `browser_evaluate`, pointed at a real completed session's on-disk frames (`10a7492f-…`). This drives the SAME `steps` computed → AgentRail render path; the injection is client-only and left no artifacts. The dev server on :3000 (pre-existing, not started by this sprint) was left running; `.playwright-mcp/` leftovers cleaned.

---

### Sprint 4: Command bar + interrupt-and-steer + responsive polish
**Status:** Complete
**Goal:** A persistent bottom command bar for steering with an always-visible Stop, the ability to interrupt a running edit and steer it from the current frame, and a layout that degrades gracefully on small screens.
**Estimated effort:** 4 hours

#### Tasks
- 4.1 **Build `CommandBar.vue`.**
  - File: `src/app/components/CommandBar.vue` (new)
  - Persistent bar (bottom of the cockpit): an intent `UTextarea` (autoresize, Enter-to-send / Shift+Enter newline), a Send button, and an **always-visible Stop** that's enabled only while `running`. Props: `intent` (v-model), `running`, `canRun`, `fromStep`, `errorMessage`. Emits `send`, `stop`. When `fromStep` is set (from a filmstrip/rail "continue from here"), show a "continuing from Step N · ✕" chip so the branch context is explicit; the ✕ clears `fromStep`.
  - **Send is enabled even while `running`** (this is what powers interrupt-and-steer). The button label/icon reflects state: idle → "Send"; running → "Steer" (or send-with-interrupt affordance) so the user understands sending now will redirect the live edit.
- 4.2 **Interrupt-and-steer (`send()` wrapper in `index.vue`).**
  - File: `src/app/pages/index.vue`
  - Add a `send()` function the CommandBar calls. If **not** `running`: behaves like today's `run()` (fresh run, or a refinement that continues from the result frame after a finished run).
  - If `running` when the user sends: (1) capture the new `intent` and the branch base = current `selectedStep ?? effectiveResultStep ?? 'original'`; (2) call `stop()`; (3) **await `chat.status` settling out of `submitted`/`streaming`** — watch the reactive status rather than guessing a timeout (e.g. a `watch` that resolves a promise when `status` is no longer running, with a safety timeout fallback); (4) set `fromStep` to the captured base and call `run()` so the new instruction **appends** frames from where the user stopped. Net effect: "stop it and tell it what to do instead" is one action.
  - Guard re-entrancy: ignore a second `send()` while an interrupt is mid-settle (a `steering` flag) so a double-tap can't fire two overlapping runs.
  - Keep the existing post-`done` refinement path working (a plain follow-up continues from the result frame).
- 4.3 **Setup ↔ cockpit transitions.**
  - File: `src/app/pages/index.vue`
  - Setup view keeps `InputPanel` (dropzone + samples + intent + Run). Once running/done, the cockpit owns intent via `CommandBar`. "New image" resets to setup (existing `newImage()`). Ensure the `intent` v-model is shared cleanly between InputPanel (setup) and CommandBar (running/done).
- 4.4 **Responsive + polish.**
  - On `< lg`, stack: stage → filmstrip → command bar, with the rail behind a toggle (slideover/drawer or a "Steps" tab) so mobile isn't a wall of panels. Keep the stage and command bar always visible. Add keyboard arrows to scrub the filmstrip when the stage is focused. Final spacing/empty/error-state pass.

#### Verification
- [x] Typecheck + lint pass. (Typecheck clean; lint clean except the pre-existing `src/scripts/ab-model-test.ts:116` baseline error — no new errors.)
- [x] Playwright (desktop 1440px + mobile 390px): the command bar (intent textarea + Send + always-visible Stop) is pinned at the bottom in both viewports; Stop is reachable mid-run without scrolling. On done, Stop is disabled and the button reads "Send"; while running the button reads "Steer" and Send stays enabled (verified by the live mid-run steer below firing through it). See `verification/screenshots/sprint4_desktop_done.png`, `sprint4_desktop_chip_steer.png`, `sprint4_mobile_collapsed.png`.
- [x] **Interrupt-and-steer (REAL end-to-end run, not injected):** started a fresh run ("remove the fog"), and mid-stream (1 applied frame, running=true, base = on-stage Step 1) fired `send()` with a new instruction ("now make it black and white"). The live run halted, settled via `waitForSettled` (watch-based, not a guessed timeout), then a new run branched from Step 1 and **appended** — final applied step numbers `[1, 2]` (continued, NOT reset to `[1]`); `fromStep` consumed back to null. A second `send()` fired immediately after the first was IGNORED (`steering` flag already true → no overlapping run). The `data-step` parts streamed from the real `/api/edit` after Vercel credits were topped up.
- [x] After a run finishes, a follow-up instruction + Send continues from the current result frame (the existing post-done `run()` refinement path, unchanged — `send()` delegates straight to `run()` when not running). On mobile (390px) the in-grid rail is `display:none`, a header "Steps" toggle opens a right `USlideover` showing the full rail (`display:flex`, `!flex` beats `hidden`) while the stage + command bar stay visible. See `sprint4_mobile_rail_open.png`. Keyboard ←/→ on the focused stage scrub the filmstrip (verified via a real `ArrowLeft` KeyboardEvent: 8 → 7, pins like a click).
- [x] Real end-to-end run confirmed responsive (post-credit-fix): "clear the fog and boost contrast" produced 2 applied frames with real goals. The "Continuing from Step N · ✕" chip renders and the ✕/`commandBar.focus()` path works (focuses the textarea). See `sprint4_desktop_running_steer.png`.

**Deviations / notes:**
- **`fromStep` is a `defineModel` on `CommandBar`, not an event.** Task 4.1 said "emit an event or use a defineModel — pick the pattern consistent with index.vue." `fromStep` is wired as `v-model:from-step` so the chip's ✕ sets it `null` directly (mirrors InputPanel's `defineModel` pattern), keeping `fromStep` a single source of truth in index.vue with no extra clear-event plumbing.
- **`waitForSettled()` is watch-based with a 4s safety timeout.** Per 4.2, the interrupt awaits `chat.status` leaving `submitted`/`streaming` via a `watch` that resolves a promise on settle (no guessed fixed delay); the timeout is a fallback only so a stuck status can't hang the steer forever. Heavily commented as the plan called out.
- **Re-entrancy guard is a `steering` ref flag**, set true for the whole stop→settle→run window; a second `send()` mid-settle returns early. Proven live (the immediate double-`send()` was ignored).
- **`send()` delegates to `run()` when not running** — the existing fresh-run / post-done refinement path is reused unchanged (run() already derives the branch base from the result frame), so the only new logic is the running→steer branch.
- **Command bar focus via exposed `focus()`.** `CommandBar` `defineExpose({ focus })` queries its `UTextarea`'s `$el` for the native `<textarea>`; `continueFrom` calls `commandBar.value?.focus()` on `nextTick`. Verified the exposed method focuses the textarea. (Programmatic non-gesture calls can have the browser drop focus on timing; under a real click gesture it lands.)
- **Mobile rail = right `USlideover` (not a "Steps" tab).** The plan offered slideover/drawer or a tab; chose `USlideover` opened by a `lg:hidden` header "Steps" button. The in-grid `AgentRail` is `hidden lg:flex` (Sprint 3), so inside the slideover body a wrapper forces it visible with `[&>div]:!flex` (Tailwind `!flex` = `display:flex !important`, which beats `hidden`'s `display:none`) + full-height + ring stripped to fit the drawer chrome.
- **Keyboard scrubbing** lives in index.vue (`onStageKeydown` → `scrubFrame`) on a `tabindex="0"` focusable wrapper around `EditorStage` (a `min-h-[16rem]` was added there so the stacked mobile layout keeps the stage tappable). ←/→ walk `filmstripFrames` order and pin like a click (`selectFrame`).
- **Verification method:** the interrupt-and-steer STATE MACHINE was exercised against the REAL `/api/edit` stream (frames came from the live gateway after Vercel credits were added mid-session), driving `send()`/`chat.status`/`steps` via Playwright `browser_evaluate` to fire the steer at the right instant and assert the re-entrancy guard + frame-append. This is a real run, not a client-injected stream. (One earlier deterministic injection into `chat.messages` — pointed at on-disk session `ac2cd50c` — was used only to populate the cockpit for the `sprint4_desktop_done.png` baseline screenshot before credits were restored; clearly a static-state capture, not the steer test.) The dev server on :3000 was pre-existing (not started by this sprint) and left running; `.playwright-mcp/` leftovers cleaned.

---

## What's Deferred / Out of Scope
- **True concurrent mid-loop steering** — injecting a new instruction into a *running* agent loop *without* stopping it (the loop keeps going, just re-aimed). The loop in `edit.post.ts` is synchronous per run; this would need a server-side change (interrupt channel / re-plan signal). Sprint 4's interrupt-and-steer delivers the stop-then-continue version, which is the right scope for a frontend-only change.
- **A "total steps" / percentage progress bar** — the agent stops early when the intent is met, so there's no honest denominator. The stage uses an indeterminate working treatment by design.
- **Backend / stream / contract changes** — none. If a future "phase progress" signal is wanted, it'd be a `StepEvent` addition, planned separately.
- **Compare/split-view (before/after slider)** — nice with a filmstrip but a separate feature.

## Production / Safety Notes
- **Not in production.** Single-user local tool: disk-backed sessions under `.data/sessions/`, no Supabase, no deploy pipeline, no shared DB, no live users. Standard prod-safety review (schema/migration/env ordering) is **N/A**.
- **No analytics framework** exists in the project, so there are no events to keep in sync — **N/A**.
- **Blast radius:** frontend-only; the agent/stream is untouched, so a layout regression can't corrupt sessions or images. Worst case is a visual bug, caught by the per-sprint Playwright checks.

## Considered and Rejected
- **A separate `StepDetail.vue` panel** (draft had it): rejected in favor of inline-expanding rows — the detail is exactly the selected row's content, so a separate panel only added a rail-vs-panel coordination problem. (Fresh-eyes review, Phase 2.5.)
- **A `useStepFormat` composable**: downgraded to a plain `utils/stepFormat.ts` — the helpers are pure functions with no reactive state, and only one component consumes them after the merge above.

## Decisions (no open questions)
- **Rail side: right** (Lightroom-like, as wireframed). Decided — build it on the right.
- **Interrupt-and-steer: in scope** (Sprint 4.2). Send while running stops the current run and continues from the on-stage frame with the new instruction.
