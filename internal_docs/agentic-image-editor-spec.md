# Agentic Image Editor — One-Pager

## Summary

A single-page Nuxt tool that takes an **image** plus a **natural-language edit description** and produces an edited image through an **iterative, vision-in-the-loop agent**. Each iteration the model looks at the current image, compares it to the user's intent, applies one editing operation, then re-evaluates — continuing until it judges the goal met (or hits an iteration cap).

This is the closed-loop version of the manual Lightroom workflow: the model stays in the loop and self-corrects instead of handing back to a human between edits.

## Goal / User Flow

1. User drops an image and types an intent (e.g. "straighten the horizon, warm it up, lift the shadows, make it feel like golden hour").
2. Tool runs the agent loop, applying one operation per step.
3. UI shows a live timeline: each step's reasoning, the operation applied, and the resulting image.
4. Final image is downloadable. Every intermediate is kept on disk for inspection.

## Core Concept: Hybrid Plan + ReAct Loop

Two ideas combined:

- **Phase prior (soft plan).** Technical corrections should precede creative ones. The planner is biased toward this ordering: `straighten → crop → exposure/contrast → white balance / color → creative grade → done`. This is a *prior*, not a hard script — the model can skip, reorder, or repeat phases based on what it sees.
- **ReAct per step.** The loop is not preplanned end-to-end. Each iteration the model *observes the actual rendered result* and decides the single next action. This is what makes it self-correcting: if a contrast bump crushed the shadows, it sees that and recovers.

**Key architectural decision:** use a **manual orchestration loop** (not the AI SDK's automatic multi-step tool roundtrip). The automatic roundtrip feeds *text* tool-results back to the model; we need it to see the *new pixels* each step. So each iteration we re-attach the freshly rendered image to the model's context and ask for a structured decision.

### Loop (pseudocode)

```
session = { id, originalPath, currentPath = originalPath, intent, history: [] }

for step in 1..MAX_STEPS:
  decision = await decideNextEdit({
    original: session.originalPath,   // for reference
    current:  session.currentPath,    // model "looks at" this
    intent:   session.intent,
    history:  session.history,        // ops applied so far
    phasePrior: PHASE_ORDER,
  })

  if decision.done: break

  newPath = await executor.apply(session.currentPath, decision.operation)
  session.currentPath = newPath
  session.history.push({ step, decision, newPath })
  emit(step, decision, newPath)       // stream to UI

return session.currentPath
```

### Decision schema (structured output)

Use the AI SDK's structured-output generation with a vision-capable model. Shape:

```ts
{
  assessment: string,            // what the model sees now vs the intent
  done: boolean,                 // goal met?
  phase: 'straighten' | 'crop' | 'exposure' | 'color' | 'creative',
  operation?: {                  // omitted when done
    tool: ToolName,
    params: Record<string, number | string>,
  },
  reason: string,                // why this op next
}
```

## Editing Toolset

A fixed set of operations the agent can choose from. Each maps to one executor implementation. Keep params normalized and small so the model can reason about them.

| Tool | Params | Notes |
|------|--------|-------|
| `straighten` | `angleDeg` | rotate + auto-crop to remove borders |
| `crop` | `aspect` or `{x,y,w,h}` | normalized box or named aspect |
| `exposure` | `ev` | overall brightness in stops |
| `contrast` | `amount` | prefer a tuned curve (sigmoidal), not a linear stretch |
| `whiteBalance` | `temp`, `tint` | or `auto` |
| `saturation` | `amount` | global; vibrance optional later |
| `hueShift` | `deg` | global hue rotation |
| `tone` | `highlights`, `shadows` | region-aware recovery/lift |
| `toneCurve` | `points[]` | advanced; control points + curve mode |
| `look` | `lutName` | creative grade via named 3D LUT (`.cube`) |

**Backend choice (v1):** Sharp (libvips, Node-native, no external binary) for geometry/exposure/color basics. Shell out to **ImageMagick** only for ops Sharp does poorly — `-sigmoidal-contrast` for tuned contrast, `-clut` for LUT application. This keeps v1 mostly in-process while leaving a clean path to richer tone control.

**Explicitly out of scope for v1:** blemish removal and face smoothing. These need detection + segmentation + inpainting (a separate pipeline), not a parametric op. Leave a `retouch` tool stub and revisit.

## Stack & Components

- **Nuxt** (Nuxt UI starter template, out of the box) — one page for now.
- **Vercel AI SDK** for model calls + structured output / vision.
- **Vercel AI Gateway** for model routing: the model is a swappable string/config so we can A/B Claude vs GPT vs Gemini on the "look at the result and decide" judgment without code changes. Set the gateway key via env.
- **Sharp** (+ optional ImageMagick) as the edit executor.
- **Local filesystem** for session storage in v1.

### Single page

`app.vue` (or `pages/index.vue`): upload/drop zone, intent textarea, "Run" button, and a step timeline that renders each iteration's reasoning + thumbnail as events stream in. Final image with download. No routing, no auth, no persistence beyond the working dir.

### Server routes (Nitro)

| Route | Purpose |
|-------|---------|
| `POST /api/session` | create session, store original, return `id` |
| `POST /api/edit` | run the agent loop for a session; **stream** step events (SSE) |
| `GET  /api/image/[id]/[step]` | serve an intermediate or final image |

A non-streaming v1 (run loop, return full step log at the end) is acceptable to start; streaming is the better UX and the intended target.

## Storage & Execution Seams (for the Vercel Sandbox future)

Two interfaces, both implemented locally now, swappable later — this is where Sandbox lands:

- **`StorageAdapter`** — `read/write/list` session files. v1: local dir `.data/sessions/<id>/` with `original.jpg`, `step-01.jpg`, … Later: Vercel Blob / Sandbox FS.
- **`EditExecutor`** — `apply(imagePath, operation) -> newImagePath`. v1: in-process Sharp / local ImageMagick child process. Later: run the op inside a **Vercel Sandbox**.

The Sandbox payoff arrives when edits move beyond the fixed toolset to **model-generated image-processing code** — at that point you want the untrusted code running isolated, not in the Nitro process. Keep the executor boundary clean now so that transition is additive.

## Guardrails

- `MAX_STEPS` cap (e.g. 8) with a hard stop and "best so far" return.
- No-op / oscillation detection: if two consecutive steps undo each other or assessment stops improving, force `done`.
- Per-step operation is singular (one tool per iteration) to keep reasoning legible and the timeline auditable.

## Known Limitations / Open Decisions (for Claude Code)

- Tone curves authored by the model are only as good as the engine's perceptual mapping; sigmoidal contrast + named LUTs cover most v1 needs, full curve authoring is a stretch goal.
- "Done" is a model judgment; consider an optional final side-by-side (original vs result) confirmation pass before returning.
- Decide streaming transport: SSE via Nitro vs a single buffered response for v1.
- Pin AI SDK version and the exact AI Gateway model-string convention at implementation time.

## Milestones

1. Scaffold Nuxt UI starter, single page, upload + intent + run.
2. `StorageAdapter` (local) + `EditExecutor` (Sharp) with 3–4 core tools.
3. Manual agent loop with structured vision decisions through AI Gateway.
4. Stream step events to the timeline UI.
5. Add ImageMagick-backed tuned contrast + LUT look; harden guardrails.
6. (Later) Swap executor/storage to Vercel Sandbox.
