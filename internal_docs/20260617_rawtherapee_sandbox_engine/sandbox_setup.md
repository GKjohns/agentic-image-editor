# Vercel Sandbox Setup — RawTherapee Snapshot (Sprint 2)

How to build the RawTherapee snapshot the `RT_EXECUTION=sandbox` runner renders
against, wire the auth, and prove the live path. Companion to the implementation
plan's Sprint 2.

**Status (2026-06-17):** built + verified live. Current snapshot:
`RT_SNAPSHOT_ID=snap_iqiVWshEU5lx18IFYzbvR7ObFNGm` (already set in the Vercel
project `agentic-image-editor`, dev + prod). Re-bake per the expiry note below.

---

## 1. One-time auth (dev)

The Sandbox SDK authenticates with a short-lived Vercel **OIDC token**.

```bash
cd src
vercel link            # link this dir to the Vercel project (already done: gkjohns-projects/agentic-image-editor)
vercel env pull .env.local   # writes VERCEL_OIDC_TOKEN (+ other env) into .env.local
```

- The OIDC token has a **~12h TTL in dev** — when a render starts 401-ing, run
  `vercel env pull .env.local` again to refresh it.
- In **Vercel deploys the token is injected automatically** — no `env pull`, no
  manual step. The engine treats the presence of `VERCEL` (deploy env) or
  `VERCEL_OIDC_TOKEN` (dev) as "auth available".
- The engine reads the token implicitly via the SDK; you don't pass it anywhere.

---

## 2. Build the snapshot (one-time, billable)

```bash
cd src
# OIDC must be loaded into the env first:
set -a && . ./.env.local && set +a
node --experimental-strip-types scripts/build-rt-snapshot.ts
```

(Node 22.18+ / 24 — `--experimental-strip-types` runs the `.ts` directly, no
build step. `tsx` is not a dependency.)

The script prints, at the end:

```
=== SNAPSHOT READY ===
RT_SNAPSHOT_ID=snap_xxxxxxxxxxxxxxxxxxxxx
```

Then register it:

```bash
echo -n "snap_xxx..." | vercel env add RT_SNAPSHOT_ID development
echo -n "snap_xxx..." | vercel env add RT_SNAPSHOT_ID production
vercel env pull .env.local      # so dev picks it up
```

### What the script does
1. `Sandbox.create({ runtime: 'node24' })` — a microVM on **Amazon Linux 2023**
   (`dnf`, NOT `apt`; glibc **2.34**).
2. Tries `dnf install -y rawtherapee` first. **There is no AL2023 package** (as of
   2026-06), so it falls through to the AppImage.
3. Vendors the official **RawTherapee 5.11** AppImage, `chmod 0755`,
   `--appimage-extract` into a **persistent** dir (`/opt/rt/app` — `/tmp` is wiped
   on snapshot restore), symlinks the CLI to `/opt/rt/rawtherapee-cli`.
4. Verifies the CLI runs in-VM (asserts the `RawTherapee, version …` banner —
   `--version` exits 2 in 5.11, a known quirk, so the check is banner-based).
5. Bakes the committed `looks/*.pp3` into `/opt/rt/looks` so every session has
   them with zero per-session upload.
6. `sandbox.snapshot()` → prints the id; stops the VM.

### Why AppImage 5.11, not dnf / not 5.12 (the decision)
- **dnf:** AL2023 has no `rawtherapee` package — verified live (`Unable to find a
  match: rawtherapee`). AppImage is the only path.
- **5.11, not 5.12:** the **5.12** AppImage's bundled `libjxl.so.0.11` requires
  `GLIBC_2.35` symbols from the *system* `/lib64/libm.so.6`, which AL2023 (glibc
  2.34) does not provide — `rawtherapee-cli --version` dies with
  `version 'GLIBC_2.35' not found`. `LD_LIBRARY_PATH` can't fix it (the missing
  symbols are in the *system* libm, not a bundled lib). **5.11 runs cleanly on
  glibc 2.34** — verified live. The mapper's PP3 keys are all stable across
  5.10–5.12; only the `[Version]` header differs (5.11 = `Version=350`), which RT
  tolerates in a partial pp3. Bump the AppImage only after re-verifying in-VM.

AppImage URL (pinned in `scripts/build-rt-snapshot.ts`):
`https://github.com/Beep6581/RawTherapee/releases/download/5.11/RawTherapee_5.11_release.AppImage`

---

## 3. Runtime config

| Variable | Where | Notes |
|----------|-------|-------|
| `RT_EXECUTION=sandbox` | prod env | selects the sandbox runner. Dev default stays `local`. |
| `RT_SNAPSHOT_ID` | dev + prod env | from step 2. Required for the sandbox runner. |
| `VERCEL_OIDC_TOKEN` | dev `.env.local` (auto in deploys) | `vercel env pull`, ~12h TTL. |
| `RT_BIN` | dev only | local `rawtherapee-cli` for `RT_EXECUTION=local`. Unused by the sandbox runner. |

If `RT_EXECUTION=sandbox` but the snapshot id or auth is missing, the engine
**degrades** to `local` (if `RT_BIN` resolves) else `sharp`, logging a one-line
downgrade warning. It never hard-crashes a render.

---

## 4. Deploy notes
- **Region:** Sandbox runs in **iad1** (US-East). Deploy the Nuxt app to a US-East
  region so each render's PP3-up / JPEG-down round-trip stays local.
- **Cost:** renders bill on **active CPU only** — roughly **sub-cent per render**.
  `MAX_STEPS` caps a runaway loop; `engine.dispose(id)` in the loop's `finally`
  stops the VM so it never idles/leaks.
- **Snapshot expiry:** snapshots expire **30 days after last use**. If the sandbox
  runner starts failing with a snapshot-not-found, **re-bake** (step 2) and update
  `RT_SNAPSHOT_ID`. (The runner's `Sandbox.create` from a stale snapshot surfaces
  the error per-render; it does not silently fall back.)

---

## 5. Manual verification checklist (the live proof)

Run from `src/` with a fresh `vercel env pull` and `RT_SNAPSHOT_ID` set. These are
the four Sprint-2 acceptance bullets as a runnable checklist.

- [ ] **Full loop renders against a real iad1 microVM.**
  `RT_EXECUTION=sandbox npm run dev`, upload an image, give an intent. Frames
  stream into the timeline exactly as in `local`. (Engine path verified live
  2026-06-17: create-from-snapshot → upload original → writeFiles delta →
  runCommand → readFileToBuffer → 268 KB clean JPEG.)

- [ ] **Snapshot reuse is fast (no reinstall).** A second session's
  `Sandbox.create` from the snapshot is sub-second (measured **307 ms** cold-create
  from snapshot; **~930 ms** for a warm in-loop second render with no re-upload).
  RawTherapee is already baked — no dnf/AppImage step at session start.

- [ ] **Kill a run mid-loop → the VM is stopped (no leak).** Start a run, abort the
  request (close the tab / Ctrl-C the client). The loop's `finally` calls
  `engine.dispose(id)` → `sandbox.stop()`. Confirm via `vercel sandbox ls` (or the
  dashboard) that no VM for that session is left running.

- [ ] **A forced `rawtherapee-cli` error surfaces as an `error` timeline card.**
  Temporarily point the look at a bad in-VM path (or feed a malformed required
  key): the non-zero `exitCode` throws with stderr, the loop's catch emits a
  `data-step` `error`, the run halts cleanly, and `dispose` still stops the VM.
