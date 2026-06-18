---
name: photo-editing-process
description: >
  The real operator know-how for getting a good edit out of the Agentic Image Editor's
  global-only toolset (straighten, exposure, tone, toneCurve, whiteBalance, contrast,
  vibrance, saturation, splitTone, dehaze, denoise, look, sharpen). The taste and
  judgment a working editor has internalized: how to read an image, genre-aware
  sensibility, the opinionated-but-collaborative stance, order of operations, target
  values, intent/mood translation, and the failure modes. Read this before tuning the
  agent's prompt or reasoning about why an edit went sideways. Keep it in lockstep with
  `src/server/utils/editing-guide.ts` (the token-lean version injected at runtime).
---

# Photo Editing Process — operator's playbook

This tool's agent tunes a single non-destructive **develop config** — one absolute value
per global slider (the same toolset, as a "preset"). Each iteration it **looks at the
rendered result**, returns the full updated config, and the server **re-renders the whole
ordered stack from the original**. Nothing is baked: any slider can move up or down freely
with no compounding, so "a touch less contrast" is literally a smaller contrast value, not
an inverse op piled on top. No local masking, no healing, no crop-to-aspect — every slider
affects the whole frame. That constraint is the whole game: the discipline is *restraint*,
because you can't paint a fix into one corner.

The single most important thing: **a good edit is 3-5 deliberate moves, not 8 fiddly
ones.** Most amateur edits are bad because of *too much*, not too little.

## Stance — edit like a pro, not a slider-twiddler

The mechanics below are table stakes. What separates a real editor is *judgment*: deciding
what the photo needs, doing the least that achieves it, and stopping. Hold these:

- **The best edit is invisible.** If a viewer can tell the image was edited, you went too
  far. The goal is "polished, not processed." The universal amateur tell is *too much*.
- **Do the least that serves the intent.** Many images need almost nothing. When torn
  between two amounts, pick the smaller. Restraint reads as taste; cranking reads as amateur.
- **Build up from zero, don't start strong and pull back.** Your eye normalizes to whatever
  it's looking at, so an overcooked starting point quickly reads as "fine." Push each move
  only until the problem is solved, then stop.
- **Be opinionated, but serve the photo.** The user gives natural-language intent ("make it
  pop," "moody," "fix it"). Find the *real* goal behind the words and serve that — going a
  touch beyond literal when that's what the intent wants — while honoring explicit requests
  and protecting the subject. If "make it pop" would wreck skin, do the version that *reads*
  as pop and keeps skin honest. Bring a point of view; don't just obey the literal words,
  and don't override them either.
- **You self-compare every pass.** The agent re-looks at the rendered frame with the
  original beside it. Use that: if the current frame screams "edited," dial back. You have
  no "sleep on it" — so make the before/after check the thing that tells you to stop.

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

Don't reach for a slider until you can name what's wrong. First, three judgment questions —
they tell you what "good" even means for *this* frame:

- **What is this photo, and what is it for?** Name the genre and the feeling it wants. You're
  translating an intent, not transcribing pixels. (See *Genre sense* below.)
- **Where should the eye land?** Find the subject (portraits: the eyes). Is anything pulling
  attention the wrong way — a color cast, a hot highlight, a muddy corner?
- **What is the single biggest problem?** Triage like a doctor's intake. Name the *one* worst
  thing and fix it first; don't spread effort evenly across sliders.

Then scan the technical problems, in priority order:

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

## Genre sense — "good" means something different per genre

The same move is a style in one genre and a disqualifying error in another. Read the genre
first (above), then let it steer *direction*; the numbers stay in *Target values*.

| Genre | Goal | Lean toward | Genre-specific tell to avoid |
|-------|------|-------------|------------------------------|
| **Portrait** | Polished but human | Slightly bright; gentle contrast; lift shadows *gently*; `vibrance` not `saturation`; light sharpen | Plastic/over-clarity skin; orange ("pumpkin") or magenta skin; crushed eye sockets |
| **Landscape** | Believable, maximal range | exposure↑ → highlights− (hold the sky) → shadows+ (open foreground); gentle S; modest `dehaze` | Neon greens, cyan-clipped skies, the "HDR cartoon," milky lifted shadows |
| **Food** | Fresh, appetizing, WARM | Bright; shadows lifted *generously*; `vibrance`; slightly warm WB | Green/cool cast (reads stale/spoiled); neon "radioactive" color; over-sharpen |
| **Product / e-commerce** | Accuracy IS the job | Neutral WB; clean whites; flat-ish; even light | ANY creative grade/cast/mood; deep shadows; over-sharpen (reads "rendered") |
| **Street / documentary** | Mood and grit | Higher contrast; inky blacks *on purpose*; often muted color; firmer clarity | Lifting shadows to gray mud (kills the look); anything that alters meaning |
| **Real estate / interior** | Bright, even, airy, honest | exposure↑; recover blown windows (highlights−); lift shadows *hard*; low contrast; straight verticals | HDR halos; flat over-bright; heavy corner shadow (kills "airy") |

The load-bearing splits, in one line each:

- **Shadows:** lift HARD (food, interior, product) · lift GENTLY (portrait, landscape) ·
  CRUSH / never lift (street).
- **Clarity / dehaze:** poison for portrait & product · flavor for food & landscape ·
  weapon for street.
- **Contrast:** low (product, interior, portrait) · moderate (food, landscape) ·
  high sigmoidal (street).
- **Universal:** pull highlights down to protect the bright end in nearly every genre —
  except street, where blowing brights can be a deliberate eye-direction choice.

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
produced a *small* improvement, you're done. The agent has an iteration cap (each iteration
re-renders the full config) — **converge.** Each pass should change less than the last as
you home in; when the config is right, set done.

## Color discipline — correct, then grade

The discipline that separates a pro color edit from an amateur one: **two distinct steps,
never collapsed.**

1. **Neutralize first.** Remove any *accidental* cast with `whiteBalance` so neutrals are
   honest and skin is believable. This is your reference — the thing you deviate *from*.
   Check **both** axes: amateurs fix `temp` (blue↔yellow) and leave a green/magenta `tint`
   sitting in the frame (indoor/fluorescent/LED light throws green → push `tint` toward
   magenta).
2. **Add mood on purpose.** Only on a neutral base, push a deliberate cast (`temp` warm/cool)
   or build a `splitTone` grade. Always know how far from neutral you've gone, so dialing
   back is one move.

- **Skin is the unforgiving reference.** All skin sits in a narrow warm hue band (~25–35°);
  melanin changes brightness/saturation, not hue. Viewers read skin as "wrong" instantly.
  The loud tells: **orange/jaundice** (over-warm), **magenta/sunburn** (`tint`), **green/
  sickly** (uncorrected fluorescent). Check faces first; off skin = the whole edit is too far.
- **Vibrance over saturation, always, on anything with people** — vibrance protects skin and
  already-vivid colors. Oversaturation is the #1 amateur tell. `saturation` < 1 is the right
  tool for a deliberately *muted*/film/moody look; `saturation` > ~1.3 globally looks cheap.
- **Harmony reads as intentional.** Teal-orange works because skin is warm (~30°) and teal
  shadows (~200–210°) sit opposite it, separating subject from environment. Keep a clean
  warm/cool axis — **warm highlights, cool shadows** is the "expensive" default; tinting both
  zones the same way makes mud. A constrained 2–4 color palette reads premium; a rainbow
  reads amateur. The shadow tint reads far stronger than the highlight tint.

## Intent → ops (the translation layer)

Interpret vague/emotional words into the *right* moves — don't take them literally when the
real goal wants more.

| User says | Do this | Not this |
|-----------|---------|----------|
| "warm it up" | `whiteBalance` temp+ (stop before skin goes orange) | saturation |
| "make it pop" | a true black **and** clean white + `contrast` +0.2 + `vibrance` +0.3, maybe a little `sharpen` | crank saturation |
| "fix the lighting" | `exposure`, then `tone` | contrast / a creative look |
| "clean" / "crisp" | neutral WB, true blacks (not lifted), controlled `vibrance`, gentle contrast, light `sharpen` | mood / cast |
| "moody" | `vibrance`-led desaturation, strong S-curve, cooler WB, cool shadows; lift shadows only a little | brighten + saturate |
| "cinematic" | `splitTone` (shadowHue~205 teal + highlightHue~38 orange, shadowSat 30–45 > highlightSat), low saturation; or `look tealOrange` | crank saturation |
| "dramatic" | `contrast` +0.25–0.35, small `dehaze`, deepen shadows but hold highlight detail | lift everything |
| "nostalgic" / "vintage / film" | `look vintageFade`, or lift the black point + warm shadow tint + `saturation` <1 + soft contrast | random warm + grain |
| "airy" / "light" / "bright" | `exposure`+ (no clipping), LOW contrast, lift shadows toward gray, slightly warm WB, soft desaturated color | high contrast |
| "gritty" | `dehaze`/clarity up, high contrast, `saturation` down | just darken |
| "golden hour feel" | `look goldenHour`, or warm WB + `tone` shadows+ | just saturation |
| "black and white" | `look noir` | saturation 0 |
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

The agent re-looks at the rendered config after every pass — use it. The image is always
re-rendered from the original, so correcting an overshoot is *free*: just set the slider to
the right value. There's no penalty for lowering a slider and no inverse op to pile on.

- **Overshot? Set the slider lower, full stop.** If `contrast 0.4` was too much, return
  `contrast 0.25` — the re-render reflects exactly that, with nothing left over from the
  prior pass.
- **Crushed blacks** (lost shadow texture)? Raise `tone` shadows a little, or dial the
  contrast value back down.
- **Halos / crunch**? Lower `sharpen`.
- **Clipped after exposure**? Pull `tone` highlights more negative rather than darkening
  the whole image with exposure.
- Each pass should change less than the last as you converge. When the config matches the
  intent, set done.
