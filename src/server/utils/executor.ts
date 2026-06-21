import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import type { DevelopConfig, Operation } from '~~/shared/types'
import {
  applyChannelLut,
  applyGrayscale,
  applyTone,
  applyVibrance,
  applyWhiteBalance,
  blendWithMask,
  buildSigmoidalLut,
  clamp255,
  linearMask
} from './pixels'

/**
 * Largest axis-aligned rectangle (same orientation as the source) that fits
 * inside a w×h image rotated by `angle` radians. Standard "rotated rectangle
 * with max area" derivation. Returns the inscribed rect dimensions.
 */
function rotatedRectWithMaxArea(w: number, h: number, angle: number): { width: number, height: number } {
  if (w <= 0 || h <= 0) {
    return { width: 0, height: 0 }
  }
  const sinA = Math.abs(Math.sin(angle))
  const cosA = Math.abs(Math.cos(angle))

  let wr: number
  let hr: number

  if (w <= h) {
    if (sinA * w > cosA * h || cosA * w < sinA * h) {
      // Half-constrained: the rect is limited by the shorter side.
      const x = 0.5 * Math.min(w, h)
      if (cosA <= sinA) {
        wr = x / sinA
        hr = x / cosA
      } else {
        wr = x / cosA
        hr = x / sinA
      }
    } else {
      const cos2a = cosA * cosA - sinA * sinA
      wr = (w * cosA - h * sinA) / cos2a
      hr = (h * cosA - w * sinA) / cos2a
    }
  } else {
    if (sinA * h > cosA * w || cosA * h < sinA * w) {
      const x = 0.5 * Math.min(w, h)
      if (cosA <= sinA) {
        wr = x / sinA
        hr = x / cosA
      } else {
        wr = x / cosA
        hr = x / sinA
      }
    } else {
      const cos2a = cosA * cosA - sinA * sinA
      wr = (w * cosA - h * sinA) / cos2a
      hr = (h * cosA - w * sinA) / cos2a
    }
  }

  return { width: Math.floor(wr), height: Math.floor(hr) }
}

/** Pull a Sharp input into a raw interleaved buffer plus its geometry. */
async function toRaw(input: string | Buffer): Promise<{ data: Buffer, width: number, height: number, channels: number }> {
  const { data, info } = await sharp(input).raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, channels: info.channels }
}

/** Re-encode a mutated raw buffer back to a quality-90 JPEG. */
function fromRaw(data: Buffer, width: number, height: number, channels: number): Promise<Buffer> {
  // Sharp types `channels` as a literal union (1..4); the raw decode guarantees
  // a valid value, so cast through the structural shape it expects.
  const raw = { width, height, channels: channels as 1 | 2 | 3 | 4 }
  return sharp(data, { raw }).jpeg({ quality: 90 }).toBuffer()
}

/**
 * Per-channel multiply + add directly on a raw buffer (channel curves used by
 * the creative `look` grades). `mul`/`add` are length-3 [R,G,B]. In place.
 */
function applyChannelGainOffset(data: Buffer, channels: number, mul: [number, number, number], add: [number, number, number]): void {
  for (let i = 0; i < data.length; i += channels) {
    data[i] = clamp255(data[i]! * mul[0] + add[0])
    data[i + 1] = clamp255(data[i + 1]! * mul[1] + add[1])
    data[i + 2] = clamp255(data[i + 2]! * mul[2] + add[2])
  }
}

/** The named creative grades, each a tasteful stack of the primitives. */
const LOOKS = ['goldenHour', 'tealOrange', 'noir', 'vintageFade', 'crispClean'] as const
type LookName = typeof LOOKS[number]

/**
 * Apply a named look to a raw buffer in place. Each grade is tuned to read like
 * a pro LUT at ~60% opacity — present but not heavy-handed.
 */
function applyLook(data: Buffer, channels: number, name: LookName): void {
  switch (name) {
    case 'goldenHour': {
      // Warm WB push, gentle contrast, lifted+warm shadows, modest vibrance.
      applyWhiteBalance(data, channels, 38, 6)
      applyChannelLut(data, channels, buildSigmoidalLut(0.18))
      applyTone(data, channels, 4, 14) // lift shadows a touch
      applyVibrance(data, channels, 0.18)
      // Slightly crushed-warm blacks: tiny positive offset on R, negative on B.
      applyChannelGainOffset(data, channels, [1, 1, 1], [4, 1, -5])
      break
    }
    case 'tealOrange': {
      // Cinematic split: shadows toward teal/blue, highlights/skin toward orange.
      applyChannelLut(data, channels, buildSigmoidalLut(0.28))
      // Shadow lift in blue, highlight push in red via gain+offset.
      applyChannelGainOffset(data, channels, [1.06, 1.0, 0.96], [6, 0, 10])
      applyVibrance(data, channels, 0.12)
      break
    }
    case 'noir': {
      // High-contrast monochrome with deepened shadows.
      applyGrayscale(data, channels)
      applyChannelLut(data, channels, buildSigmoidalLut(0.55))
      applyTone(data, channels, -6, -18)
      break
    }
    case 'vintageFade': {
      // Lifted milky blacks, reduced contrast, desaturated, warm-yellow cast.
      applyChannelLut(data, channels, buildSigmoidalLut(-0.35))
      applyTone(data, channels, -4, 26) // strong shadow lift = faded blacks
      applyVibrance(data, channels, -0.28)
      applyWhiteBalance(data, channels, 20, -8) // warm + slightly green/yellow
      applyChannelGainOffset(data, channels, [1, 1, 1], [14, 10, 0]) // milky lift
      break
    }
    case 'crispClean': {
      // Neutral editorial: small contrast bump + mild vibrance, no color cast.
      applyChannelLut(data, channels, buildSigmoidalLut(0.16))
      applyVibrance(data, channels, 0.14)
      break
    }
  }
}

/**
 * Applies a single Operation to an image and returns the resulting JPEG buffer.
 *
 * The second deliberately swappable seam (the other is StorageAdapter): a future
 * ImageMagick / Vercel Sandbox executor can implement the same `apply` contract.
 *
 * Param conventions (kept in lockstep with `tools.ts`):
 *   straighten  { angleDeg }              rotate then center-crop inscribed rect.
 *   crop        { left, top, width, height }  normalized 0..1 keep-rect → .extract.
 *   exposure    { ev }                    EV stops, multiplicative gain 2 ** ev.
 *   contrast    { amount }                -1..1 → sigmoidal S-curve LUT.
 *   tone        { highlights, shadows }   -100..100 each, luminance-masked.
 *   whiteBalance{ temp, tint }            -100..100 each, per-channel gain.
 *   saturation  { amount }                0..2 multiplier via modulate().
 *   vibrance    { amount }                -1..1 smart, sat-aware saturation.
 *   look        { name }                  named parametric creative grade.
 *   gradFilter  { angle, position, feather, exposure }  linear ND filter via matte.
 *   sharpen     { amount }                0..1 → Sharp native unsharp.
 */
export class EditExecutor {
  async apply(inputPath: string, operation: Operation): Promise<Buffer> {
    const { tool, params } = operation

    switch (tool) {
      case 'exposure': {
        const ev = Number(params.ev) || 0
        // EV stops are multiplicative: a 1-stop change doubles linear brightness.
        return sharp(inputPath)
          .linear(2 ** ev, 0)
          .jpeg({ quality: 90 })
          .toBuffer()
      }

      case 'saturation': {
        const amount = Number(params.amount)
        const saturation = Number.isFinite(amount) ? amount : 1
        return sharp(inputPath)
          .modulate({ saturation })
          .jpeg({ quality: 90 })
          .toBuffer()
      }

      case 'contrast': {
        // True sigmoidal contrast about mid-gray via a precomputed 256-LUT.
        // amount -1..1 → alpha = |amount|*8; positive = steeper S-curve (more
        // contrast), negative = inverse sigmoid (genuinely flatter). See pixels.ts.
        const amount = Math.max(-1, Math.min(1, Number(params.amount) || 0))
        const { data, width, height, channels } = await toRaw(inputPath)
        applyChannelLut(data, channels, buildSigmoidalLut(amount))
        return fromRaw(data, width, height, channels)
      }

      case 'tone': {
        const highlights = Math.max(-100, Math.min(100, Number(params.highlights) || 0))
        const shadows = Math.max(-100, Math.min(100, Number(params.shadows) || 0))
        const { data, width, height, channels } = await toRaw(inputPath)
        applyTone(data, channels, highlights, shadows)
        return fromRaw(data, width, height, channels)
      }

      case 'whiteBalance': {
        const temp = Math.max(-100, Math.min(100, Number(params.temp) || 0))
        const tint = Math.max(-100, Math.min(100, Number(params.tint) || 0))
        const { data, width, height, channels } = await toRaw(inputPath)
        applyWhiteBalance(data, channels, temp, tint)
        return fromRaw(data, width, height, channels)
      }

      case 'vibrance': {
        const amount = Math.max(-1, Math.min(1, Number(params.amount) || 0))
        const { data, width, height, channels } = await toRaw(inputPath)
        applyVibrance(data, channels, amount)
        return fromRaw(data, width, height, channels)
      }

      case 'look': {
        const name = String(params.name) as LookName
        if (!LOOKS.includes(name)) {
          throw new Error(`Unknown look: ${name}. Expected one of: ${LOOKS.join(', ')}`)
        }
        const { data, width, height, channels } = await toRaw(inputPath)
        applyLook(data, channels, name)
        return fromRaw(data, width, height, channels)
      }

      case 'sharpen': {
        // Map amount 0..1 to a gentle unsharp. sigma grows with amount; we keep
        // the flat/jagged thresholds modest so amount=1 reads "crisp" not "crunchy".
        const amount = Math.max(0, Math.min(1, Number(params.amount) || 0))
        if (amount === 0) {
          return sharp(inputPath).jpeg({ quality: 90 }).toBuffer()
        }
        return sharp(inputPath)
          .sharpen({ sigma: 0.5 + amount * 1.5, m1: 0, m2: 1 + amount * 2 })
          .jpeg({ quality: 90 })
          .toBuffer()
      }

      case 'crop': {
        // Normalized keep-rectangle (0..1 of the POST-straighten frame) → pixels
        // against THIS input's metadata. Runs after straighten in renderConfig, so
        // the metadata here is already the leveled frame. Guard against a zero or
        // out-of-bounds extract (Sharp throws on a non-positive or oversized rect).
        const left = Math.max(0, Math.min(1, Number(params.left) || 0))
        const top = Math.max(0, Math.min(1, Number(params.top) || 0))
        const width = Math.max(0, Math.min(1, Number(params.width)))
        const height = Math.max(0, Math.min(1, Number(params.height)))
        const meta = await sharp(inputPath).metadata()
        const iw = meta.width ?? 0
        const ih = meta.height ?? 0
        const px = Math.min(iw - 1, Math.max(0, Math.round(left * iw)))
        const py = Math.min(ih - 1, Math.max(0, Math.round(top * ih)))
        const pw = Math.max(1, Math.min(iw - px, Math.round(width * iw)))
        const ph = Math.max(1, Math.min(ih - py, Math.round(height * ih)))
        if (iw === 0 || ih === 0 || (px === 0 && py === 0 && pw === iw && ph === ih)) {
          // Nothing valid to crop (or a full-frame crop) — pass through.
          return sharp(inputPath).jpeg({ quality: 90 }).toBuffer()
        }
        return sharp(inputPath)
          .extract({ left: px, top: py, width: pw, height: ph })
          .jpeg({ quality: 90 })
          .toBuffer()
      }

      case 'gradFilter': {
        // One linear graduated (ND) exposure filter. Render the exposure shift on
        // a FULL copy of the frame, then alpha-blend it over the base through a
        // linear matte so only the masked side (e.g. the sky) is affected. EV is
        // multiplicative (2 ** ev); NEGATIVE darkens (matches gradExposure sign).
        const ev = Number(params.exposure) || 0
        const angle = Number(params.angle) || 0
        const position = Number.isFinite(Number(params.position)) ? Number(params.position) : 0.5
        const feather = Number(params.feather) || 0
        if (ev === 0) {
          return sharp(inputPath).jpeg({ quality: 90 }).toBuffer()
        }
        const { data, width, height, channels } = await toRaw(inputPath)
        // Adjusted copy: the same frame at the shifted exposure.
        const adj = Buffer.from(data)
        const gain = 2 ** ev
        for (let i = 0; i < adj.length; i += channels) {
          adj[i] = clamp255(adj[i]! * gain)
          adj[i + 1] = clamp255(adj[i + 1]! * gain)
          adj[i + 2] = clamp255(adj[i + 2]! * gain)
        }
        const mask = linearMask(width, height, angle, position, feather)
        blendWithMask(data, adj, channels, mask)
        return fromRaw(data, width, height, channels)
      }

      case 'straighten': {
        const angleDeg = Number(params.angleDeg) || 0

        // Rotate first; Sharp expands the canvas and fills wedges with black.
        const rotated = sharp(inputPath).rotate(angleDeg, { background: { r: 0, g: 0, b: 0, alpha: 1 } })
        const rotatedBuf = await rotated.toBuffer()
        const meta = await sharp(rotatedBuf).metadata()
        const rw = meta.width ?? 0
        const rh = meta.height ?? 0

        if (angleDeg === 0 || rw === 0 || rh === 0) {
          return sharp(rotatedBuf).jpeg({ quality: 90 }).toBuffer()
        }

        // The rotated canvas dimensions are the original dims rotated; recover the
        // original w×h to feed the inscribed-rect formula. NOTE: true border-aware
        // cropping is a known approximation — this conservative center-crop keeps
        // small angles (the common case) clean without colored wedges.
        const rad = (angleDeg * Math.PI) / 180
        const sinA = Math.abs(Math.sin(rad))
        const cosA = Math.abs(Math.cos(rad))
        const det = cosA * cosA - sinA * sinA
        let ow = rw
        let oh = rh
        if (Math.abs(det) > 1e-6) {
          ow = (rw * cosA - rh * sinA) / det
          oh = (rh * cosA - rw * sinA) / det
        }

        const inscribed = rotatedRectWithMaxArea(ow, oh, rad)
        const cropW = Math.max(1, Math.min(rw, inscribed.width))
        const cropH = Math.max(1, Math.min(rh, inscribed.height))
        const left = Math.max(0, Math.floor((rw - cropW) / 2))
        const top = Math.max(0, Math.floor((rh - cropH) / 2))

        return sharp(rotatedBuf)
          .extract({ left, top, width: cropW, height: cropH })
          .jpeg({ quality: 90 })
          .toBuffer()
      }

      default: {
        throw new Error(`Unknown tool: ${tool as string}`)
      }
    }
  }

  /**
   * Apply a batch of operations in sequence and return the FINAL JPEG buffer.
   *
   * `apply` reads a path and returns an in-memory buffer, so to chain ops we
   * stage each intermediate buffer to a temp file and feed it to the next op.
   * We deliberately do NOT rewrite the 9 ops onto one shared raw buffer — each
   * op already does its own raw decode/encode, and re-encoding between ops keeps
   * this a thin loop over the existing single-op contract (correctness over the
   * marginal JPEG round-trips, which are invisible at quality 90 over 2-6 ops).
   *
   * Callers guard against an empty array (an empty batch is a terminal no-op).
   */
  async applyBatch(inputPath: string, operations: Operation[]): Promise<Buffer> {
    if (operations.length === 0) {
      throw new Error('applyBatch called with an empty operations array')
    }

    const dir = await mkdtemp(join(tmpdir(), 'aie-batch-'))
    try {
      let path = inputPath
      let buf: Buffer = await this.apply(path, operations[0]!)
      for (let i = 1; i < operations.length; i++) {
        // Stage the prior buffer to a temp file so the next op can read a path.
        path = join(dir, `op-${i}.jpg`)
        await writeFile(path, buf)
        buf = await this.apply(path, operations[i]!)
      }
      return buf
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /**
   * Render a full develop config FROM the original, every iteration. Builds the
   * ordered `Operation[]` from the config's NON-IDENTITY fields (canonical order:
   * straighten → crop → exposure → tone → whiteBalance → contrast → vibrance →
   * saturation → look → gradFilter → sharpen), then chains them via `applyBatch`. This is what
   * makes the model non-destructive: "less contrast" re-renders from scratch with
   * a lower contrast, never an inverse op piled on the prior frame.
   *
   * An all-identity config produces a plain re-encode of the original (we must
   * NOT call `applyBatch` with [] — it throws).
   */
  async renderConfig(originalPath: string, config: DevelopConfig): Promise<Buffer> {
    const ops: Operation[] = []

    if (config.straighten !== 0) {
      ops.push({ tool: 'straighten', params: { angleDeg: config.straighten } })
    }
    // Crop immediately after straighten — geometry first, against the leveled frame.
    if (config.cropLeft !== 0 || config.cropTop !== 0 || config.cropWidth !== 1 || config.cropHeight !== 1) {
      ops.push({
        tool: 'crop',
        params: {
          left: config.cropLeft,
          top: config.cropTop,
          width: config.cropWidth,
          height: config.cropHeight
        }
      })
    }
    if (config.exposure !== 0) {
      ops.push({ tool: 'exposure', params: { ev: config.exposure } })
    }
    if (config.highlights !== 0 || config.shadows !== 0) {
      ops.push({ tool: 'tone', params: { highlights: config.highlights, shadows: config.shadows } })
    }
    if (config.temp !== 0 || config.tint !== 0) {
      ops.push({ tool: 'whiteBalance', params: { temp: config.temp, tint: config.tint } })
    }
    if (config.contrast !== 0) {
      ops.push({ tool: 'contrast', params: { amount: config.contrast } })
    }
    if (config.vibrance !== 0) {
      ops.push({ tool: 'vibrance', params: { amount: config.vibrance } })
    }
    if (config.saturation !== 1) {
      ops.push({ tool: 'saturation', params: { amount: config.saturation } })
    }
    if (config.look !== 'none') {
      ops.push({ tool: 'look', params: { name: config.look } })
    }
    // Graduated filter: regional polish over the corrected global base — after
    // all global tonal/color/creative ops, before sharpen. Skip when off.
    if (config.gradEnabled === 1 && config.gradExposure !== 0) {
      ops.push({
        tool: 'gradFilter',
        params: {
          angle: config.gradAngle,
          position: config.gradPosition,
          feather: config.gradFeather,
          exposure: config.gradExposure
        }
      })
    }
    if (config.sharpen !== 0) {
      ops.push({ tool: 'sharpen', params: { amount: config.sharpen } })
    }

    if (ops.length === 0) {
      return sharp(originalPath).jpeg({ quality: 90 }).toBuffer()
    }
    return this.applyBatch(originalPath, ops)
  }
}

/** Singleton used by the agent loop. */
export const executor = new EditExecutor()
