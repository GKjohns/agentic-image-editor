# RawTherapee PP3 Processing-Profile Reference (AUTHORITATIVE)

**Task 1.0 — the critical gate.** Every section/key/encoding below is marked ✅ (round-trip
verified against the RawTherapee 5.12 binary on a real render) or ⚠️ (inferred / not
binary-verified). `configToPp3()` must be written from this doc. PP3 fails **silently** on
wrong keys: a misspelled section or key is simply ignored, the op does nothing, and no error
is raised. Treat every ⚠️ as a landmine.

- RT version under test: **5.12**, pp3 header `AppVersion=5.12`, `Version=352`.
- Method: render a sample JPEG, use `-O` to copy the **fully-expanded** pp3 RT actually used
  (every section + every default filled) next to the output, then diff/round-trip hand-written
  partial pp3s through it. Curve-type enum cross-checked against RT source `diagonalcurvetypes.h`.
- Evidence artifacts were produced in a scratch dir (`/tmp/rt_work`); none committed except this doc.

---

## 1. The working `rawtherapee-cli` invocation

### Binary path
- **Dev (macOS, this machine):** `/Applications/RawTherapee.app/Contents/MacOS/rawtherapee-cli`
- **Prod sandbox (Linux):** will be a normal `rawtherapee-cli` on `$PATH` (e.g. the
  AppImage's `usr/bin/rawtherapee-cli`, or the `rawtherapee` Debian package's CLI).
  The macOS gotcha below does **not** apply on Linux.

### ⚠️ macOS-only gotcha (DEV ONLY — does not affect prod)
The bundled CLI is signed with `com.apple.security.app-sandbox = true`. When invoked directly
by path (outside LaunchServices), it **crashes in `_libsecinit_appsandbox` before `main()`**
with `SIGTRAP` (exit 133), because it cannot resolve its sandbox container bundle id. The
DiagnosticReport signature is:
`Unable to get bundle identifier for container id com.rawtherapee.RawTherapee`.

Dev workaround that makes it runnable from a plain shell (one-time): copy the binary out and
ad-hoc re-sign it with no entitlements (drops the sandbox requirement; the binary already has a
read-write exception for `/`):
```bash
cp /Applications/RawTherapee.app/Contents/MacOS/rawtherapee-cli /tmp/rt/rawtherapee-cli
xattr -c /tmp/rt/rawtherapee-cli
codesign --remove-signature /tmp/rt/rawtherapee-cli
codesign -s - --force /tmp/rt/rawtherapee-cli
/tmp/rt/rawtherapee-cli --version   # -> "RawTherapee, version 5.12, command line."
```
The production engine will run on Linux and not hit this.

### ✅ Verified render command (full flag list, input LAST)
```bash
rawtherapee-cli -O <outfile_or_dir> -p <profile.pp3> -q -j90 -Y -c <input.jpg>
```
Flag meanings (verified against `-h`):
| Flag | Meaning |
|------|---------|
| `-c <input>` | input file(s)/folder. **MUST be the last option.** |
| `-o <out>` | output file or dir (no pp3 copied) |
| `-O <out>` | output file or dir **and copy the used pp3 next to it** (this is how we capture the fully-expanded pp3 — use for debugging, `-o` for prod) |
| `-p <file.pp3>` | apply a profile. Repeatable; each `-p` is built on top of the previous one (later overrides earlier). |
| `-q` | quick-start (skip cache load) |
| `-j[1-100]` | JPEG output, quality N (so `-j90` = JPEG q90). Default is JPEG q92 if no `-t`/`-n`. |
| `-Y` | overwrite output if present |
| `-d` | use the default profile from Preferences (we do NOT use this; we pass full control via `-p`) |
| `-s` / `-S` | use a sidecar `<input>.pp3` (not used by the engine) |

When `-O outfile.jpg` is a filename, RT writes the expanded profile as `outfile.jpg.pp3`
(sidecar naming, not `outfile.pp3`).

**Stdout on success** contains `Processing: <input>` and, when a `-p` is merged,
`Merging procparams #0`. Exit code `0` = success. There is **no nonzero exit / no stderr** when
a key is wrong — silent.

---

## 2. ✅ Partial-pp3 behavior (the engine relies on this)

`-h` states it and a render confirms it: **pp3 files can be incomplete.** RT builds the final
params as: (1) neutral defaults, (2) optional `-d` default profile, (3) each `-p` profile in
order, (4) optional sidecar. So the engine can emit **only the sections it changes** and RT
fills the rest with neutral defaults.

Verified: a literal 3-line file
```
[Exposure]
Compensation=1.5
Contrast=25
```
rendered cleanly (exit 0, brighter output), and the emitted expanded pp3 showed
`Compensation=1.5` with every other key defaulted. ✅

**Required for any op to take effect:** the section's `Enabled=true` (where the section has an
`Enabled` key) — and for white balance, `Setting` matters (see gotchas). Forgetting `Enabled`
is the #1 silent no-op.

---

## 3. ✅ Curve= encoding

A `Curve=` value is: `<type>;<v1>;<v2>;...;` — a leading **integer curve type**, then a
type-specific list of doubles, semicolon-separated, trailing semicolon. Doubles are written at
full precision (e.g. `0.34999999999999998`). `Curve=0;` means "no curve / linear".

### ✅ Curve-type integer mapping
Confirmed against RT source `rtengine/diagonalcurvetypes.h` (enum `DiagonalCurveType`) AND by
round-tripping each type through the binary:

| Int | Type | Value layout after the type int |
|-----|------|----------------------------------|
| `-1` | Empty | (none) |
| `0` | Linear / none | (none) — `Curve=0;` |
| `1` | Spline (a.k.a. "Custom") | `x1;y1;x2;y2;...` control points, spline-interpolated |
| `2` | **Parametric** | `x_a;x_b;x_c;shadows;darks;lights;highlights` (see §7) |
| `3` | NURBS ("control points" / flexible) | `x1;y1;x2;y2;...` control points |
| `4` | CatmullRom | `x1;y1;x2;y2;...` |
| `5` | Unchanged | (sentinel) |

The tone curve in `[Exposure]` uses `Curve=` (primary) and `Curve2=` (secondary), each with a
companion `CurveMode` / `CurveMode2` (values seen: `Standard`, `FilmLike`,
`SatAndValueBlending`, `WeightedStd`, `Luminance`, `Perceptual`).

### ✅ Real emitted example lines (copied verbatim from bundled `Pop 1.pp3`)
```
CurveMode=FilmLike
Curve=3;0;0;0.084000000000000005;0;0.187;0.188;0.442;0.57999999999999996;1;1;
```
That is a type-3 (control-point) curve with points (0,0) (0.084,0) (0.187,0.188) (0.442,0.58)
(1,1). And from `Standard Film Curve - ISO Low.pp3`, a type-1 (spline) tone curve:
```
Curve=1;0;0;0.11;0.089999999999999997;0.32000000000000001;0.42999999999999999;0.66000000000000003;0.87;1;1;
```

---

## 4. ✅ VERIFIED PP3 mapping for the current 9-op DevelopConfig

Each semantic control → `[Section] Key = value`. ✅ = section+key seen in the binary's emitted
pp3 and/or round-tripped through a render.

| # | Semantic control (DevelopConfig) | PP3 section | Key | Value / range / encoding | Status |
|---|----------------------------------|-------------|-----|--------------------------|--------|
| 1 | **straighten** (angleDeg) | `[Rotation]` | `Degree` | float degrees, e.g. `2.5`. Default `0`. Range approx ±45. | ✅ |
| 2 | **exposure** (EV stops) | `[Exposure]` | `Compensation` | EV stops as float, e.g. `1.5` = +1.5 EV. Default `0`. RT range ≈ −5..+12. Requires nothing else (Exposure has no `Enabled`; `Auto=false`). | ✅ |
| 3a | **highlights** (tone) | `[Exposure]` | `HighlightCompr` | int, default `0`. Higher = more highlight compression (recover/darken highlights). Pop profiles use `70`. Pair with `HighlightComprThreshold` (default 0). | ✅ |
| 3b | **shadows** (tone) | `[Exposure]` | `ShadowCompr` | int, **default is `50`, not 0** — lifts shadows. Raise to lift more. ⚠️ note the nonzero default when scaling. | ✅ |
| 4a | **temp** (white balance) | `[White Balance]` | `Temperature` | Kelvin int, e.g. `6504`. Default `6504`. Higher = warmer. | ✅ |
| 4b | **tint** (white balance) | `[White Balance]` | `Green` | float multiplier, default `1`. >1 = more magenta-ish / green tint axis. **Plan's "tint→Green" mapping is correct.** | ✅ |
| — | white balance enable | `[White Balance]` | `Enabled` / `Setting` | `Enabled=true`. **`Setting` defaults to `Camera`; to honor an explicit Temperature you must set `Setting=Custom`** (see gotchas). | ✅ |
| 5 | **contrast** | `[Exposure]` | `Contrast` | int, default `0`. Range −100..+100. | ✅ |
| 6 | **vibrance** (skin-safe) | `[Vibrance]` | `Pastels` (+ `Saturated`) | ints, default `0`. Range −100..+100. Needs `Enabled=true`. | ✅ |
| 6b | **vibrance skin protect** | `[Vibrance]` | `ProtectSkins` | **bool** `true`/`false`, default `false`. THIS is the skin-safe toggle that prevents the neon over-saturation bug. Also `AvoidColorShift` (bool, default `true`) and `PSThreshold=0;75;` (two ints) tune the protected hue band. | ✅ |
| 7 | **saturation** | `[Exposure]` | `Saturation` | int, default `0`, range −100..+100. (Also exists as HSV/Lab paths, but the simple global saturation lives in `[Exposure]`.) | ✅ |
| 8 | **look** | (varies) | — | A "look" = a preset bundle of the above (tone curve + WB + vibrance etc.), implemented by emitting multiple sections, mirroring the bundled `Pop N.pp3`. No single key. | ⚠️ (design choice) |
| 9 | **sharpen** | `[Sharpening]` | `Enabled` + `Amount` | `Enabled=true`; `Method=usm` (default) with `Amount` int (default `200`) and `Radius` (default `0.5`); or `Method=rld`. For raw, `[PostDemosaicSharpening]` exists separately — for JPEG input use `[Sharpening]`. | ✅ |

### ⚠️ Plan-named keys that were WRONG / need correction
- **`[ToneCurve]` does NOT exist.** There is no `[ToneCurve]` section anywhere in the emitted
  pp3. The tone curve lives in **`[Exposure]` → `Curve=` / `Curve2=`** (with
  `CurveMode`/`CurveMode2`). Any plan reference to a `[ToneCurve]` section must be rewritten to
  `[Exposure]`.
- The plan listed `Compensation`, `Contrast`, `HighlightCompr`, `ShadowCompr` under
  `[Exposure]` — **all four confirmed correct** ✅. Just note `ShadowCompr` default is `50`.
- `[White Balance]` `Temperature` and `Green` — **both correct** ✅ (but see `Setting=Custom`).
- `[Vibrance] ProtectSkins` — **correct** ✅ (it is exactly `ProtectSkins`, a bool). The real
  companion keys are `AvoidColorShift` (bool) and `PSThreshold` (two-int range), NOT a scalar
  "PSThreshold" the plan was unsure about.
- `[Rotation] Degree` — **correct** ✅.
- `[Crop]` — keys are `Enabled`, `X`, `Y`, `W`, `H`, `FixedRatio`, `Ratio`, `Orientation`,
  `Guide`. (`X=-1 Y=-1` means auto.) ✅

---

## 5. Real emitted-pp3 excerpts (evidence)

### Header + the controls that matter (from the binary's expanded default render)
```
[Version]
AppVersion=5.12
Version=352

[Exposure]
Auto=false
Clip=0.02
Compensation=0
Brightness=0
Contrast=0
Saturation=0
Black=0
HighlightCompr=0
HighlightComprThreshold=0
ShadowCompr=50
...
CurveMode=Standard
CurveMode2=Standard
Curve=0;
Curve2=0;

[Vibrance]
Enabled=false
Pastels=0
Saturated=0
PSThreshold=0;75;
ProtectSkins=false
AvoidColorShift=true
PastSatTog=true
SkinTonesCurve=0;

[White Balance]
Enabled=true
Setting=Camera
Temperature=6504
Green=1
...

[Rotation]
Degree=0

[Crop]
Enabled=false
X=-1
Y=-1
W=15000
H=15000
FixedRatio=true
Ratio=As Image
Orientation=As Image
```

### A hand-written partial pp3 that rendered and round-tripped a parametric curve
Input `Curve=2;0.25;0.5;0.75;25;15;-15;-25;` was re-emitted byte-identical, and a strong
variant produced a visibly different output (different md5, +6KB JPEG) — proving the parametric
curve is honored, not silently dropped.

---

## 6. ✅/⚠️ Forward-looking (Sprint 3) encodings

| Feature | Section | Keys | Encoding | Status |
|---------|---------|------|----------|--------|
| **Parametric tone curve** | `[Exposure]` | `Curve=` (`CurveMode` companion) | `2;x_a;x_b;x_c;highlights;lights;darks;shadows;` — type `2`, three x-pivots (defaults `0.25;0.5;0.75`) then 4 slider weights in **highlights→lights→darks→shadows** order. Round-tripped byte-exact AND confirmed to change pixels. | ✅ **slider order verified (Sprint 3)** — single-slider renders on the 5.12 binary: weight slot 4 moved the highlights (+8 in highlight bin, 0 in shadows), slot 5 the upper-mids (+35 highmid), slot 6 the lower-mids (+39 lowmid), slot 7 the shadows (+15 shadow bin, 0 highlights). So it is **highlights-FIRST**, NOT the earlier shadows-first guess. Positive weight = brightens that zone. Proof: `verification/screenshots/sprint3_tonecurve_shadows.jpg` (slot-7 shadows +80). |
| **Color toning / split-tone** | `[ColorToning]` | `Enabled`, `Method`, `Autosat`, then per-zone keys | **SHIPPED:** `Method=Splitco` with `Autosat=false` (mandatory — with autosat on, RT ignores the explicit saturations) and a `Saturation;Hue;` pair per zone: `ShadowsColorSaturation=<sat>;<hue>;` and `HighlightsColorSaturation=<sat>;<hue>;` (sat `0..100`, hue `0..359°`), plus optional `Balance` int and `Strength` int. | ✅ **verified (Sprint 4 fix)** — the mapper emits exactly `Enabled=true`, `Method=Splitco`, `Autosat=false`, `Strength=80`, `ShadowsColorSaturation=<sat>;<hue>;`, `HighlightsColorSaturation=<sat>;<hue>;`. A cinematic config (teal shadows hue 210 / warm highlights hue 40) tints cleanly in the requested directions: shadows go bluer (mean B 94.7→109.6) while highlights keep a warm red lean, channel order stays natural (R>G). ⚠️ **`Method=RGBSliders` was REJECTED:** emitted as a partial PP3 it requires GUI-authored `OpacityCurve`/`ColorCurve` keys; without them RT falls back to a broken default curve that tints the ENTIRE image a violent neon green even with all RGB channels at 0 (reproduced against the binary). Splitco needs no curves. Proof: `verification/screenshots/sprint3_splittone_cinematic.jpg` (regenerated with the Splitco mapper). |
| **Dehaze** | `[Dehaze]` | `Enabled`, `Strength`, `Depth`, `Saturation`, `ShowDepthMap` | `Enabled=true`; `Strength` int (default `50`), `Depth` int (default `25`), `Saturation` int (default `50`). | ✅ **verified (Sprint 3)** — `Strength=80` deepened mean luminance 117.4→102.1 (cuts the haze veil) and raised local high-frequency detail 1.32→1.43 (clarity), the expected direction. Mapper emits `Strength=<dehaze>` + `Depth=25`. Proof: `verification/screenshots/sprint3_dehaze.jpg`. |
| **Denoise** | `[Directional Pyramid Denoising]` | `Enabled`, `Luma`, `Ldetail`, `Chroma`, `Method`, ... | `Enabled=true`; `Luma` int (default `0`), `Chroma` int (**default `15`**), `Method=Lab`. | ✅ **verified (Sprint 3)** — `Luma=80 Chroma=80` cut local high-frequency energy 1.32→0.87 (≈34% smoother), confirming visible noise reduction. Note `Chroma` defaults to 15 even when the section is disabled, so the mapper only emits the section when the agent explicitly asks (writes its own Luma/Chroma). Proof: `verification/screenshots/sprint3_noise_reduction.jpg`. |
| **Linear graduated (ND) filter** | **`[Gradient]`** | `Enabled`, `Degree`, `Feather`, `Strength`, `CenterX`, `CenterY` | See §9 — the verified block. | ✅ **VERIFIED EMPIRICALLY (Sprint 3.0 spike)** — section name is **`[Gradient]`, NOT `[Graduated Filter]`** (the plan's guess was wrong); key casing is **`CenterX`/`CenterY`** (not `Centerx`). `Strength=+3, Degree=0` darkened the top/sky half (mean L 192→76) while holding the bottom; `Enabled=false` is a byte-for-byte no-op vs baseline. All keys round-trip exactly. Proof: `verification/screenshots/sprint3_spike_grad_*.jpg`. |

---

## 9. ✅ VERIFIED `[Gradient]` (linear graduated / ND filter) — Sprint 3.0 spike

**VERDICT: PASS.** Pixel-graded and round-tripped against the RT 5.12 binary
(`~/.local/bin/rawtherapee-cli`, de-sandboxed copy) on sample `granite-dome-vista.jpg`
(bright sky over a dark granite dome — clear horizon).

> ⚠️ **The section is `[Gradient]`, NOT `[Graduated Filter]`.** A profile written with
> `[Graduated Filter]` is silently ignored (the wrong-section landmine). Key casing is
> **`CenterX` / `CenterY`** (capital X/Y), not `Centerx`/`Centery`.

### Keys, ranges, semantics (✅ all verified empirically; ranges cross-checked vs RT 5.12 source `rtgui/gradient.cc`)

| Key | Type | Default | Range | Semantics (verified) |
|-----|------|---------|-------|----------------------|
| `Enabled` | bool | `false` | — | Must be `true` or the whole section is a no-op (verified: `Enabled=false` produced a byte-identical render to baseline). |
| `Degree` | int (°) | `0` | `-180 .. 180` | Angle of the gradient line. **`0` = horizontal split, the effect applied to the TOP half** (sky). `180` flips it to the BOTTOM half. `90` rotates to a vertical split (effect on the LEFT half). Verified: deg0 darkens top, deg180 darkens bottom, deg90 darkens left. |
| `Feather` | int (%) | `25` | `0 .. 100` | Transition softness. `0` = hard line (verified: sharp boundary, top fully affected / bottom untouched). `100` = very soft, nearly full-frame blend. Higher = smoother, no banding. |
| `Strength` | float (**EV stops**) | `0` | `-5 .. 5` | The ND/exposure effect. **Positive DARKENS the affected (default top) side; negative BRIGHTENS it.** Verified: `+3` top 192→76 (darken sky), `-3` top 192→237 (brighten). Written/round-tripped at full f64 precision but plain `-3`/`3` accepted. `0` = no effect. |
| `CenterX` | int (%) | `0` | `-100 .. 100` | Horizontal offset of the gradient center from frame center, as % of half-width. Verified at deg90: `CenterX=-50` shifted the dark region left (left 100 / right 150). |
| `CenterY` | int (%) | `0` | `-100 .. 100` | Vertical offset of the gradient center from frame center. Verified at deg0: negative moves the transition toward the top (shrinks the darkened region); positive moves it down. |

### ✅ Verified example block — "darken the bright sky, hold the foreground"
```
[Gradient]
Enabled=true
Degree=0
Feather=25
Strength=3
CenterX=0
CenterY=0
```
Renders the top (sky) ~1.5 stops darker with a smooth 25% feathered transition and leaves the
foreground untouched. To darken the *bottom* instead, use `Degree=180`. To brighten the
foreground, use a negative `Strength` (and `Degree=180` to target the lower half).

### Mapper guidance (Sprint 3.4)
- `gradAngle` → `Degree` (degrees, -180..180; default 0 = darken sky).
- `gradExposure` → `Strength` (EV stops, -5..+5; **positive darkens** the targeted side). Map the
  UI/agent "strength" so identity/0 disables the section (skip emitting `[Gradient]` when 0).
- `gradFeather` → `Feather` (0..100).
- `gradPosition` → `CenterY` (and/or `CenterX`) (-100..100).
- Always emit `Enabled=true` when the section is written. Skip the whole section when off.

### Evidence (all in `internal_docs/20260620_editor_tools_and_inspect/verification/screenshots/`)
| File | What it proves | Mean-L measurement |
|------|----------------|--------------------|
| `sprint3_spike_grad_nofilter.jpg` | baseline (no filter) | top 192.1 / bot 106.9 |
| `sprint3_spike_grad_darken_sky_strength+3.jpg` | Strength=+3 darkens top | top **76** / bot 103 |
| `sprint3_spike_grad_brighten_top_strength-3.jpg` | Strength=-3 brightens top | top 237 / bot 115 |
| `sprint3_spike_grad_degree180_darken_bottom.jpg` | Degree=180 flips to bottom | top 189 / bot **40** |
| `sprint3_spike_grad_degree90_darken_left.jpg` | Degree=90 → horizontal | left **61** / right 142 |
| `sprint3_spike_grad_feather0_hardline.jpg` | Feather=0 = hard edge | top 72.7 / bot 106.9 |
| `sprint3_spike_grad_feather100_soft.jpg` | Feather=100 = soft | top 90 / bot 92 |

(An `Enabled=false` control render was byte-identical to baseline — confirming the section is
genuinely read and the keys are not silently dropped.)

---

## 7. Gotchas (read before writing the mapper)

1. **Silent failure is the whole risk.** A wrong section name (`[ToneCurve]`), a wrong key, or
   a missing `Enabled=true` produces exit 0, no stderr, and zero pixel change. There is no
   safety net. When in doubt, render with `-O` and grep the emitted pp3 to confirm RT kept your
   value (if RT *normalizes* a value it round-trips it; if it *ignored* a bad key, the key is
   simply absent and the default is shown).
2. **`Enabled=true` is mandatory** for `[Vibrance]`, `[Sharpening]`, `[ColorToning]`,
   `[Dehaze]`, `[Directional Pyramid Denoising]`, `[White Balance]`, etc. `[Exposure]` and
   `[Rotation]` have **no** `Enabled` key — they always apply.
3. **White balance: `Setting` defaults to `Camera`.** Setting only `Temperature`/`Green` while
   `Setting=Camera` may be overridden by camera WB. To force your temp/tint, emit
   `Setting=Custom`. (For non-raw JPEG the camera WB is already baked, but still set
   `Setting=Custom` + `Enabled=true` to be deterministic.)
4. **Nonzero defaults that differ from "neutral" sliders** — scale accordingly:
   - `[Exposure] ShadowCompr` default = **50** (not 0).
   - `[Vibrance] AvoidColorShift` default = **true**; `PSThreshold` default = `0;75;`.
   - `[Directional Pyramid Denoising] Chroma` default = **15**.
   - `[Vibrance] Pastels`/`Saturated`, `[Exposure] Contrast`/`Saturation` are −100..+100, which
     likely differs from your UI slider range — map explicitly.
5. **`Compensation` is in EV stops, not a 0–100 slider.** `1.0` = +1 stop ≈ doubling exposure.
   A UI "exposure 0–100" must be remapped (e.g. to roughly −2..+2 EV), or images blow out.
6. **Vibrance neon bug fix:** the prior over-saturation came from pushing saturation without
   skin protection. Use `[Vibrance]` (`Pastels`) with `ProtectSkins=true` rather than
   `[Exposure] Saturation` for the "vibrance" control; reserve `[Exposure] Saturation` for the
   explicit, separate "saturation" op.
7. **Tone curve `Curve2`** is a *second* independent curve (with `CurveMode2`); leave it `0;`
   unless you intend two stacked curves.
8. **`-c` must be last.** Any `-p`/`-o` after `-c` is treated as an input filename.
9. **Doubles are written at full f64 precision** in emitted pp3s; you do NOT need to match that
   precision on input — `0.25` is accepted and round-trips as `0.25`.

---

## 8. Summary of what is and isn't binary-verified

- ✅ **Verified against the binary** (emitted pp3 and/or render round-trip): the full invocation;
  partial-pp3 acceptance; the `[Version]` header; curve-type integer map (also vs RT source);
  all 9 current-config mappings except "look" (a design composite); the parametric-curve
  encoding *layout* and that it alters pixels; ColorToning `Method=Splitco` + RGB split keys
  round-trip; Dehaze `Strength`/`Depth` round-trip; denoise section/key names.
- ✅ **Sprint 3 promotions (all pixel-graded against the 5.12 binary, see §6):** the parametric
  curve slider order is **highlights-first** (`highlights;lights;darks;shadows`, positive =
  brightens); split-tone ships via **`Method=Splitco`** with `Autosat=false` + per-zone
  `Saturation;Hue;` pairs (the earlier `RGBSliders` attempt was rejected — without GUI-authored
  `OpacityCurve`/`ColorCurve` it tinted the whole frame neon green, see §6);
  Dehaze and denoise both move pixels in the expected direction at the strengths the mapper
  emits. Proof JPEGs in `verification/screenshots/sprint3_*.jpg`.
- ⚠️ **Still not pixel-graded:** the split-tone highlight tint is intentionally weak (highlights
  near-white resist coloring) — acceptable but note it; `splitBalance` and the exact `*high` RGB
  response curve were not swept.
