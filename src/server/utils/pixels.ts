// Pure raw-buffer pixel-math helpers shared by the executor's tonal/color ops.
//
// Everything here operates on Sharp's interleaved RAW buffers: a flat array of
// bytes with `channels` per pixel (3 = RGB, 4 = RGBA). Helpers mutate the buffer
// in place (cheap, no reallocation) and never touch the alpha channel so masks
// survive. Keep these dependency-free and side-effect-only on the passed buffer.

/** Rec.709 relative luminance from 0..255 channels, returned normalized 0..1. */
export function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/** Clamp to a valid 0..255 byte. */
export function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

/** Standard logistic sigmoid. */
export function sigmoid(t: number): number {
  return 1 / (1 + Math.exp(-t))
}

/** Hermite smoothstep: 0 below `edge0`, 1 above `edge1`, smooth in between. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) {
    return x < edge0 ? 0 : 1
  }
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Apply a 256-entry lookup table to the R,G,B channels of a raw buffer in place.
 * The LUT maps each 0..255 input byte to a 0..255 output byte. Alpha untouched.
 */
export function applyChannelLut(
  data: Buffer,
  channels: number,
  lut: Uint8ClampedArray
): void {
  for (let i = 0; i < data.length; i += channels) {
    data[i] = lut[data[i]!]!
    data[i + 1] = lut[data[i + 1]!]!
    data[i + 2] = lut[data[i + 2]!]!
  }
}

/**
 * Build a 256-entry sigmoidal contrast LUT.
 *
 * `amount` in -1..1. Positive = steeper S-curve about mid-gray (more contrast);
 * negative = the inverse curve (genuinely flatter). Mapping:
 *   alpha = |amount| * 8   (so +1 → a strong S-curve, slope ~ tunable by 8)
 * For amount > 0 we use the normalized sigmoid:
 *   f(x) = (sig(a(x-.5)) - sig(-a/2)) / (sig(a/2) - sig(-a/2))
 * For amount < 0 we invert that same curve (x → f^-1), which reduces contrast.
 * amount = 0 → identity.
 */
export function buildSigmoidalLut(amount: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256)
  const a = Math.min(1, Math.abs(amount)) * 8

  if (a < 1e-6) {
    for (let i = 0; i < 256; i++) {
      lut[i] = i
    }
    return lut
  }

  const lo = sigmoid(-a / 2)
  const hi = sigmoid(a / 2)
  const span = hi - lo

  if (amount > 0) {
    for (let i = 0; i < 256; i++) {
      const x = i / 255
      const f = (sigmoid(a * (x - 0.5)) - lo) / span
      lut[i] = clamp255(Math.round(f * 255))
    }
  } else {
    // Inverse sigmoid: invert y = (sig(a(x-.5)) - lo)/span for x given input y.
    // x = 0.5 + (1/a) * logit(y*span + lo), logit(p) = ln(p/(1-p)).
    for (let i = 0; i < 256; i++) {
      const y = i / 255
      const p = Math.min(1 - 1e-6, Math.max(1e-6, y * span + lo))
      const x = 0.5 + (1 / a) * Math.log(p / (1 - p))
      lut[i] = clamp255(Math.round(x * 255))
    }
  }

  return lut
}

/**
 * Independent highlight/shadow adjustment, luminance-masked, in place.
 *
 * `highlights` and `shadows` each -100..100. Per pixel we compute luminance L
 * (0..1), a highlight weight (smoothstep rising toward L=1) and a shadow weight
 * (rising toward L=0), then add a scaled delta to each RGB channel so hue is
 * preserved. Scaling: ±100 → up to ±~90 byte shift at the masked extreme, which
 * is strong but non-destructive thanks to the soft weights.
 */
export function applyTone(
  data: Buffer,
  channels: number,
  highlights: number,
  shadows: number
): void {
  const hAmt = Math.max(-100, Math.min(100, highlights)) / 100
  const sAmt = Math.max(-100, Math.min(100, shadows)) / 100
  const SCALE = 90 // max byte shift at full mask + full amount

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i]!
    const g = data[i + 1]!
    const b = data[i + 2]!
    const L = luminance(r, g, b)

    // Soft weights: highlights act in the bright zone, shadows in the dark zone.
    const wH = smoothstep(0.4, 1.0, L)
    const wS = smoothstep(0.6, 0.0, L) // 1 at L=0, 0 at L>=0.6

    const delta = (hAmt * wH + sAmt * wS) * SCALE
    data[i] = clamp255(r + delta)
    data[i + 1] = clamp255(g + delta)
    data[i + 2] = clamp255(b + delta)
  }
}

/**
 * Per-channel white-balance gain in place.
 *
 * `temp` -100..100: positive = warmer (boost R, cut B); negative = cooler.
 * `tint` -100..100: positive = magenta (boost R+B, cut G); negative = green.
 * Gains stay near 1.0 (±~30% at the extreme) and are luminance-normalized so a
 * warm push doesn't also brighten the frame.
 */
export function applyWhiteBalance(
  data: Buffer,
  channels: number,
  temp: number,
  tint: number
): void {
  const t = Math.max(-100, Math.min(100, temp)) / 100
  const ti = Math.max(-100, Math.min(100, tint)) / 100
  const STRENGTH = 0.3 // max ±30% channel gain

  let gR = 1 + t * STRENGTH + ti * STRENGTH * 0.5
  let gG = 1 - ti * STRENGTH
  let gB = 1 - t * STRENGTH + ti * STRENGTH * 0.5

  // Normalize so the luminance-weighted average gain stays ~1 (preserve exposure).
  const avg = 0.2126 * gR + 0.7152 * gG + 0.0722 * gB
  if (avg > 1e-6) {
    gR /= avg
    gG /= avg
    gB /= avg
  }

  for (let i = 0; i < data.length; i += channels) {
    data[i] = clamp255(data[i]! * gR)
    data[i + 1] = clamp255(data[i + 1]! * gG)
    data[i + 2] = clamp255(data[i + 2]! * gB)
  }
}

/** RGB (0..255) → HSL, all components returned 0..1. */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  const d = max - min
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === rn) {
      h = (gn - bn) / d + (gn < bn ? 6 : 0)
    } else if (max === gn) {
      h = (bn - rn) / d + 2
    } else {
      h = (rn - gn) / d + 4
    }
    h /= 6
  }
  return [h, s, l]
}

/** HSL (all 0..1) → RGB (0..255). */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s < 1e-6) {
    const v = clamp255(l * 255)
    return [v, v, v]
  }
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [
    clamp255(hue2rgb(p, q, h + 1 / 3) * 255),
    clamp255(hue2rgb(p, q, h) * 255),
    clamp255(hue2rgb(p, q, h - 1 / 3) * 255)
  ]
}

/**
 * Smart "vibrance" saturation in place.
 *
 * `amount` -1..1. The push per pixel is `amount * s * (1 - s)`: it scales with
 * existing saturation `s` so genuine NEUTRALS stay neutral (no manufactured
 * color), peaks for muted mid-saturation colors, and tapers off as `(1 - s)` for
 * already-vivid pixels so they barely move. Hue and lightness are held fixed.
 * amount < 0 desaturates. (NB: the earlier `amount * (1 - s)` form boosted
 * low-saturation pixels the MOST — it shoved every faintly-tinted gray to ~0.45
 * saturation at amount 0.45, turning skies/buildings psychedelic neon.)
 */
export function applyVibrance(data: Buffer, channels: number, amount: number): void {
  const amt = Math.max(-1, Math.min(1, amount))
  for (let i = 0; i < data.length; i += channels) {
    const [h, s, l] = rgbToHsl(data[i]!, data[i + 1]!, data[i + 2]!)
    const newS = Math.max(0, Math.min(1, s + amt * s * (1 - s)))
    const [r, g, b] = hslToRgb(h, newS, l)
    data[i] = r
    data[i + 1] = g
    data[i + 2] = b
  }
}

/** Fully desaturate a raw buffer in place using Rec.709 luma. */
export function applyGrayscale(data: Buffer, channels: number): void {
  for (let i = 0; i < data.length; i += channels) {
    const y = clamp255(0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!)
    data[i] = y
    data[i + 1] = y
    data[i + 2] = y
  }
}
