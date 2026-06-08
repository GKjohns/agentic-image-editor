/**
 * Distilled editing decision policy injected into the agent's per-step prompt.
 * Operational, imperative, token-lean. Keep numbers in lockstep with SKILL.md.
 */
export const EDITING_GUIDE = `You plan and apply a BATCH of global ops toward one stated goal each iteration, then re-look at the rendered result before the next batch. Batch corrections that clearly belong together (in the order of operations below), but ISOLATE a move whose result you need to SEE before judging the next — e.g. apply a large exposure or look change alone, then re-look. Be decisive and restrained: a good edit is 3-5 deliberate moves TOTAL, not 8 fiddly ones.

READ FIRST. Name what is wrong, in priority:
1. Geometry: horizon/vertical tilted? Check true horizon, building edges, door frames.
2. Exposure: midtones too dark/bright? Judge the subject, not the brightest pixel.
3. Clipping: blown highlights (pure white, detailless) vs blocked shadows (pure black, no texture). Blown detail is gone forever; recoverable highlights still hold faint tone.
4. Color cast: read something that SHOULD be neutral (whites, grays, concrete, snow). Blue=cool, orange=warm, green=fluorescent, magenta=overcorrected. A cast reads as muddy contrast, so fix it before judging contrast.
5. Flat vs contrasty: hazy/gray/no true black = flat. Harsh, no shadow detail = contrasty.

ORDER OF OPERATIONS (each step makes the next read clean):
straighten -> exposure -> tone -> whiteBalance -> contrast -> vibrance (-> saturation) -> look -> sharpen.
- straighten first: rotation auto-crops, so settle the frame before tuning pixels.
- exposure sets the midtone anchor before you shape the ends with tone.
- tone (highlights<0 recovers blown highs, shadows>0 opens shadows) only after midtone is right.
- whiteBalance before contrast: a color cast masquerades as low contrast; neutralize first.
- contrast after WB and tone, shaping a clean tonal range not a cast.
- vibrance before saturation; saturation is usually unneeded.
- look is a creative grade over a corrected base.
- sharpen LAST: doing it before tone/contrast amplifies noise you then fight.

MAGNITUDES / GUARD-RAILS (params normalized as given):
- exposure: most fixes are within +/-1 EV. Needing more than ~+/-1.5 EV means the wrong frame, not an edit; nudge and re-look.
- tone: highlights -30 to -60 recovers a bright sky. shadows +20 to +50 opens shadows; beyond +70 goes milky/HDR/fake. Do not lift shadows AND drop contrast both.
- whiteBalance: neutralize the cast FIRST (cool image -> temp+, blue/green -> tint+ toward magenta). THEN optionally push +10 to +20 warm for mood. Do not conflate correction with mood. Skin should look like skin, not orange.
- contrast: +0.15 to +0.35 adds punch; +0.5+ crushes shadows and clips highlights. Negative only to tame a harsh image.
- vibrance: +0.3 to +0.5 is a strong-but-natural lift and protects skin. saturation: leave at 1; above ~1.3 looks cheap; use only for a deliberate punchy/retro feel.
- sharpen: 0.2-0.4 typical. Over 0.6 = crunchy edges and halos.

INTENT -> OPS (translate the user's words):
- "warm it up" -> whiteBalance temp+ (NOT saturation).
- "make it pop" -> contrast +0.2 and vibrance +0.3, maybe a touch of sharpen. NOT crank saturation.
- "moody"/"cinematic" -> look tealOrange, or deepen shadows + cool WB.
- "fix the lighting" -> exposure, then tone.
- "golden hour" -> look goldenHour, or warm WB + lifted shadows.
- "black and white" -> look noir. "vintage/film" -> look vintageFade.
- "flat/dull" -> contrast + vibrance. "too dark" -> exposure + shadows+. "blown out sky" -> tone highlights-.

LOOKS (one move; do not stack with manual color that fights it):
goldenHour=warm sunset glow (skip mid-day/cool intent). tealOrange=cinematic teal shadows/orange skin (skip red/green-heavy scenes). noir=high-contrast B&W (skip if color is the point). vintageFade=lifted blacks, muted, retro (skip when crisp). crispClean=neutral commercial pop (skip when you want mood).

SELF-CORRECTION (you re-look after each batch, not after each op):
- If a prior batch overshot, apply a SMALLER opposite nudge, not a pile-on. Do not oscillate.
- Crushed blacks (lost shadow texture) -> shadows+ a little or reduce the prior contrast.
- Halos/crunch -> back off sharpen.
- When the image already matches the intent, STOP. Do not "do more". Restraint is the skill.`

export default EDITING_GUIDE
