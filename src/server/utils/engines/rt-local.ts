// The RawTherapee-local `DevelopEngine` — the `RT_EXECUTION=local` dev runner.
// Renders a `DevelopConfig` by spawning `rawtherapee-cli` against the original,
// layering an optional named-look base pp3 under the agent's delta pp3.
//
// Verified invocation (input LAST), from the pp3 reference doc:
//   rawtherapee-cli -o <out.jpg> -p <look.pp3> -p <delta.pp3> -q -j90 -Y -c <in.jpg>
// RT exits 0 even on bad keys (silent), so a nonzero exit is a real failure.

import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import type { DevelopEngine, DevelopConfig, LookName } from '~~/shared/types'
import { configToPp3 } from '~~/server/utils/pp3'

/**
 * Read the original's pixel dimensions — required by `configToPp3` to emit the
 * `[Crop]` section in pixels. Only needed when a crop is active; returns
 * undefined (skipping the crop) if the metadata can't be read.
 */
async function readDims(originalPath: string): Promise<{ width: number, height: number } | undefined> {
  try {
    const meta = await sharp(originalPath).metadata()
    if (meta.width && meta.height) {
      return { width: meta.width, height: meta.height }
    }
  } catch {
    // fall through — crop is skipped without dims
  }
  return undefined
}

/** True when the config asks for a crop (anything but the full frame). */
function hasCrop(config: DevelopConfig): boolean {
  return config.cropLeft !== 0 || config.cropTop !== 0 || config.cropWidth !== 1 || config.cropHeight !== 1
}

/** Resolved path to the committed look base profiles (`src/looks/`). */
const LOOKS_DIR = resolve(process.cwd(), 'looks')

/**
 * Build the `rawtherapee-cli` flag array. Shared with the sandbox runner (Sprint
 * 2) — only the transport differs, the flags are identical. `pp3Paths` are
 * applied in order (later overrides earlier), so pass the look base FIRST and the
 * agent delta LAST. `-c <input>` MUST be the final option.
 */
export function buildRtArgs(args: {
  inputPath: string
  outputPath: string
  pp3Paths: string[]
}): string[] {
  const flags = ['-o', args.outputPath]
  for (const pp3 of args.pp3Paths) {
    flags.push('-p', pp3)
  }
  flags.push('-q', '-j90', '-Y', '-c', args.inputPath)
  return flags
}

/**
 * Resolve a named look to its committed base pp3 path, or `null` for `'none'` /
 * a missing file (a missing base is non-fatal — RT just renders the delta alone).
 */
async function resolveLookPp3(look: LookName | 'none'): Promise<string | null> {
  if (look === 'none') {
    return null
  }
  const path = join(LOOKS_DIR, `${look}.pp3`)
  try {
    await access(path)
    return path
  } catch {
    return null
  }
}

/** Promise wrapper over `execFile`; rejects on nonzero exit with stderr. */
function runRt(bin: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`rawtherapee-cli failed (${error.message}): ${stderr || '(no stderr)'}`))
        return
      }
      resolvePromise()
    })
  })
}

export class RtLocalEngine implements DevelopEngine {
  /** Binary resolved from `RT_BIN`, defaulting to `rawtherapee-cli` on PATH. */
  private readonly bin = process.env.RT_BIN || 'rawtherapee-cli'

  async renderConfig(args: { sessionId: string, originalPath: string, config: DevelopConfig }): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'aie-rt-'))
    try {
      const deltaPath = join(dir, 'delta.pp3')
      const outputPath = join(dir, 'out.jpg')
      const dims = hasCrop(args.config) ? await readDims(args.originalPath) : undefined
      await writeFile(deltaPath, configToPp3(args.config, dims))

      const lookPath = await resolveLookPp3(args.config.look)
      const pp3Paths = lookPath ? [lookPath, deltaPath] : [deltaPath]

      await runRt(this.bin, buildRtArgs({
        inputPath: args.originalPath,
        outputPath,
        pp3Paths
      }))

      return await readFile(outputPath)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async dispose(_sessionId: string): Promise<void> {
    // Stateless local runner: nothing to release.
  }
}
