# Agentic Image Editor

A single-page Nuxt tool that takes an **image** plus a **natural-language edit description** and produces an edited image through an **iterative, vision-in-the-loop agent**. Each pass the model looks at the current render, compares it to the user's intent, tunes a **develop config** (one absolute value per slider) toward a stated sub-goal, and the server re-renders from the original — then the model re-evaluates and self-corrects until it judges the goal met (or hits an iteration cap).

This is the closed-loop version of the manual Lightroom workflow: the model stays in the loop and corrects its own overshoots instead of handing back to a human between edits.

```
upload image ──▶ type intent ──▶ ┌──────────────────────────────────────────┐ ──▶ result
                                 │  look → assess → adjust full config →      │
                                 │  re-render from original → re-look …       │   (converges or
                                 └──────────────────────────────────────────┘    hits MAX_STEPS)
```

## How it works

Four design decisions define the system:

- **Vision-in-the-loop.** Every iteration the model is shown the *current* render and the *original* (as reference) plus the *current slider values*, and returns a decision. It is not a one-shot — it watches its own output and corrects.
- **Absolute config, never deltas.** The agent returns a full "develop config" of absolute slider values each pass (a preset), restating every slider. The server always re-renders from the original, so there is no compounding: "a touch less contrast" is literally a smaller number, not an inverse op stacked on the last pass. Reducing a value is free and lands exactly where set.
- **Global-only toolset.** Every slider affects the whole frame. No local masking, no healing, no crop-to-reframe. The discipline is restraint — you can't paint a fix into one corner.
- **Branching.** You can continue editing *from any prior frame* ("continue from here"); new frames append to the timeline rather than overwriting it.

The loop stops when the model sets `done`, when the returned config is identical to the current one (nothing left to change), or at the `MAX_STEPS` cap (default 30).

The agent's editing judgment — order of operations, target magnitudes, genre sense, restraint — lives in [`SKILL.md`](SKILL.md) (the operator's playbook) and a token-lean runtime version in `src/server/utils/editing-guide.ts`.

## The toolset

13 global tools, fed to the model as a live registry (`src/server/utils/tools.ts`). All values are absolute.

| Tool | Param(s) — range | What it does |
|------|------------------|--------------|
| `straighten` | `angleDeg` −45..45 | Rotate + auto-crop borders (+ = clockwise) |
| `exposure` | `ev` −3..3 | Overall brightness in stops |
| `contrast` | `amount` −1..1 | Sigmoidal S-curve about mid-gray |
| `tone` | `highlights` −100..100, `shadows` −100..100 | Recover highlights (<0) / open shadows (>0), luminance-masked |
| `toneCurve` | `hi`/`lt`/`dk`/`sh` −100..100 | Parametric 4-zone curve — finer than `tone` |
| `whiteBalance` | `temp` −100..100, `tint` −100..100 | temp+ warmer / tint+ magenta |
| `vibrance` | `amount` −1..1 | Smart, skin-safe saturation |
| `saturation` | `amount` 0..2 (1 = none) | Blunt global color scaler |
| `splitTone` | shadow/highlight `hue` 0..360 + `sat` 0..100, `balance` −100..100 | Cinematic split-tone grade (teal ≈210°, orange ≈40°) |
| `dehaze` | `amount` 0..100 | Cut atmospheric haze / add clarity |
| `denoise` | `luma` 0..100, `chroma` 0..100 | Reduce grain / color speckle |
| `look` | `name` | Named grade: `goldenHour`, `tealOrange`, `noir`, `vintageFade`, `crispClean` |
| `sharpen` | `amount` 0..1 | Output sharpening (finishing step) |

## Quick start

Prerequisites: **Node 22+**, npm, and a **Vercel AI Gateway** API key.

```bash
cd src
npm install            # .npmrc sets legacy-peer-deps=true
cp .env.example .env   # then fill in AI_GATEWAY_API_KEY (see Configuration)
npm run dev            # http://localhost:3000
```

Open the app, drop in an image (or pick one of the bundled samples in `src/public/samples/`), type an intent like *"make it pop"* or *"warm and moody"*, and watch the timeline iterate. Click any prior frame to branch and continue from there.

> **Render engine note (local dev):** the default engine is `local`, which shells out to `rawtherapee-cli`. If that binary isn't installed or working on your machine, set `RT_EXECUTION=sharp` in `.env` for an in-process renderer with zero external dependencies. See [Render engines](#render-engines).

## Configuration

All config is environment variables (see `src/.env.example`). Everything routes through the Vercel AI Gateway, so you swap models by changing one string.

| Variable | Default | Purpose |
|----------|---------|---------|
| `AI_GATEWAY_API_KEY` | — (**required**) | Vercel AI Gateway key. Create at vercel.com → AI Gateway → API Keys. |
| `AGENT_MODEL` | `anthropic/claude-sonnet-4-6` | Vision model as a `provider/model` string. Swap to `anthropic/claude-opus-4.8`, `openai/gpt-5-mini`, `google/gemini-3-flash`, etc. — no code change. |
| `MAX_STEPS` | `30` | Max re-look iterations. Each iteration re-renders the full config. |
| `RT_EXECUTION` | `local` | Render engine: `sharp` \| `local` \| `sandbox`. |
| `RT_BIN` | `rawtherapee-cli` | Path to the local RawTherapee CLI (used by `local`). |
| `RT_SNAPSHOT_ID` | — | Sandbox snapshot id from `build-rt-snapshot.ts` (used by `sandbox`). |
| `VERCEL_OIDC_TOKEN` | — | Vercel Sandbox auth (used by `sandbox`). Dev: `vercel env pull` (TTL ~12h); prod: injected automatically. |

### Swapping the editor model

```bash
# in src/.env
AGENT_MODEL=anthropic/claude-opus-4.8
```

Restart `npm run dev`. A stronger model generally means sharper image reads and fewer, more deliberate passes.

## Render engines

The develop step is a swappable seam (`src/server/utils/engines/`), selected by `RT_EXECUTION`:

| Engine | Needs | Notes |
|--------|-------|-------|
| `sharp` | nothing (in-process) | Zero-dependency fallback. Best for quick local runs when RawTherapee isn't available. |
| `local` *(default)* | `rawtherapee-cli` on PATH or at `RT_BIN` | Full RawTherapee fidelity via PP3 profiles, rendered locally. |
| `sandbox` | `RT_SNAPSHOT_ID` + Vercel auth | Production: RawTherapee in a Vercel Sandbox microVM (one VM per session, disposed in a `finally`). |

**Graceful degradation:** if `sandbox` is selected but its prerequisites are missing (no snapshot id, or an expired/absent OIDC token), the engine falls back to `local` (when `RT_BIN` resolves), else `sharp`, logging a one-line downgrade warning — a render never hard-crashes on missing config.

The `local` and `sandbox` engines layer the agent's delta PP3 over an optional named-look base profile from `src/looks/*.pp3`. The sandbox snapshot is built once with `npx tsx scripts/build-rt-snapshot.ts` — see `internal_docs/20260617_rawtherapee_sandbox_engine/sandbox_setup.md`.

## API

| Method & path | Body / params | Returns |
|---------------|---------------|---------|
| `POST /api/session` | `multipart/form-data`, image field `image` | `{ id }` — new session id |
| `POST /api/edit` | `{ id, intent, fromStep? }` | Streamed `data-step` events (`deciding` → `applied` → `done`/`error`) |
| `GET /api/image/:id/:step` | `step` = `original`, a number, or `step-N` | JPEG bytes (original cached immutable; intermediates `no-store`) |

`fromStep` (a step number or `"original"`) branches the run from that frame; new frames append after the current max step instead of overwriting. Absent → fresh run from the original, numbering from 1.

## Project layout

```
agentic-image-editor/
├── src/                          # the Nuxt 4 app (run everything from here)
│   ├── app/                      # pages + components (InputPanel, TimelineStep, ImageLightbox)
│   ├── server/
│   │   ├── api/                  # session.post, edit.post (the loop), image/[id]/[step].get
│   │   └── utils/                # agent.ts, tools.ts, editing-guide.ts, pp3.ts, storage.ts, engines/
│   ├── shared/                   # types shared client/server (DevelopConfig, etc.)
│   ├── looks/                    # named-look base PP3 profiles
│   ├── public/samples/           # bundled demo images
│   └── scripts/                  # build-rt-snapshot.ts, ab-model-test.ts
├── internal_docs/                # spec + dated implementation plans + sandbox/PP3 reference
├── SKILL.md                      # the editing playbook (taste, order of ops, magnitudes, genre sense)
└── README.md
```

## Scripts

Run from `src/`:

| Command | What it does |
|---------|--------------|
| `npm run dev` | Dev server at http://localhost:3000 |
| `npm run build` / `npm run preview` | Production build / preview |
| `npm run lint` / `npm run typecheck` | ESLint / Nuxt typecheck |
| `npx tsx scripts/build-rt-snapshot.ts` | Build the RawTherapee Vercel Sandbox snapshot (one-time, for `sandbox`) |
| `npx tsx --tsconfig scripts/tsconfig.ab.json scripts/ab-model-test.ts` | Headless A/B: run the real loop across models on sample images, save final frames + per-step logs (needs a working render engine) |

## Docs

- **Editing playbook:** [`SKILL.md`](SKILL.md) — how a pro approaches an edit with this toolset.
- **Spec:** [`internal_docs/agentic-image-editor-spec.md`](internal_docs/agentic-image-editor-spec.md)
- **Implementation plans & references:** [`internal_docs/`](internal_docs/) — dated plan folders, the RawTherapee sandbox setup, and the PP3 reference.
