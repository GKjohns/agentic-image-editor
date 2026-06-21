import type { ToolName } from '~~/shared/types'

/** One tunable parameter of a tool. Numbers carry a range; strings an enum. */
export type ToolParamSpec
  = | {
    type: 'number'
    min: number
    max: number
    description: string
  }
  | {
    type: 'string'
    enum: string[]
    description: string
  }

/** A tool's metadata: an LLM-readable blurb plus its params. */
export interface ToolSpec {
  description: string
  params: Record<string, ToolParamSpec>
}

/**
 * The Sharp-backed tool registry (Sprint-4, 9 ops). Single source of truth fed
 * into the decision prompt and reused to build the structured-output zod schema.
 * Keep param names/ranges in lockstep with the executor.
 */
export const tools: Record<ToolName, ToolSpec> = {
  straighten: {
    description:
      'Rotate the image by a small angle to level the horizon, then center-crop out the rotation borders. Output is slightly smaller than the input.',
    params: {
      angleDeg: {
        type: 'number',
        min: -45,
        max: 45,
        description: 'Rotation in degrees. Positive rotates clockwise. Small angles (a few degrees) are the common case.'
      }
    }
  },
  crop: {
    description:
      'Crop for composition: strengthen framing, remove dead space / edge distractions, or set an aspect ratio. Normalized 0..1 of the (post-straighten) frame — left/top is the top-left corner, width/height the fraction kept. Identity is the full frame (left 0, top 0, width 1, height 1). Applied AFTER straighten. Do NOT crop reflexively — only when it serves the intent (e.g. "tighten", "make it square", "remove the distracting edge"). Leave at identity for most edits.',
    params: {
      left: {
        type: 'number',
        min: 0,
        max: 1,
        description: 'Left edge of the keep-rectangle, 0..1 of frame width. 0 = full left. left + width must be <= 1.'
      },
      top: {
        type: 'number',
        min: 0,
        max: 1,
        description: 'Top edge of the keep-rectangle, 0..1 of frame height. 0 = full top. top + height must be <= 1.'
      },
      width: {
        type: 'number',
        min: 0.1,
        max: 1,
        description: 'Width of the keep-rectangle, 0.1..1 of frame width. 1 = full width (no horizontal crop).'
      },
      height: {
        type: 'number',
        min: 0.1,
        max: 1,
        description: 'Height of the keep-rectangle, 0.1..1 of frame height. 1 = full height (no vertical crop).'
      },
      aspect: {
        type: 'string',
        enum: ['free', 'original', '1:1', '4:5', '3:2', '16:9'],
        description: 'Optional aspect hint. free = no constraint; original = keep source ratio; or a fixed ratio (1:1 square, 4:5 portrait, 3:2/16:9 landscape). The numeric rectangle is authoritative; this is a hint for the human overlay.'
      }
    }
  },
  exposure: {
    description:
      'Adjust overall brightness in photographic stops (EV). Multiplicative: each stop doubles or halves linear brightness. 0 = no change.',
    params: {
      ev: {
        type: 'number',
        min: -3,
        max: 3,
        description: 'Exposure shift in stops. Negative darkens, positive brightens. 0 = unchanged.'
      }
    }
  },
  contrast: {
    description:
      'Apply a true sigmoidal contrast S-curve about mid-gray. Positive steepens the curve (punchier, more contrast); negative flattens it (softer, less contrast). 0 = no change.',
    params: {
      amount: {
        type: 'number',
        min: -1,
        max: 1,
        description: 'Contrast strength. 0 = unchanged, +1 = strong S-curve boost, -1 = strong flatten.'
      }
    }
  },
  tone: {
    description:
      'Independently adjust highlights and shadows, luminance-masked so each only affects its tonal zone. Use to recover blown highlights or open up dark areas without touching mid-tones. Hue is preserved.',
    params: {
      highlights: {
        type: 'number',
        min: -100,
        max: 100,
        description: 'Bright-area adjustment. Negative recovers/darkens highlights, positive brightens them. 0 = unchanged.'
      },
      shadows: {
        type: 'number',
        min: -100,
        max: 100,
        description: 'Dark-area adjustment. Positive lifts/brightens shadows, negative deepens them. 0 = unchanged.'
      }
    }
  },
  toneCurve: {
    description:
      'Parametric tone curve with four independent zones (highlights, lights, darks, shadows). Finer than the tone tool: reshape ONE tonal band without touching the others, e.g. lift only the deepest shadows while leaving mids and highlights exactly where they are. Reach for this when "highlights + shadows" is too coarse. Most edits do not need it — use the simpler tone tool first.',
    params: {
      highlights: {
        type: 'number',
        min: -100,
        max: 100,
        description: 'Brightest zone. Positive brightens, negative darkens. 0 = unchanged.'
      },
      lights: {
        type: 'number',
        min: -100,
        max: 100,
        description: 'Upper-midtone zone. Positive brightens, negative darkens. 0 = unchanged.'
      },
      darks: {
        type: 'number',
        min: -100,
        max: 100,
        description: 'Lower-midtone zone. Positive brightens, negative darkens. 0 = unchanged.'
      },
      shadows: {
        type: 'number',
        min: -100,
        max: 100,
        description: 'Darkest zone. Positive lifts/opens, negative deepens. 0 = unchanged.'
      }
    }
  },
  whiteBalance: {
    description:
      'Correct or stylize color cast via temperature and tint. Use to warm up a cold image or cool down an orange one. Luminance is roughly preserved so it shifts color, not brightness.',
    params: {
      temp: {
        type: 'number',
        min: -100,
        max: 100,
        description: 'Color temperature. Positive = warmer/golden (boost red, cut blue), negative = cooler/blue. 0 = unchanged.'
      },
      tint: {
        type: 'number',
        min: -100,
        max: 100,
        description: 'Green/magenta balance. Positive = magenta, negative = green. 0 = unchanged.'
      }
    }
  },
  saturation: {
    description:
      'Scale color saturation globally. Multiplier where 0 = grayscale, 1 = unchanged, >1 = more saturated. Affects all pixels equally (use vibrance for a smarter, skin-safe boost).',
    params: {
      amount: {
        type: 'number',
        min: 0,
        max: 2,
        description: 'Saturation multiplier. 0 = grayscale, 1 = unchanged, 2 = double saturation.'
      }
    }
  },
  vibrance: {
    description:
      'Smart saturation that boosts muted colors more than already-vivid ones, protecting skin tones and avoiding clipping. Prefer this over saturation for natural-looking color pop. Negative desaturates.',
    params: {
      amount: {
        type: 'number',
        min: -1,
        max: 1,
        description: 'Vibrance strength. 0 = unchanged, +1 = strong smart boost, -1 = strong desaturate.'
      }
    }
  },
  splitTone: {
    description:
      'Split-toning: tint shadows and highlights with independent colors (hue + saturation per zone). The cinematic teal-shadow / orange-highlight grade lives here. Prefer this over a named look when you want a custom, nuanced color grade — set shadowSat or highlightSat above 0 to engage a zone, leave at 0 to skip it. The shadow tint is stronger than the highlight tint (highlights are near-white and resist coloring).',
    params: {
      shadowHue: {
        type: 'number',
        min: 0,
        max: 360,
        description: 'Shadow tint color in degrees (0/360 = red, 40 = orange, 120 = green, 210 = teal/blue, 280 = purple). Only matters when shadowSat > 0.'
      },
      shadowSat: {
        type: 'number',
        min: 0,
        max: 100,
        description: 'Shadow tint strength. 0 = no shadow tint, 30-60 = a tasteful cinematic grade, 100 = heavy. 0 = unchanged.'
      },
      highlightHue: {
        type: 'number',
        min: 0,
        max: 360,
        description: 'Highlight tint color in degrees (40 = warm orange, 210 = cool blue). Only matters when highlightSat > 0.'
      },
      highlightSat: {
        type: 'number',
        min: 0,
        max: 100,
        description: 'Highlight tint strength. 0 = no highlight tint, 30-60 = subtle warmth. 0 = unchanged.'
      },
      balance: {
        type: 'number',
        min: -100,
        max: 100,
        description: 'Shadow/highlight weighting. Negative favors the shadow tint, positive the highlight tint. 0 = balanced/unchanged.'
      }
    }
  },
  look: {
    description:
      'Apply a named creative color grade (a tasteful pro-LUT-style preset combining white balance, contrast, tone, and saturation). Pick one when the user wants a mood or finished aesthetic rather than a single adjustment.',
    params: {
      name: {
        type: 'string',
        enum: ['goldenHour', 'tealOrange', 'noir', 'vintageFade', 'crispClean'],
        description:
          'Grade name. goldenHour = warm sunlit glow; tealOrange = cinematic teal shadows + orange highlights; noir = high-contrast black & white; vintageFade = faded milky warm retro; crispClean = neutral editorial polish, no color cast.'
      }
    }
  },
  dehaze: {
    description:
      'Cut atmospheric haze / fog and add clarity, restoring contrast and saturation lost to a milky veil. Reach for it only when the image is genuinely hazy or flat from atmosphere — it is not a general contrast tool. 0 = no change.',
    params: {
      amount: {
        type: 'number',
        min: 0,
        max: 100,
        description: 'Dehaze strength. 0 = none, 40-70 = typical haze cut, 100 = aggressive (can over-darken). 0 = unchanged.'
      }
    }
  },
  denoise: {
    description:
      'Reduce noise: luminance grain and chroma (color) speckle, independently. Use SPARINGLY and only on visibly noisy images (high-ISO, deep shadow lifts) — denoise softens detail, so over-applying makes the image plasticky. Most images need none.',
    params: {
      luminance: {
        type: 'number',
        min: 0,
        max: 100,
        description: 'Luminance (brightness grain) reduction. 0 = none, 20-40 = gentle, high values smear detail. 0 = unchanged.'
      },
      chroma: {
        type: 'number',
        min: 0,
        max: 100,
        description: 'Chroma (color speckle) reduction. Safer to push than luminance. 0 = none. 0 = unchanged.'
      }
    }
  },
  gradFilter: {
    description:
      'A single linear graduated (ND) filter — a regional EXPOSURE gradient for skies and horizons (darken a bright sky, lift a dark foreground). It darkens/brightens one side of the frame with a soft feathered transition, leaving the other side untouched. Most edits need NONE — correct the image globally first; reach for this only when one band of the frame (typically the sky) needs different exposure than the rest. gradEnabled 0 = unused (the default).',
    params: {
      enabled: {
        type: 'number',
        min: 0,
        max: 1,
        description: '1 = apply the graduated filter, 0 = unused (the default). Leave at 0 for most edits.'
      },
      angle: {
        type: 'number',
        min: 0,
        max: 360,
        description: 'Gradient direction in degrees. 0 = the effect falls on the TOP of the frame (darken the sky); 180 = the bottom; 90 = the left. Only matters when enabled = 1.'
      },
      position: {
        type: 'number',
        min: 0,
        max: 1,
        description: 'Where the transition line sits across the frame, 0..1. 0.5 = centered. Lower moves the line toward the start of the gradient (toward the top at angle 0), shrinking the affected band. Only matters when enabled = 1.'
      },
      feather: {
        type: 'number',
        min: 0,
        max: 100,
        description: 'Transition softness, 0..100. 0 = a hard edge, ~50 = a smooth natural blend, 100 = very soft. Only matters when enabled = 1.'
      },
      exposure: {
        type: 'number',
        min: -3,
        max: 3,
        description: 'Exposure shift in EV on the masked side. NEGATIVE darkens (darken the sky), positive brightens. 0 = no effect. -1 to -2 EV is a typical sky-darkening pull. Only matters when enabled = 1.'
      }
    }
  },
  sharpen: {
    description:
      'Output sharpening to crisp up detail and edges. Apply as a finishing step. Tuned so the maximum is crisp, not crunchy. 0 = no change.',
    params: {
      amount: {
        type: 'number',
        min: 0,
        max: 1,
        description: 'Sharpen strength. 0 = none, 1 = maximum (crisp finish).'
      }
    }
  }
}

/** Render the registry into a compact text block for an LLM prompt. */
export function describeTools(): string {
  const lines: string[] = []
  for (const name of Object.keys(tools) as ToolName[]) {
    const spec = tools[name]
    const params = Object.entries(spec.params)
      .map(([p, s]) => {
        if (s.type === 'string') {
          return `${p} (string, one of: ${s.enum.join('|')}): ${s.description}`
        }
        return `${p} (number, ${s.min}..${s.max}): ${s.description}`
      })
      .join('; ')
    lines.push(`- ${name}: ${spec.description}\n    params: ${params}`)
  }
  return lines.join('\n')
}
