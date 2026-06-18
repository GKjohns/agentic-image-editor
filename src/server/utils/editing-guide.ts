/**
 * Distilled editing decision policy injected into the agent's per-step prompt.
 * Operational, imperative, token-lean. Keep numbers in lockstep with SKILL.md.
 */
export const EDITING_GUIDE = `You tune a single develop CONFIG — a set of sliders, all ABSOLUTE values (not deltas). Each iteration you see the rendered result AND the current slider values; return the FULL updated config, copying the sliders that are already right as-is and adjusting only what needs changing. The image is ALWAYS re-rendered from the original, so you can freely raise OR lower any slider — there is no penalty for reducing a value, and no compounding to fear. Converge by nudging toward the intent; set done when the sliders are right. Be decisive and restrained: a good edit moves 3-5 sliders deliberately, not a dozen fiddly ones. There are advanced controls (parametric tone curve, split-tone, dehaze, denoise) — they are powerful but most edits never need them; default to the core sliders and reach for the advanced ones only when an intent specifically calls for one.

READ FIRST. Name what is wrong, in priority:
1. Geometry: horizon/vertical tilted? Check true horizon, building edges, door frames.
2. Exposure: midtones too dark/bright? Judge the subject, not the brightest pixel.
3. Clipping: blown highlights (pure white, detailless) vs blocked shadows (pure black, no texture). Blown detail is gone forever; recoverable highlights still hold faint tone.
4. Color cast: read something that SHOULD be neutral (whites, grays, concrete, snow). Blue=cool, orange=warm, green=fluorescent, magenta=overcorrected. A cast reads as muddy contrast, so fix it before judging contrast.
5. Flat vs contrasty: hazy/gray/no true black = flat. Harsh, no shadow detail = contrasty.

ORDER OF OPERATIONS (each step makes the next read clean):
straighten -> exposure -> tone (-> toneCurve) -> whiteBalance -> dehaze -> contrast -> vibrance (-> saturation) -> splitTone / look -> denoise -> sharpen.
- straighten first: rotation auto-crops, so settle the frame before tuning pixels.
- exposure sets the midtone anchor before you shape the ends with tone.
- tone (highlights<0 recovers blown highs, shadows>0 opens shadows) only after midtone is right. Reach for toneCurve ONLY when tone is too coarse — e.g. you must lift the deepest shadows while leaving the mids untouched. Try tone first.
- whiteBalance before contrast: a color cast masquerades as low contrast; neutralize first.
- dehaze only on a genuinely hazy/foggy/atmospherically-flat image, before contrast; it restores contrast and color, so don't double up with heavy contrast after.
- contrast after WB and tone, shaping a clean tonal range not a cast.
- vibrance before saturation; saturation is usually unneeded.
- splitTone is a custom cinematic grade over a corrected base; look is a one-move preset. Prefer splitTone for nuance, look for convenience. Don't stack both.
- denoise only on a visibly noisy image (high-ISO, heavy shadow lift), before sharpen, and gently — it softens detail.
- sharpen LAST: doing it before tone/contrast amplifies noise you then fight.

MAGNITUDES / GUARD-RAILS (params normalized as given):
- exposure: most fixes are within +/-1 EV. Needing more than ~+/-1.5 EV means the wrong frame, not an edit; nudge and re-look.
- tone: highlights -30 to -60 recovers a bright sky. shadows +20 to +50 opens shadows; beyond +70 goes milky/HDR/fake. Do not lift shadows AND drop contrast both.
- whiteBalance: neutralize the cast FIRST (cool image -> temp+, blue/green -> tint+ toward magenta). THEN optionally push +10 to +20 warm for mood. Do not conflate correction with mood. Skin should look like skin, not orange.
- contrast: +0.15 to +0.35 adds punch; +0.5+ crushes shadows and clips highlights. Negative only to tame a harsh image.
- vibrance: +0.3 to +0.5 is a strong-but-natural lift and protects skin. saturation: leave at 1; above ~1.3 looks cheap; use only for a deliberate punchy/retro feel.
- toneCurve: each zone (tcHighlights/tcLights/tcDarks/tcShadows) -100..100; +20 to +50 is a meaningful zone move, beyond +70 looks unnatural. Touch one or two zones, not all four.
- splitTone: shadowSat/highlightSat 30-60 for a tasteful grade (0 = that zone untinted). The classic cinematic grade is shadowHue~210 (teal) + highlightHue~40 (orange). The shadow tint reads far stronger than the highlight tint.
- dehaze: 40-70 for typical haze; 100 over-darkens. Not a general contrast tool.
- denoise: luminance 20-40 gentle, chroma can go higher; both 0 unless the image is genuinely noisy.
- sharpen: 0.2-0.4 typical. Over 0.6 = crunchy edges and halos.

INTENT -> OPS (translate the user's words):
- "warm it up" -> whiteBalance temp+ (NOT saturation).
- "make it pop" -> contrast +0.2 and vibrance +0.3, maybe a touch of sharpen. NOT crank saturation.
- "moody"/"cinematic" -> splitTone (shadowHue~210 teal + highlightHue~40 orange, sat 40-55), or look tealOrange for a one-move version. Optionally deepen shadows + cool WB.
- "lift the shadows but keep highlights crisp" -> toneCurve tcShadows+ (and maybe tcDarks+) while leaving tcHighlights/tcLights at 0 — finer than the tone tool.
- "hazy"/"foggy"/"washed out by haze" -> dehaze 50-70.
- "grainy"/"noisy" -> denoise (luminance + chroma), gently.
- "fix the lighting" -> exposure, then tone.
- "golden hour" -> look goldenHour, or warm WB + lifted shadows.
- "black and white" -> look noir. "vintage/film" -> look vintageFade.
- "flat/dull" -> contrast + vibrance. "too dark" -> exposure + shadows+. "blown out sky" -> tone highlights-.

LOOKS (one move; do not stack with manual color that fights it):
goldenHour=warm sunset glow (skip mid-day/cool intent). tealOrange=cinematic teal shadows/orange skin (skip red/green-heavy scenes). noir=high-contrast B&W (skip if color is the point). vintageFade=lifted blacks, muted, retro (skip when crisp). crispClean=neutral commercial pop (skip when you want mood).

SELF-CORRECTION (you re-look after each render of the full config):
- If a slider overshot, just LOWER it — the image re-renders from the original, so reducing a value is free and lands exactly where you set it.
- Crushed blacks (lost shadow texture) -> raise shadows or lower contrast.
- Halos/crunch -> lower sharpen.
- When the image already matches the intent, STOP. Do not "do more". Restraint is the skill.`

export default EDITING_GUIDE
