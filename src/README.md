# Agentic Image Editor

A single-page Nuxt tool: drop an image, type a natural-language edit intent (e.g.
_"straighten the horizon, brighten it, make it pop"_), and watch a **vision-in-the-loop
agent** edit it step by step. The agent tunes a single non-destructive **develop config**
(one absolute value per slider). Each iteration the model **looks at the current rendered
image**, states a sub-goal and returns the full updated config, and the server **re-renders
the whole stack from the original** with Sharp — so any slider can move up or down freely
with no compounding. The loop continues until the model judges the goal met or the config
stops changing (or hits the iteration cap). The live timeline streaming each pass's goal,
changed sliders + result is the centerpiece.

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
        config = fromStep ? readConfig(id, fromStep) : DEFAULT_CONFIG   // seed preset
        for step in 1..MAX_STEPS:
          next = decideConfig({ model: <gateway>, image: current, currentConfig: config })  // vision + FULL config
          emit data-step { status:'deciding', goal, operations[], config, assessment, reason }
          if next.done || equalConfig(next, config): break               // done or converged
          current = executor.renderConfig(original, next)                 // re-render from ORIGINAL
          writeStep(id, step, current); writeConfig(id, step, next)
          emit data-step { status:'applied', operations[], config, imageUrl:/api/image/<id>/<step> }
          config = next
  3. GET  /api/image/<id>/<step>                  → serves each intermediate / final jpg

     `/api/edit` also accepts an optional `fromStep` — resume the loop from a chosen earlier
     frame by seeding the agent with that step's stored config snapshot (`step-NN.json`)
     instead of the identity config, then re-rendering from the original.
```

The loop is **manual** (not the AI SDK auto tool-roundtrip) so the model sees *new pixels*
each iteration — that's what makes it self-correcting. Once geometry is active (a straighten
or crop has been applied), `decideConfig` attaches a **third reference image — the current
result with a rule-of-thirds alignment grid overlaid** (`gridReference()` in `server/utils/pixels.ts`)
— so the agent can verify the horizon is level / verticals are true. The clean current+original
images are left ungridded, so color/exposure reads stay honest. Decisions stream over the AI SDK
UI-message stream (`createUIMessageStream` + custom `data-step` parts) and the client
consumes them with a plain `fetch` + SSE reader. Each `data-step` part carries
`{ goal, operations[], config }` — the pass's stated sub-goal, the sliders it *changed*
(the per-step config diff, rendered as chips), and the full develop config after the pass
(a legacy single `operation?` field remains in the type for back-compat but is no longer
populated).

## Architecture seams (kept swappable for a future Vercel Sandbox)

- **`server/utils/storage.ts`** — `StorageAdapter`. v1 = local `.data/sessions/<id>/`. Later = Blob / Sandbox FS.
- **`server/utils/executor.ts`** — `EditExecutor.apply(path, op) → Buffer`. v1 = in-process Sharp. Later = Sandbox.
- **`server/utils/tools.ts`** — the tool registry (`describeTools()` feeds the prompt; also the source of truth for the decision schema).
- **`server/utils/agent.ts`** — `decideConfig()` (the `generateObject` vision call that returns the full develop config).

## Toolset (Sharp + raw-buffer pixel math — no ImageMagick)

The agent returns a full develop config per iteration (toward a stated sub-goal), and the
server renders the non-identity sliders in the order below from the original. Everything
runs in-process: Sharp for geometry/encode,
raw-buffer (`sharp().raw()`) pixel math for the tonal/color curves. No external binary —
which also keeps the future Vercel Sandbox path clean. Pure helpers live in `server/utils/pixels.ts`.

| Phase | Tool | Params | Range | Effect |
|-------|------|--------|-------|--------|
| straighten | `straighten` | `angleDeg` | −45..45 | rotate + center-crop largest inscribed rect |
| straighten | `crop` | `left`/`top`/`width`/`height` (+`aspect`) | 0..1 (w/h 0.1..1) | composition / aspect crop — normalized keep-rect on the post-straighten frame (RT `[Crop]` / Sharp `.extract`) |
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
(the distilled policy injected into every decision prompt). The loop converges when the
model sets `done` or returns a config identical to the current one (nothing left to change),
on top of the `MAX_STEPS` cap.

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `AI_GATEWAY_API_KEY` | Yes | Vercel AI Gateway key. Routes the vision model. |
| `AGENT_MODEL` | No | Gateway model string (default `anthropic/claude-sonnet-4-6`). Swap providers without code changes. |
| `MAX_STEPS` | No | Agent loop hard cap (default 30). Caps the number of **re-look iterations** (each re-renders the develop config). |

## Deferred (see `internal_docs/`)

`hueShift` / arbitrary control-point `toneCurve`; regional masks beyond a single linear
graduated filter (radial, per-region color, brush/AI-subject); `retouch` (needs a
detection/inpainting pipeline — explicit non-goal); auth / DB / routing / multi-image. Full
spec + implementation plan live in `../internal_docs/`.
