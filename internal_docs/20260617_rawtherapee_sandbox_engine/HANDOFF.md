# Handoff — RawTherapee Sandbox Engine

**Branch:** `rawtherapee-sandbox-engine`
**Status:** Plan approved & review-hardened. No code written yet. Start at Sprint 1, task 1.0.

## What this is
Swap the agent's hand-rolled Sharp render engine for **RawTherapee** (`rawtherapee-cli` + PP3 profiles), run in a **Vercel Sandbox** in prod / a local binary in dev. The vision agent keeps deciding in semantic sliders; the server deterministically maps that to PP3. Full rationale, architecture, and sprint breakdown are in **`implementation_plan.md`** — read it whole before touching code.

## How to execute
Use the `implementation-plan` skill in **execute-existing-plan mode** (start at Phase 4): run each sprint in its own subagent, test after each (typecheck + eslint + a real render), update the plan's sprint status as you go, and build the Phase-5 verification artifact (`verification/index.html` with before/after renders) before reporting done.

**Sprint order:** 1 → 2 deliver the engine swap and stand alone as a shippable PR. 3 (richer config) and 4 (`useChat`) are decoupled follow-ons.

## Critical constraints (do not violate)
- **Task 1.0 is the gate.** Do NOT write `configToPp3()` from memory. Install `rawtherapee-cli`, make a real GUI edit, capture the emitted `.pp3`, and verify every section/key against it. PP3 fails *silently* on wrong keys. `[Dehaze]` and the parametric `[ToneCurve]` encoding are unverified.
- **Keep the structured-output schema FLAT.** Nesting it triggers the sonnet repetition loop → `AI_JSONParseError` (see `server/utils/agent.ts:8-21`). Sprint 3 doubles the field count — add fields incrementally and smoke-test for `finishReason:'length'`.
- **Respect the two documented swappable seams** (`EditExecutor` in `executor.ts`, `LocalStorageAdapter` in `storage.ts`). The engine interface stays *stateless* (`renderConfig({sessionId, originalPath, config})` + `dispose(sessionId)`) — no `open()`/`RenderSession` object.
- **Sharp stays** for input normalization (`storage.writeOriginal`) and as the `RT_EXECUTION=sharp` fallback.

## Repo facts
- The Nuxt 4 app is in **`src/`** — run everything from there (`cd src && npm run dev`, `npm run typecheck`, `npm run lint`). Plan/docs live at repo root in `internal_docs/`.
- Follow `~/claude-ops/conventions/` (esp. `ai_sdk_usage.md`) and the existing code style (eslint stylistic: no comma-dangle, 1tbs).
- Env additions are in the plan's Environment table (`RT_EXECUTION`, `RT_BIN`, `RT_SNAPSHOT_ID`, `VERCEL_OIDC_TOKEN`). Default `RT_EXECUTION=local` until Sprint 2, then `sandbox`.

## One open decision (confirm with Kyle, doesn't block Sprint 1)
Sprint 3: keep the 5 named `look` grades as fixed PP3 bases, or retire them for the new split-tone sliders? Author leans **keep them** (one-move convenience) but have the editing-guide prefer parametric grades for nuance.

## Companion docs to produce during build
- `rawtherapee_pp3_reference.md` (Sprint 1, task 1.0) — verified PP3 keys + curve encoding + `configToPp3` mapping table.
- `sandbox_setup.md` (Sprint 2) — snapshot build steps, AppImage URL, OIDC auth, iad1 + cost notes.
