import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import type { DevelopConfig } from '~~/shared/types'
import { DEFAULT_CONFIG } from '~~/shared/types'

/**
 * Local-filesystem session storage over `.data/sessions/<id>/`.
 *
 * This is one of two deliberately swappable seams (the other is EditExecutor) so
 * a future Vercel Sandbox backend can drop in without touching callers. v1 is
 * plain local disk; the class is the contract.
 *
 * Layout per session:
 *   .data/sessions/<id>/original.jpg
 *   .data/sessions/<id>/step-01.jpg, step-02.jpg, ...
 *   .data/sessions/<id>/step-01.json, ...   (the DevelopConfig snapshot per step)
 */
export class LocalStorageAdapter {
  /** Absolute path to `.data/sessions`. Nitro dev runs cwd at the project root. */
  private readonly root = resolve(process.cwd(), '.data', 'sessions')

  /** Absolute path to a session's directory. */
  private dirFor(id: string): string {
    return join(this.root, id)
  }

  /** Create a new session directory and return its id. */
  async createSession(): Promise<string> {
    const id = randomUUID()
    await mkdir(this.dirFor(id), { recursive: true })
    return id
  }

  /**
   * Resolve the absolute path for a step. `'original'` → `original.jpg`;
   * a number N → `step-NN.jpg` (zero-padded to 2 digits).
   */
  pathFor(id: string, step: 'original' | number): string {
    if (step === 'original') {
      return join(this.dirFor(id), 'original.jpg')
    }
    const padded = String(step).padStart(2, '0')
    return join(this.dirFor(id), `step-${padded}.jpg`)
  }

  /**
   * Write the uploaded image as `original.jpg`, normalizing to JPEG via sharp so
   * every downstream step reads a uniform format.
   */
  async writeOriginal(id: string, buffer: Buffer): Promise<void> {
    const jpg = await sharp(buffer).jpeg({ quality: 90 }).toBuffer()
    await writeFile(this.pathFor(id, 'original'), jpg)
  }

  /** Write a step result as `step-NN.jpg`. */
  async writeStep(id: string, step: number, buffer: Buffer): Promise<void> {
    await writeFile(this.pathFor(id, step), buffer)
  }

  /**
   * Write the develop config snapshot for a step as `step-NN.json` (same NN
   * zero-pad as the frame). This is the parametric "preset" that produced the
   * frame — branching ("continue from here") seeds the agent from it.
   */
  async writeConfig(id: string, step: number, config: DevelopConfig): Promise<void> {
    const path = this.pathFor(id, step).replace(/\.jpg$/, '.json')
    await writeFile(path, JSON.stringify(config))
  }

  /**
   * Read the develop config snapshot for `'original'` or step N. Returns
   * `DEFAULT_CONFIG` for `'original'` and as a graceful fallback when the sidecar
   * is missing or unreadable (older sessions have no `.json`).
   */
  async readConfig(id: string, step: 'original' | number): Promise<DevelopConfig> {
    if (step === 'original') return DEFAULT_CONFIG
    const path = this.pathFor(id, step).replace(/\.jpg$/, '.json')
    try {
      return JSON.parse(await readFile(path, 'utf8')) as DevelopConfig
    } catch {
      return DEFAULT_CONFIG
    }
  }

  /** Read the bytes for `'original'` or step N. Throws if missing. */
  async read(id: string, step: 'original' | number): Promise<Buffer> {
    const path = this.pathFor(id, step)
    try {
      return await readFile(path)
    } catch {
      throw new Error(`Image not found: session=${id} step=${step} (${path})`)
    }
  }

  /** Step numbers present for a session, sorted ascending. */
  async listSteps(id: string): Promise<number[]> {
    let entries: string[]
    try {
      entries = await readdir(this.dirFor(id))
    } catch {
      return []
    }
    const steps: number[] = []
    for (const name of entries) {
      const match = name.match(/^step-(\d+)\.jpg$/)
      if (match) {
        steps.push(Number(match[1]))
      }
    }
    return steps.sort((a, b) => a - b)
  }
}

/** Singleton used by routes and the agent loop. */
export const storage = new LocalStorageAdapter()
