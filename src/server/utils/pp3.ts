// DevelopConfig → RawTherapee PP3 serialization. This is the SINGLE place that
// knows the PP3 format; the agent never sees it.
//
// Every section/key/encoding below is taken from the AUTHORITATIVE reference doc
// `internal_docs/20260617_rawtherapee_sandbox_engine/rawtherapee_pp3_reference.md`
// (round-trip verified against the RawTherapee 5.12 binary). The landmines that
// doc documents and this mapper obeys:
//   - There is NO `[ToneCurve]` section — the tone curve lives in `[Exposure]`.
//   - `[Exposure] Compensation` is in EV STOPS, not a 0..100 slider.
//   - `[Exposure] ShadowCompr` has a NONZERO default of 50 (neutral = 50).
//   - `Enabled=true` is mandatory for `[Vibrance]`, `[Sharpening]`, `[White
//     Balance]` or the op is a silent no-op.
//   - White balance needs `Setting=Custom` to honor an explicit Temperature.
//   - The neon over-saturation bug dies here: "vibrance" maps to `[Vibrance]
//     Pastels` with `ProtectSkins=true`, never to `[Exposure] Saturation`.
// PP3 fails SILENTLY on a wrong key, so do not invent keys — only emit what the
// reference doc verifies.

import type { DevelopConfig } from '~~/shared/types'

/** Round to an int, clamped to [lo, hi]. */
function clampInt(value: number, lo: number, hi: number): number {
  const r = Math.round(value)
  return r < lo ? lo : r > hi ? hi : r
}

/** Normalize a hue to RT's 0..359 integer degrees. */
function normHue(hue: number): number {
  return ((Math.round(hue) % 360) + 360) % 360
}

/** Whether the crop fields describe anything other than the full frame. */
function cropIsIdentity(config: DevelopConfig): boolean {
  return config.cropLeft === 0
    && config.cropTop === 0
    && config.cropWidth === 1
    && config.cropHeight === 1
}

/**
 * Serialize a `DevelopConfig` to a PARTIAL pp3 string — only the sections whose
 * controls are non-identity. RT fills every other section with neutral defaults
 * (partial-pp3 acceptance is verified). The grouping mirrors the executor's 9-op
 * model: tone = highlights+shadows (both in `[Exposure]`), whiteBalance =
 * temp+tint. An all-identity config returns just the `[Version]` header.
 *
 * `dims` (the ORIGINAL image width/height in pixels) is REQUIRED to emit the
 * `[Crop]` section — RT's crop is in pixels. VERIFIED against the 5.12 binary:
 * `[Rotation]` keeps the output at the ORIGINAL dimensions (it scales the rotated
 * content to fit, no wedge), and `[Crop] X/Y/W/H` are in that same original-
 * dimension coordinate space — so normalized crop → original-pixel crop is correct
 * even when straighten is active (RT crops the rotation wedge as part of the crop).
 * When `dims` is omitted and crop is non-identity, the crop is skipped (the caller
 * is responsible for passing dims whenever crop may be active).
 */
export function configToPp3(config: DevelopConfig, dims?: { width: number, height: number }): string {
  const sections: string[] = []

  // The `[Version]` header RT writes on every emitted pp3. Harmless to lead with.
  sections.push('[Version]\nAppVersion=5.12\nVersion=352')

  // --- [Exposure]: compensation, contrast, saturation, highlight/shadow tone ---
  // Exposure has no `Enabled` key — it always applies. We only emit keys that
  // differ from neutral. ShadowCompr's neutral is 50 (not 0).
  const exposureLines: string[] = []

  if (config.exposure !== 0) {
    // Compensation is EV stops directly; the slider is already in stops (-3..3).
    exposureLines.push(`Compensation=${config.exposure}`)
  }
  if (config.contrast !== 0) {
    // contrast -1..1 → RT Contrast -100..100.
    exposureLines.push(`Contrast=${clampInt(config.contrast * 100, -100, 100)}`)
  }
  if (config.saturation !== 1) {
    // saturation is a 0..2 multiplier (1 = none) → RT Saturation -100..100.
    exposureLines.push(`Saturation=${clampInt((config.saturation - 1) * 100, -100, 100)}`)
  }
  if (config.highlights < 0) {
    // Negative highlights = recover/darken highlights → HighlightCompr (0..100,
    // higher = more recovery). HighlightCompr cannot brighten, so positive
    // highlights have no single-key RT equivalent here (parametric curve, Sprint 3).
    exposureLines.push(`HighlightCompr=${clampInt(-config.highlights, 0, 100)}`)
  }
  if (config.shadows !== 0) {
    // shadows -100..100; ShadowCompr neutral is 50. Positive shadows lift, so
    // pivot around 50: shadows +100 → 100 (full lift), -100 → 0.
    exposureLines.push(`ShadowCompr=${clampInt(50 + config.shadows / 2, 0, 100)}`)
  }
  // Parametric tone curve → `Curve=2;x_a;x_b;x_c;<highlights>;<lights>;<darks>;<shadows>;`.
  // Type 2 = parametric, 3 x-pivots then 4 region weights. The SLOT ORDER is
  // highlights-first (verified against the 5.12 binary by single-slider renders:
  // slot 4 moved highlights, slot 5 upper-mids, slot 6 lower-mids, slot 7
  // shadows; positive = brightens that zone). This corrects the reference doc's
  // earlier inferred shadows-first guess. Each weight is already -100..100.
  if (config.tcHighlights !== 0 || config.tcLights !== 0 || config.tcDarks !== 0 || config.tcShadows !== 0) {
    const h = clampInt(config.tcHighlights, -100, 100)
    const l = clampInt(config.tcLights, -100, 100)
    const d = clampInt(config.tcDarks, -100, 100)
    const s = clampInt(config.tcShadows, -100, 100)
    exposureLines.push('CurveMode=Standard')
    exposureLines.push(`Curve=2;0.25;0.5;0.75;${h};${l};${d};${s};`)
  }
  if (exposureLines.length > 0) {
    sections.push(`[Exposure]\n${exposureLines.join('\n')}`)
  }

  // --- [White Balance]: temp (Kelvin) + tint (Green axis) ----------------------
  // Setting=Custom is required for RT to honor an explicit Temperature instead of
  // falling back to camera WB; Enabled=true is mandatory.
  if (config.temp !== 0 || config.tint !== 0) {
    const wbLines: string[] = ['Enabled=true', 'Setting=Custom']
    if (config.temp !== 0) {
      // temp -100..100 around the 6504K neutral; ±100 → ±3000K (≈3500..9500K).
      wbLines.push(`Temperature=${clampInt(6504 + config.temp * 30, 1500, 12000)}`)
    }
    if (config.tint !== 0) {
      // tint -100..100 → Green multiplier (neutral 1). Positive = magenta axis.
      const green = 1 + (config.tint / 100) * 0.4
      wbLines.push(`Green=${Number(green.toFixed(4))}`)
    }
    sections.push(`[White Balance]\n${wbLines.join('\n')}`)
  }

  // --- [Vibrance]: skin-safe saturation (kills the neon bug) -------------------
  if (config.vibrance !== 0) {
    const pastels = clampInt(config.vibrance * 100, -100, 100)
    sections.push(
      `[Vibrance]\nEnabled=true\nPastels=${pastels}\nSaturated=${clampInt(config.vibrance * 50, -100, 100)}\nProtectSkins=true`
    )
  }

  // --- [Sharpening]: output sharpening -----------------------------------------
  if (config.sharpen !== 0) {
    // sharpen 0..1 → unsharp Amount (RT default 200). Enabled is mandatory.
    sections.push(
      `[Sharpening]\nEnabled=true\nMethod=usm\nAmount=${clampInt(config.sharpen * 200, 0, 1000)}`
    )
  }

  // --- [ColorToning]: split-tone (cinematic teal/orange grade) -----------------
  // Method=Splitco — RT's classic split-toning. Each zone is a `Saturation;Hue;`
  // pair (`ShadowsColorSaturation` / `HighlightsColorSaturation`), Hue in 0..359
  // degrees, Saturation 0..100. `Autosat=false` is MANDATORY: with autosat on RT
  // ignores the explicit saturations.
  //
  // WHY NOT RGBSliders (the prior mapping): `Method=RGBSliders` requires the
  // GUI-authored `OpacityCurve`/`ColorCurve` keys. Emitting it as a partial
  // section WITHOUT those curves made RT fall back to a broken default curve that
  // tinted the ENTIRE image a violent neon green even with all RGB channels at 0
  // (reproduced against the 5.12 binary). Splitco needs no curves and tints
  // cleanly in the requested hue direction — it's the safe path for partial pp3.
  // Tradeoff (documented): Splitco's effect is gentle on low-contrast scenes; we
  // accept a subtle-but-correct grade over a catastrophic one.
  if (config.splitShadowSat > 0 || config.splitHighlightSat > 0) {
    const ctLines: string[] = ['Enabled=true', 'Method=Splitco', 'Autosat=false', 'Strength=80']
    if (config.splitShadowSat > 0) {
      ctLines.push(`ShadowsColorSaturation=${clampInt(config.splitShadowSat, 0, 100)};${normHue(config.splitShadowHue)};`)
    }
    if (config.splitHighlightSat > 0) {
      ctLines.push(`HighlightsColorSaturation=${clampInt(config.splitHighlightSat, 0, 100)};${normHue(config.splitHighlightHue)};`)
    }
    if (config.splitBalance !== 0) {
      ctLines.push(`Balance=${clampInt(config.splitBalance, -100, 100)}`)
    }
    sections.push(`[ColorToning]\n${ctLines.join('\n')}`)
  }

  // --- [Dehaze]: cut atmospheric haze, add clarity -----------------------------
  // Strength int (RT default 50); Depth left at its default 25. Verified to
  // deepen the veil + raise local detail in the expected direction.
  if (config.dehaze > 0) {
    sections.push(
      `[Dehaze]\nEnabled=true\nStrength=${clampInt(config.dehaze, 0, 100)}\nDepth=25`
    )
  }

  // --- [Directional Pyramid Denoising]: noise reduction ------------------------
  // Luma + Chroma ints (RT's Chroma default is 15 even when the section is
  // disabled — we only emit when the agent explicitly asks, so we write our own
  // values). Method=Lab. Verified to smooth high-frequency grain.
  if (config.nrLuminance > 0 || config.nrChroma > 0) {
    sections.push(
      `[Directional Pyramid Denoising]\nEnabled=true\nMethod=Lab\nLuma=${clampInt(config.nrLuminance, 0, 100)}\nChroma=${clampInt(config.nrChroma, 0, 100)}`
    )
  }

  // --- [Gradient]: one linear graduated (ND) exposure filter -------------------
  // VERIFIED keys (Sprint 3.0 spike, reference doc §9): `Enabled, Degree, Feather,
  // Strength, CenterX, CenterY`. The section is `[Gradient]` (NOT `[Graduated
  // Filter]`, which is silently ignored); casing is `CenterX`/`CenterY`.
  //   - Degree: -180..180. RT 0 = effect on the TOP half. Our gradAngle (0..360,
  //     0 = darken top) maps via Degree = ((gradAngle + 180) % 360) - 180.
  //   - Strength: EV stops, -5..5. RT POSITIVE darkens the targeted side; our
  //     gradExposure NEGATIVE darkens (photographer convention) → Strength =
  //     -gradExposure (verified: gradExposure -2 → Strength +2 → sky darkens).
  //   - Feather: 0..100 directly.
  //   - CenterX/Y: -100..100 % offset of the transition from frame center along
  //     the gradient direction. position 0.5 = centered (offset 0); offsetMag =
  //     (0.5 - gradPosition) * 200, projected onto the gradient axis. At gradAngle
  //     0 (Degree 0, vertical split) this rides CenterY; the sign is set so a
  //     lower position pushes the transition toward the top (shrinking the band).
  // Always emit Enabled=true; skip the whole section when off or no effect.
  if (config.gradEnabled === 1 && config.gradExposure !== 0) {
    const degree = clampInt(((config.gradAngle + 180) % 360) - 180, -180, 180)
    const strength = Number((-config.gradExposure).toFixed(4))
    const feather = clampInt(config.gradFeather, 0, 100)
    // Offset magnitude along the gradient axis; rotate by the gradient angle so
    // the transition moves perpendicular to the gradient line in the general case.
    const offsetMag = (0.5 - config.gradPosition) * 200
    const rad = (config.gradAngle * Math.PI) / 180
    const centerX = clampInt(offsetMag * Math.sin(rad), -100, 100)
    const centerY = clampInt(offsetMag * Math.cos(rad), -100, 100)
    sections.push(
      `[Gradient]\nEnabled=true\nDegree=${degree}\nFeather=${feather}\nStrength=${strength}\nCenterX=${centerX}\nCenterY=${centerY}`
    )
  }

  // --- [Rotation]: straighten --------------------------------------------------
  // Rotation has no Enabled key. RT auto-crops the wedge when Crop is enabled; we
  // leave crop to RT's default behavior at the current field count.
  if (config.straighten !== 0) {
    sections.push(`[Rotation]\nDegree=${config.straighten}`)
  }

  // --- [Crop]: composition / aspect crop ---------------------------------------
  // Verified keys: `Enabled, X, Y, W, H` (pixels). Normalized 0..1 → original-
  // dimension pixels (see the `dims` note above: RT's rotated output stays at the
  // original WxH, so crop coords map against the original dims even when straighten
  // is active). Skip entirely when identity or when dims are unavailable.
  if (!cropIsIdentity(config) && dims && dims.width > 0 && dims.height > 0) {
    const x = clampInt(config.cropLeft * dims.width, 0, dims.width - 1)
    const y = clampInt(config.cropTop * dims.height, 0, dims.height - 1)
    const w = clampInt(config.cropWidth * dims.width, 1, dims.width - x)
    const h = clampInt(config.cropHeight * dims.height, 1, dims.height - y)
    sections.push(`[Crop]\nEnabled=true\nX=${x}\nY=${y}\nW=${w}\nH=${h}`)
  }

  return `${sections.join('\n\n')}\n`
}
