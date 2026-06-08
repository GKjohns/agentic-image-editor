# Agentic Image Editor

A single-page Nuxt tool: drop an image, type a natural-language edit intent (e.g.
_"straighten the horizon, brighten it, make it pop"_), and watch a **vision-in-the-loop
agent** edit it step by step. Each iteration the model **looks at the current rendered image**,
states a sub-goal and decides a **batch** of editing operations, the server applies them with
Sharp, and the loop continues until the model judges the goal met (or hits a step cap). The
live timeline streaming each batch's goal, ops + result is the centerpiece.

## Quick start

```bash
npm install
cp .env.example .env   # then paste your Vercel AI Gateway key into AI_GATEWAY_API_KEY
npm run dev            # http://localhost:3000
```

No image handy? The UI ships sample photos (a "No image? Try a sample" picker) — the
**Flat & crooked** one best shows the agent at work.

> **macOS dev note:** the `dev` script sets `TMPDIR=/tmp`. Nuxt's vite-node uses a unix
> socket, and the default macOS temp path (`/var/folders/…`) overflows the ~104-char unix
> socket path limit, which 500s the dev server on boot. `/tmp` keeps the path short. Don't
> remove it.

## How it works

```
Browser (app/pages/index.vue)
  1. POST /api/session  (FormData: image)        → writes .data/sessions/<id>/original.jpg → { id }
  2. POST /api/edit     { id, intent, fromStep? }  (stream)  → server runs the MANUAL vision loop:
        for step in 1..MAX_STEPS:
          decision = generateObject({ model: <gateway>, image: current, schema })  // vision + structured
          emit data-step { status:'deciding', goal, operations[], assessment, reason }
          if decision.done: break
          for op in decision.operations (≤ MAX_OPS_PER_BATCH):                      // Sharp
            current = executor.apply(current, op)
          emit data-step { status:'applied', imageUrl:/api/image/<id>/<step> }
  3. GET  /api/image/<id>/<step>                  → serves each intermediate / final jpg

     `/api/edit` also accepts an optional `fromStep` (planned, Sprint 3) — resume the loop
     from a chosen earlier frame instead of the original.
```

The loop is **manual** (not the AI SDK auto tool-roundtrip) so the model sees *new pixels*
each iteration — that's what makes it self-correcting. Decisions stream over the AI SDK
UI-message stream (`createUIMessageStream` + custom `data-step` parts) and the client
consumes them with a plain `fetch` + SSE reader. Each `data-step` part carries
`{ goal, operations[] }` — the batch's stated sub-goal and the ops applied that iteration
(a legacy single `operation?` field remains in the type for back-compat but is no longer
populated).

## Architecture seams (kept swappable for a future Vercel Sandbox)

- **`server/utils/storage.ts`** — `StorageAdapter`. v1 = local `.data/sessions/<id>/`. Later = Blob / Sandbox FS.
- **`server/utils/executor.ts`** — `EditExecutor.apply(path, op) → Buffer`. v1 = in-process Sharp. Later = Sandbox.
- **`server/utils/tools.ts`** — the tool registry (`describeTools()` feeds the prompt; also the source of truth for the decision schema).
- **`server/utils/agent.ts`** — `decideNextEdit()` (the `generateObject` vision call).

## Toolset (Sharp + raw-buffer pixel math — no ImageMagick)

The agent chooses a batch of ops per iteration (each toward a stated sub-goal). Everything
runs in-process: Sharp for geometry/encode,
raw-buffer (`sharp().raw()`) pixel math for the tonal/color curves. No external binary —
which also keeps the future Vercel Sandbox path clean. Pure helpers live in `server/utils/pixels.ts`.

| Phase | Tool | Params | Range | Effect |
|-------|------|--------|-------|--------|
| straighten | `straighten` | `angleDeg` | −45..45 | rotate + center-crop largest inscribed rect |
| exposure | `exposure` | `ev` | −3..3 | brightness in stops (`.linear(2**ev, 0)`) |
| exposure | `contrast` | `amount` | −1..1 | **true sigmoidal** S-curve via a 256-LUT (inverse curve flattens) |
| tone | `tone` | `highlights`, `shadows` | each −100..100 | luminance-masked highlight recovery + shadow lift |
| color | `whiteBalance` | `temp`, `tint` | each −100..100 | temp+ warmer / temp− cooler; tint+ magenta / tint− green |
| color | `saturation` | `amount` | 0..2 (1 = none) | global `.modulate({ saturation })` (blunt) |
| color | `vibrance` | `amount` | −1..1 | smart saturation; protects skin & already-vivid colors |
| creative | `look` | `name` | enum | named grade: `goldenHour`/`tealOrange`/`noir`/`vintageFade`/`crispClean` |
| finish | `sharpen` | `amount` | 0..1 | output sharpening (tuned so 1.0 is crisp, not crunchy) |

The agent's editing judgment — order of operations, target values, intent→ops translation —
lives in [`../SKILL.md`](../SKILL.md) (human playbook) and `server/utils/editing-guide.ts`
(the distilled policy injected into every decision prompt). The loop has no-op / oscillation
detection (force-stop keeps the pre-oscillation frame) on top of the `MAX_STEPS` cap.

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `AI_GATEWAY_API_KEY` | Yes | Vercel AI Gateway key. Routes the vision model. |
| `AGENT_MODEL` | No | Gateway model string (default `anthropic/claude-sonnet-4-6`). Swap providers without code changes. |
| `MAX_STEPS` | No | Agent loop hard cap (default 30). Since Sprint 1 each iteration applies a *batch*, so this now caps **re-look iterations** (kept as `MAX_STEPS` — no rename). |
| `MAX_OPS_PER_BATCH` | No | Max ops the executor applies per batch/iteration (default 6). Excess ops in a batch are dropped. |

## Deferred (see `internal_docs/`)

`crop` / `hueShift` / `toneCurve` (arbitrary control-point curves); `retouch` (needs a
detection/inpainting pipeline — explicit non-goal); a final side-by-side confirmation pass;
Vercel Sandbox executor swap; auth / DB / routing / multi-image. Full spec + implementation
plan live in `../internal_docs/`.
