---
name: photo-editing-process
description: >
  The real operator know-how for getting a good edit out of the Agentic Image Editor's
  global-only toolset (straighten, exposure, contrast, tone, whiteBalance, saturation,
  vibrance, look, sharpen). Order of operations, target values, intent translation,
  and the failure modes — the judgment a working retoucher has internalized. Read this
  before tuning the agent's prompt or reasoning about why an edit went sideways.
---

# Photo Editing Process — operator's playbook

This tool's agent edits **one global op per step** and **re-looks at the rendered
result** before choosing the next. No local masking, no healing, no crop-to-aspect —
every move affects the whole frame. That constraint is the whole game: the discipline is
*sequence and restraint*, because you can't paint a fix into one corner.

The single most important thing: **a good edit is 3-5 deliberate moves, not 8 fiddly
ones.** Most amateur edits are bad because of *too much*, not too little.

## The toolset (exact params — advise nothing outside this)

| Op | Param(s) & range | What it does |
|----|------------------|--------------|
| `straighten` | `angleDeg` −45..45 (+ = clockwise) | rotate + auto-crop the borders |
| `exposure` | `ev` −3..3 stops | overall brightness (midtone anchor) |
| `contrast` | `amount` −1..1 | true sigmoidal S-curve about mid-gray |
| `tone` | `highlights` −100..100, `shadows` −100..100 | highlights<0 recovers blown highs; shadows>0 lifts/opens shadows. Independent, luminance-masked |
| `whiteBalance` | `temp` −100..100, `tint` −100..100 | temp+ warmer/golden, temp− cooler/blue; tint+ magenta, tint− green |
| `saturation` | `amount` 0..2 (1 = none) | global, blunt color scaler |
| `vibrance` | `amount` −1..1 | smart saturation; protects skin & already-vivid colors |
| `look` | `name` | named grade: goldenHour, tealOrange, noir, vintageFade, crispClean |
| `sharpen` | `amount` 0..1 | output sharpening — a finishing step |

## Read the image BEFORE you touch it

Don't reach for a slider until you can name what's wrong. Look, in priority order:

1. **Geometry.** Is the horizon or a strong vertical tilted? Use the true horizon, a
   building edge, a door frame, a lamppost. A 1-2° tilt is the most common and most
   ignored flaw.
2. **Exposure (midtones).** Is the *subject* too dark or too bright? Judge the face,
   the product, the focal point — not the brightest pixel in the frame.
3. **Clipping.** Blown highlights = a region gone pure white with *no detail* (sky,
   forehead, a window). Blocked shadows = pure black with no texture. Tell: if a bright
   area still holds faint tonal variation it's *recoverable*; if it's flat featureless
   white the detail is **gone forever** — don't waste a `tone` move trying to resurrect
   it.
4. **Color cast.** Find something that *should be neutral* — white shirt, gray concrete,
   snow, paper, teeth — and read its tint. Blue = too cool (shade, overcast). Orange =
   too warm (tungsten/indoor). Green = fluorescent. Magenta = someone overcorrected.
   **A cast reads as muddy, low contrast**, which is why you fix it before judging
   contrast.
5. **Flat vs contrasty.** Flat: hazy, grayish, no true black, milky — common in
   overcast/backlit/distance shots. Contrasty: harsh, blocked shadows, clipped
   highlights, no midtone breathing room.
6. **Skin tones.** The eye is ruthless about skin. Orange or magenta skin is the #1 tell
   of an over-edited image. Vibrance and the `tealOrange` look both lean on skin — watch
   it.

## Order of operations (and *why* each precedes the next)

```
straighten → exposure → tone → whiteBalance → contrast → vibrance (→ saturation) → look → sharpen
```

This is not arbitrary. Each step makes the *next* judgment readable:

- **straighten first** — `straighten` auto-crops the rotation borders, changing the
  frame. Settle composition before you spend moves tuning pixels you might crop away.
- **exposure second** — set the **midtone anchor** before shaping the ends. If the whole
  image is a stop dark, every other read (shadow detail, cast, contrast) is wrong.
  Exposure is the foundation; build on it.
- **tone third** — now that midtones sit right, recover blown highlights
  (`highlights` negative) and open blocked shadows (`shadows` positive). Doing this
  before exposure means you're fixing the ends of a tonal range whose middle is about to
  move.
- **whiteBalance fourth** — **before contrast**, because a color cast masquerades as low
  contrast and as wrong saturation. Neutralize the cast and the image often looks half
  the way "fixed" on its own. Judge contrast on a *neutral* base.
- **contrast fifth** — with exposure, tone, and color clean, you're now shaping a true
  tonal range with the S-curve, not amplifying a cast into mud.
- **vibrance, then saturation** — color comes after tone/contrast because contrast
  changes apparent saturation. Reach for `vibrance` first (it protects skin and already-
  vivid colors). `saturation` is the blunt instrument — usually you don't need it at all.
- **look near the end** — a named grade is a *creative* layer applied over a *corrected*
  base. Grade a clean image, not a broken one.
- **sharpen LAST** — sharpening amplifies whatever's there, including noise. If you
  sharpen before tone/contrast, you sharpen noise and then fight it with every
  subsequent move. It's a finishing step. Always.

Deviate when the image demands it (e.g. straighten isn't needed at all), but deviate
*deliberately*, not by reaching for the nearest slider.

## Target values — how far to push

Numbers a novice doesn't have. These are the guard-rails:

- **exposure:** most real fixes live within **±1 EV**. If you find yourself wanting more
  than **~±1.5 EV**, the problem is the wrong starting frame, not an edit — nudge,
  re-look, repeat.
- **tone highlights:** **−30 to −60** pulls a bright/blown sky back to detail. Beyond
  −80 the sky goes gray and dead.
- **tone shadows:** **+20 to +50** opens shadows naturally. Beyond **+70** you get the
  milky, flat, HDR-lifted-black look that screams amateur. Never lift shadows hard *and*
  drop contrast — they fight, and you end up with fog.
- **whiteBalance:** **neutralize the cast first**, *then* (optionally) push **+10 to
  +20** warm for mood. Don't conflate the two moves. Correcting a cool shade shot might
  be temp +30; adding sunset warmth on top is a *separate* +15. Over-warming until skin
  goes orange is the classic "fix WB by eye" mistake — stop at "neutral," then add mood
  on purpose.
- **contrast:** **+0.15 to +0.35** adds punch. **+0.5 and up** crushes shadow detail and
  clips highlights. Negative contrast only to tame a genuinely harsh image.
- **vibrance:** **+0.3 to +0.5** is a strong-but-natural boost. It's hard to make
  vibrance look cheap — that's why it's the default color move.
- **saturation:** leave at **1**. Above **~1.3** globally it looks cheap and the skin
  goes radioactive. Use only for a deliberate punchy/retro intent.
- **sharpen:** **0.2 to 0.4** for most images. Above **0.6** you get crunchy edges and
  bright/dark halos along contrast lines.

## The big amateur mistakes (and how the agent avoids them)

- **Over-saturation.** Cranking `saturation` to "make it pop." Pop comes from *contrast +
  vibrance*, not from oversaturated color. Default to vibrance; touch saturation rarely.
- **Crushed or raised blacks killing contrast.** Lifting shadows past +70 to "see more"
  produces flat fog. Crushing with +0.5 contrast murders shadow texture. The midtones
  are where the image lives.
- **Over-warming WB.** Correcting toward warm *by eye* almost always overshoots into
  orange skin. Neutralize to a real neutral first.
- **Over-sharpening halos.** Sharpening early (before tone/contrast) or above 0.6.
- **Stacking ops that fight.** shadows+ vs contrast+; a `look` plus manual color that
  pulls the opposite way; saturation on top of vibrance. Pick the move that does the
  job and stop.
- **"Doing more" on a finished image.** The hardest discipline. If it matches the
  intent, the correct next move is to **stop**.

## When to STOP

"Done" looks like: the intent is met, neutrals are neutral, the subject is correctly
exposed, there's a true black and a clean white without clipping detail you care about,
and nothing screams "edited." If you've made 3-5 deliberate moves and the last one
produced a *small* improvement, you're done. The agent has a step cap — **converge,
don't oscillate.** Each step should be smaller than the last as you home in.

## Intent → ops (the translation layer)

| User says | Do this | Not this |
|-----------|---------|----------|
| "warm it up" | `whiteBalance` temp+ | saturation |
| "make it pop" | `contrast` +0.2, `vibrance` +0.3, maybe a little `sharpen` | crank saturation |
| "moody" / "cinematic" | `look tealOrange`, or deepen shadows + cool WB | brighten + saturate |
| "fix the lighting" | `exposure`, then `tone` | contrast |
| "golden hour feel" | `look goldenHour`, or warm WB + `tone` shadows+ | just saturation |
| "black and white" | `look noir` | saturation 0 |
| "vintage / film" | `look vintageFade` | random warm + grain |
| "flat / dull" | `contrast` + `vibrance` | exposure up |
| "too dark" | `exposure` +, then `tone` shadows+ | contrast down |
| "blown out sky" | `tone` highlights− | exposure down (darkens everything) |

## The looks — when each, and when NOT

- **goldenHour** — warm, glowing, sunset light. *Not* for mid-day, blue-hour, or any
  clean/cool intent; it'll fight the scene's own color.
- **tealOrange** — cinematic teal shadows / orange skin. Great on people and warm
  scenes. *Not* on red- or green-dominant frames (foliage, brick) — it clashes and
  muddies.
- **noir** — high-contrast black & white. Use when tonal drama is the point. *Not* when
  the color *is* the subject (a sunset, a red dress).
- **vintageFade** — lifted blacks, muted color, retro film. *Not* when you want
  crispness, clarity, or accurate color.
- **crispClean** — neutral, punchy, commercial. *Not* when you want mood or atmosphere;
  it strips it out.

## Self-correction discipline

The agent re-looks every step — use it:

- **Overshot? Apply a smaller opposite nudge, not a pile-on.** If +0.4 contrast was too
  much, go −0.1, not a fresh stack of "corrections."
- **Crushed blacks** (lost shadow texture)? `tone` shadows+ a little, or reduce the
  prior contrast move.
- **Halos / crunch**? Back off `sharpen`.
- **Clipped after exposure**? Pull `tone` highlights− rather than darkening the whole
  image back down.
- Steps should shrink as you converge. If two consecutive moves are the same size in
  opposite directions, you're oscillating — stop and accept the better of the two.
