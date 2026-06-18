// One-time setup: bake RawTherapee + the committed look bases into a Vercel
// Sandbox snapshot, print the snapshot id for `RT_SNAPSHOT_ID`.
//
// Run from `src/` (needs a fresh OIDC token — `vercel link` then `vercel env pull`):
//   node --experimental-strip-types scripts/build-rt-snapshot.ts
//
// Vercel Sandbox runs Amazon Linux 2023 (dnf, NOT apt) with glibc 2.34. We try
// the distro package first; if dnf has no `rawtherapee` (it doesn't, as of
// 2026-06), we vendor the official AppImage, extract it into a PERSISTENT dir
// (/opt/rt — /tmp is wiped on snapshot restore), and use
// `usr/bin/rawtherapee-cli`. Either way the CLI ends up at `RT_BIN_IN_VM` so the
// engine's invocation is identical.
//
// VERIFIED LIVE (2026-06-17): RawTherapee **5.11** runs on AL2023's glibc 2.34;
// **5.12 does NOT** — its bundled libjxl needs `GLIBC_2.35` symbols from the
// system libm, which AL2023 lacks (`/lib64/libm.so.6: version 'GLIBC_2.35' not
// found`). So we pin 5.11. If you bump this, re-verify `--version` runs in-VM.
//
// This script is NEVER imported by the app — it is operator tooling. It does a
// LIVE, BILLABLE `Sandbox.create` + `snapshot`, so only run it deliberately.

import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Sandbox } from '@vercel/sandbox'

// --- Constants the operator may need to bump ---------------------------------

// Official RawTherapee 5.11 AppImage (x86-64). PINNED to 5.11: 5.12's bundled
// libjxl requires glibc 2.35 which AL2023 (glibc 2.34) lacks. Re-verify in-VM if
// you bump this. The PP3 reference doc was written against 5.12, but every key
// the mapper emits is stable across 5.10–5.12; the only difference is the
// `[Version]` header (5.11 = Version=350), which RT tolerates in a partial pp3.
const RT_APPIMAGE_URL
  = 'https://github.com/Beep6581/RawTherapee/releases/download/5.11/RawTherapee_5.11_release.AppImage'

/** Persistent extraction root (survives snapshot restore; /tmp does not). */
const RT_EXTRACT_DIR = '/opt/rt/app'

/** Where the baked CLI + looks live inside the VM (the engine expects these). */
export const RT_BIN_IN_VM = '/opt/rt/rawtherapee-cli'
export const LOOKS_DIR_IN_VM = '/opt/rt/looks'

/** Local committed look bases (`src/looks/*.pp3`) to bake into the snapshot. */
const LOOKS_DIR_LOCAL = resolve(process.cwd(), 'looks')

/** Generous timeout — install + AppImage extraction can take a few minutes. */
const BUILD_TIMEOUT_MS = 15 * 60 * 1000
const CMD_TIMEOUT_MS = 10 * 60 * 1000

/** Run a command, log it, and throw on a nonzero exit with captured stderr. */
async function run(sandbox: Sandbox, cmd: string, args: string[]): Promise<string> {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  const result = await sandbox.runCommand(cmd, args, { timeoutMs: CMD_TIMEOUT_MS })
  const stdout = await result.stdout()
  if (result.exitCode !== 0) {
    const stderr = await result.stderr()
    throw new Error(`\`${cmd}\` exited ${result.exitCode}: ${stderr || stdout || '(no output)'}`)
  }
  return stdout
}

/** Try `dnf install rawtherapee`; return true if the CLI is then on PATH. */
async function tryDnfInstall(sandbox: Sandbox): Promise<boolean> {
  try {
    await run(sandbox, 'sudo', ['dnf', 'install', '-y', 'rawtherapee'])
    const probe = await sandbox.runCommand('rawtherapee-cli', ['--version'], { timeoutMs: CMD_TIMEOUT_MS })
    return probe.exitCode === 0
  } catch (error) {
    console.log(`[dnf] no usable package (${error instanceof Error ? error.message : String(error)})`)
    return false
  }
}

/** Vendor the official AppImage, extract it, and expose the CLI at RT_BIN_IN_VM. */
async function installAppImage(sandbox: Sandbox): Promise<void> {
  console.log(`[appimage] vendoring ${RT_APPIMAGE_URL}`)
  // Extract into a PERSISTENT dir so the snapshot keeps it (/tmp is wiped on
  // restore). FUSE is unavailable in microVMs, so we extract rather than run-mount.
  // `/opt/rt` is already created + owned by vercel-sandbox by the caller.
  await run(sandbox, 'mkdir', ['-p', RT_EXTRACT_DIR])
  await run(sandbox, 'curl', ['-fSL', '-o', '/tmp/rt.AppImage', RT_APPIMAGE_URL])
  await run(sandbox, 'chmod', ['0755', '/tmp/rt.AppImage'])
  // `--appimage-extract` always writes ./squashfs-root in cwd; run it inside the
  // persistent dir so the extracted tree lands at RT_EXTRACT_DIR/squashfs-root.
  await run(sandbox, 'sh', ['-c', `cd ${RT_EXTRACT_DIR} && /tmp/rt.AppImage --appimage-extract`])
  // Symlink the extracted CLI to the stable path the engine invokes.
  await run(sandbox, 'ln', ['-sf', `${RT_EXTRACT_DIR}/squashfs-root/usr/bin/rawtherapee-cli`, RT_BIN_IN_VM])
}

async function main(): Promise<void> {
  console.log('[snapshot] creating a node24 sandbox on Amazon Linux 2023...')
  const sandbox = await Sandbox.create({ runtime: 'node24', timeout: BUILD_TIMEOUT_MS })

  try {
    // `/opt/rt` is owned by `vercel-sandbox` so later writeFiles (looks) succeed.
    await run(sandbox, 'sudo', ['mkdir', '-p', '/opt/rt'])
    await run(sandbox, 'sudo', ['chown', '-R', 'vercel-sandbox', '/opt/rt'])

    const dnfOk = await tryDnfInstall(sandbox)
    if (dnfOk) {
      console.log('[snapshot] installed RawTherapee via dnf (CLI on PATH).')
      // Normalize to the stable path so the engine never branches.
      const which = (await run(sandbox, 'sh', ['-c', 'command -v rawtherapee-cli'])).trim()
      await run(sandbox, 'ln', ['-sf', which, RT_BIN_IN_VM])
    } else {
      console.log('[snapshot] dnf path unavailable; vendoring the AppImage.')
      await installAppImage(sandbox)
    }

    // Verify the CLI runs inside the VM (fail loud if not). NOTE: `--version`
    // exits 2 in RT 5.11 (a known quirk — actual renders exit 0), so we assert on
    // the banner in stdout rather than on the exit code.
    const probe = await sandbox.runCommand(RT_BIN_IN_VM, ['--version'], { timeoutMs: CMD_TIMEOUT_MS })
    const banner = await probe.stdout()
    if (!/RawTherapee, version/i.test(banner)) {
      const stderr = await probe.stderr()
      throw new Error(`rawtherapee-cli did not run (exit ${probe.exitCode}): ${stderr || banner || '(no output)'}`)
    }
    console.log(`[snapshot] rawtherapee-cli verified: ${banner.trim().split('\n')[0]}`)

    // Bake the committed look bases so every session has them with no per-session upload.
    await run(sandbox, 'mkdir', ['-p', LOOKS_DIR_IN_VM])
    const lookFiles = (await readdir(LOOKS_DIR_LOCAL)).filter(name => name.endsWith('.pp3'))
    const looks = await Promise.all(lookFiles.map(async name => ({
      path: join(LOOKS_DIR_IN_VM, name),
      content: await readFile(join(LOOKS_DIR_LOCAL, name))
    })))
    await sandbox.writeFiles(looks)
    console.log(`[snapshot] baked ${looks.length} look base(s) into ${LOOKS_DIR_IN_VM}.`)

    // Snapshot (this stops the VM). 0 = no expiration; default is 30 days idle.
    console.log('[snapshot] creating snapshot (this stops the VM)...')
    const snapshot = await sandbox.snapshot()
    console.log('\n=== SNAPSHOT READY ===')
    console.log(`RT_SNAPSHOT_ID=${snapshot.snapshotId}`)
    console.log('Set that in .env (and `vercel env add RT_SNAPSHOT_ID`) to enable RT_EXECUTION=sandbox.')
  } finally {
    // If snapshot() already stopped the VM this is a harmless no-op; if we
    // threw before snapshotting, this releases the live VM so it never leaks.
    try {
      await sandbox.stop()
    } catch {
      // Already stopped by snapshot() — ignore.
    }
  }
}

main().catch((error) => {
  console.error('[snapshot] FAILED:', error instanceof Error ? error.message : error)
  process.exit(1)
})
