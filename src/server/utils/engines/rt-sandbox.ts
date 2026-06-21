// The RawTherapee-sandbox `DevelopEngine` — the `RT_EXECUTION=sandbox` production
// runner. Renders a `DevelopConfig` by driving `rawtherapee-cli` inside a Vercel
// Sandbox microVM created from a pre-baked snapshot (RawTherapee + the look bases
// are baked in by `scripts/build-rt-snapshot.ts`).
//
// Only the TRANSPORT differs from `rt-local`: it reuses `configToPp3()` and
// `buildRtArgs()` from Sprint 1 verbatim. The pp3/flag semantics are identical;
// the look base path just points at the in-VM baked location instead of `src/looks`.
//
// Lifecycle: one warm VM per `sessionId`, kept in an internal Map. The first
// render for a session creates the VM from the snapshot and uploads the original
// once; subsequent renders in the same loop reuse it. `dispose(sessionId)` stops
// the VM and drops it from the map (runs in the loop's `finally`, so no leak on
// error/abort).

import { readFile } from 'node:fs/promises'
import { Sandbox } from '@vercel/sandbox'
import sharp from 'sharp'
import type { DevelopEngine, DevelopConfig, LookName } from '~~/shared/types'
import { configToPp3 } from '~~/server/utils/pp3'
import { buildRtArgs } from '~~/server/utils/engines/rt-local'

/** Crop active = the keep-rectangle is anything but the full frame. */
function hasCrop(config: DevelopConfig): boolean {
  return config.cropLeft !== 0 || config.cropTop !== 0 || config.cropWidth !== 1 || config.cropHeight !== 1
}

/** In-VM paths the snapshot bakes (must match `scripts/build-rt-snapshot.ts`). */
const RT_BIN_IN_VM = '/opt/rt/rawtherapee-cli'
const LOOKS_DIR_IN_VM = '/opt/rt/looks'

/** Working dir inside the VM for this session's transient files. */
const WORK_DIR = '/vercel/sandbox'
const ORIGINAL_PATH = `${WORK_DIR}/original.jpg`
const DELTA_PATH = `${WORK_DIR}/delta.pp3`
const OUTPUT_PATH = `${WORK_DIR}/out.jpg`

/**
 * VM lifetime must cover a full MAX_STEPS loop (each iteration = one vision call
 * + one render). 15 min is comfortably above the default cap; the loop disposes
 * the VM as soon as it finishes, so this is just the leak ceiling.
 */
const SANDBOX_TIMEOUT_MS = 15 * 60 * 1000

/** Per-render command timeout — a single `rawtherapee-cli` invocation. */
const RENDER_TIMEOUT_MS = 2 * 60 * 1000

interface SessionState {
  /** Resolves to the warm VM (shared across concurrent renders for a session). */
  sandbox: Promise<Sandbox>
  /** Resolves once `original.jpg` has been uploaded (uploaded exactly once). */
  ready: Promise<void>
}

export class RtSandboxEngine implements DevelopEngine {
  /** Snapshot id the VMs are created from (the baked RawTherapee image). */
  private readonly snapshotId: string

  /** Warm-VM cache keyed by sessionId — the only state this runner keeps. */
  private readonly sessions = new Map<string, SessionState>()

  constructor(snapshotId: string) {
    this.snapshotId = snapshotId
  }

  /**
   * Get (or lazily create) the warm VM + original upload for a session. Both the
   * VM creation and the one-time upload are memoized so N concurrent renders and
   * an earlier `warm()` call all share a single provisioning.
   */
  private ensureSession(sessionId: string, originalPath: string): SessionState {
    let state = this.sessions.get(sessionId)
    if (state) {
      return state
    }
    const sandbox = Sandbox.create({
      source: { type: 'snapshot', snapshotId: this.snapshotId },
      timeout: SANDBOX_TIMEOUT_MS
    })
    const ready = (async () => {
      const sbx = await sandbox
      const original = await readFile(originalPath)
      await sbx.writeFiles([{ path: ORIGINAL_PATH, content: original }])
    })()
    state = { sandbox, ready }
    this.sessions.set(sessionId, state)
    return state
  }

  /** Resolve the in-VM baked look base path, or `null` for `'none'`. */
  private lookPathInVm(look: LookName | 'none'): string | null {
    return look === 'none' ? null : `${LOOKS_DIR_IN_VM}/${look}.pp3`
  }

  async warm(sessionId: string, originalPath: string): Promise<void> {
    // Provision the VM + upload the original ahead of the first render. The
    // caller fires this and forgets it; surface nothing.
    await this.ensureSession(sessionId, originalPath).ready
  }

  async renderConfig(args: { sessionId: string, originalPath: string, config: DevelopConfig }): Promise<Buffer> {
    const state = this.ensureSession(args.sessionId, args.originalPath)
    const sandbox = await state.sandbox
    await state.ready

    // Write the agent's delta pp3 for this render (the original + look bases are
    // already in the VM). Look base FIRST, delta LAST — later -p overrides earlier.
    // Crop needs the original's pixel dims (read locally from the source file —
    // it's still on the host disk; the VM only ever sees the upload). Skip when
    // crop is identity to avoid a needless metadata read.
    let dims: { width: number, height: number } | undefined
    if (hasCrop(args.config)) {
      const meta = await sharp(args.originalPath).metadata()
      if (meta.width && meta.height) {
        dims = { width: meta.width, height: meta.height }
      }
    }
    await sandbox.writeFiles([{ path: DELTA_PATH, content: configToPp3(args.config, dims) }])
    const lookPath = this.lookPathInVm(args.config.look)
    const pp3Paths = lookPath ? [lookPath, DELTA_PATH] : [DELTA_PATH]

    const rtArgs = buildRtArgs({
      inputPath: ORIGINAL_PATH,
      outputPath: OUTPUT_PATH,
      pp3Paths
    })

    const result = await sandbox.runCommand(RT_BIN_IN_VM, rtArgs, { timeoutMs: RENDER_TIMEOUT_MS })
    if (result.exitCode !== 0) {
      const stderr = await result.stderr()
      throw new Error(`rawtherapee-cli failed (exit ${result.exitCode}): ${stderr || '(no stderr)'}`)
    }

    const buffer = await sandbox.readFileToBuffer({ path: OUTPUT_PATH })
    if (!buffer) {
      throw new Error(`rawtherapee-cli produced no output at ${OUTPUT_PATH}`)
    }
    return buffer
  }

  async dispose(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) {
      return
    }
    this.sessions.delete(sessionId)
    // Stop the VM on loop end. (Cross-turn refinement re-creates from the
    // snapshot — a fast recreate we accept over a long-lived idle VM. A future
    // idle-TTL reaper that keeps the VM warm across turns is deferred.)
    try {
      const sandbox = await state.sandbox
      await sandbox.stop()
    } catch {
      // VM may already be gone (failed create, prior stop) — disposing is best-effort.
    }
  }
}
