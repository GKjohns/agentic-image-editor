// `DevelopEngine` factory, keyed on `RT_EXECUTION` (`sharp` | `local` |
// `sandbox`). Default `local` (RawTherapee via the local `rawtherapee-cli`).
//
// PRODUCTION NOTE: the snapshot now exists (snap_iqiVWshEU5lx18IFYzbvR7ObFNGm,
// set in the Vercel project for dev + prod), and prod runs `RT_EXECUTION=sandbox`.
// The compiled DEFAULT here stays `local` so a dev box with no env override (and
// no OIDC) keeps using the local binary; in prod the env var selects `sandbox`
// and the degradation below covers a missing/expired snapshot or token.
//
// Graceful degradation (Production Safety): `RT_EXECUTION=sandbox` only resolves
// to the real `RtSandboxEngine` when its prerequisites exist (a snapshot id AND
// Vercel auth). Missing either → fall back to `local` (if `RT_BIN` resolves)
// else `sharp`, logging a one-line downgrade warning. A render never hard-crashes
// on a missing snapshot/token.
//
// Each engine is a process-wide singleton.

import { existsSync } from 'node:fs'
import type { DevelopEngine } from '~~/shared/types'
import { SharpEngine } from '~~/server/utils/engines/sharp'
import { RtLocalEngine } from '~~/server/utils/engines/rt-local'
import { RtSandboxEngine } from '~~/server/utils/engines/rt-sandbox'

type EngineKind = 'sharp' | 'local' | 'sandbox'

let sharpSingleton: SharpEngine | null = null
let localSingleton: RtLocalEngine | null = null
let sandboxSingleton: RtSandboxEngine | null = null

function sharpEngine(): SharpEngine {
  sharpSingleton ??= new SharpEngine()
  return sharpSingleton
}

function localEngine(): RtLocalEngine {
  localSingleton ??= new RtLocalEngine()
  return localSingleton
}

/**
 * Does the local `rawtherapee-cli` look resolvable? An absolute `RT_BIN` is
 * checked on disk; a bare command name is assumed to be on PATH (we cannot cheaply
 * probe PATH here, so we trust it and let a render surface a clear spawn error).
 */
function rtBinResolves(): boolean {
  const bin = process.env.RT_BIN || 'rawtherapee-cli'
  if (bin.includes('/')) {
    return existsSync(bin)
  }
  return true
}

/** Is Vercel Sandbox auth present? OIDC token in dev, or a Vercel deploy env. */
function sandboxAuthAvailable(): boolean {
  return Boolean(process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL)
}

/**
 * Resolve the `sandbox` runner, or the best available downgrade. Returns the real
 * sandbox engine only when a snapshot id AND auth are present; otherwise logs a
 * one-line downgrade and returns local (preferred) or sharp.
 */
function resolveSandbox(): DevelopEngine {
  const snapshotId = process.env.RT_SNAPSHOT_ID
  const reasons: string[] = []
  if (!snapshotId) {
    reasons.push('RT_SNAPSHOT_ID is not set')
  }
  if (!sandboxAuthAvailable()) {
    reasons.push('no VERCEL_OIDC_TOKEN (run `vercel env pull`)')
  }

  if (snapshotId && reasons.length === 0) {
    sandboxSingleton ??= new RtSandboxEngine(snapshotId)
    return sandboxSingleton
  }

  const fallback = rtBinResolves() ? 'local' : 'sharp'
  console.warn(`[engines] RT_EXECUTION=sandbox unavailable (${reasons.join('; ')}); downgrading to ${fallback}.`)
  return fallback === 'local' ? localEngine() : sharpEngine()
}

/** Resolve the active `DevelopEngine` for this process from `RT_EXECUTION`. */
export function getEngine(): DevelopEngine {
  const kind = (process.env.RT_EXECUTION || 'local') as EngineKind
  switch (kind) {
    case 'sharp':
      return sharpEngine()
    case 'sandbox':
      return resolveSandbox()
    case 'local':
    default:
      return localEngine()
  }
}
