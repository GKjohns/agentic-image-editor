// Shared label/formatting helpers for rendering a StepEvent's operations as
// compact chips and picking a phase color. Pure functions + constants (no
// reactivity) — extracted from the retired timeline card and consumed by
// AgentStepRow.vue. ImageLightbox.vue keeps its own simpler inline opChips and
// does not use this util.
import type { Operation, Phase, ToolName } from '#shared/types'

/** Nuxt UI badge color tokens we map phases onto. */
export type BadgeColor = 'neutral' | 'warning' | 'info' | 'primary' | 'secondary' | 'success'

/** Each planner phase → a distinct badge color (kept stable across the cockpit). */
export const phaseColors: Record<Phase, BadgeColor> = {
  straighten: 'neutral',
  exposure: 'warning',
  tone: 'info',
  color: 'primary',
  creative: 'secondary',
  finish: 'success'
}

/** Resolve a step's phase to a badge color (neutral when no phase set). */
export function phaseColor(phase?: Phase): BadgeColor {
  return phase ? phaseColors[phase] : 'neutral'
}

/**
 * Params that are NOT bipolar deltas centered on 0, so a leading `+` would mislead.
 * `saturation.amount` is a MULTIPLIER centered on 1 (0.7 = a reduction, not "+0.7");
 * `sharpen.amount` is a 0..1 magnitude; split-tone hue/sat, dehaze, and denoise are
 * 0..N magnitudes/angles. For any param listed here we show the bare number.
 */
export const unsignedParams: Partial<Record<ToolName, string[]>> = {
  crop: ['left', 'top', 'width', 'height'],
  saturation: ['amount'],
  sharpen: ['amount'],
  splitTone: ['shHue', 'shSat', 'hiHue', 'hiSat'],
  dehaze: ['amount'],
  denoise: ['luma', 'chroma']
}

/** Format one param value: signed deltas (e.g. "+35", "-10") unless unsigned. */
export function formatValue(v: number | string, signed: boolean): string {
  if (typeof v === 'number') {
    const rounded = Math.round(v * 100) / 100
    return signed && rounded > 0 ? `+${rounded}` : `${rounded}`
  }
  return v
}

/** Compact, generic "tool · key val key val" label for one operation. */
export function opLabel(op: Operation): string {
  const parts = Object.entries(op.params).map(([k, v]) => {
    // `look` carries a single string `name` — render just the grade name.
    if (op.tool === 'look' && k === 'name') return String(v)
    const signed = !(unsignedParams[op.tool]?.includes(k))
    return `${k} ${formatValue(v, signed)}`
  })
  return parts.length ? `${op.tool} · ${parts.join(' · ')}` : op.tool
}
