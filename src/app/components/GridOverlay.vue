<script setup lang="ts">
// A presentational SVG overlay for the live stage (and, Sprint 4, the lightbox).
// Draws a rule-of-thirds grid the human can use to judge level + composition, and
// — when given an active crop config — the crop keep-rectangle dimmed against the
// rest of the frame. Theme-aware: white lines read on dark images, a black halo
// underneath keeps them legible on light ones. Self-contained: no app state, only
// props, so it can be dropped onto any object-contain frame.
//
// Coordinates are a 0..100 viewBox with `preserveAspectRatio="none"`, so the SVG
// stretches to whatever box it's absolutely positioned over — it always matches
// the frame it overlays, regardless of the image's aspect ratio.

interface CropRect {
  /** Normalized keep-rectangle, 0..1 (matches DevelopConfig crop fields). */
  left: number
  top: number
  width: number
  height: number
}

const props = withDefaults(defineProps<{
  /** Show the overlay. */
  show: boolean
  /** Optional active crop — draws the keep-rect + dims the cropped-away margins. */
  crop?: CropRect | null
}>(), {
  crop: null
})

// The crop is "active" (worth drawing) only when it's not the full frame.
const activeCrop = computed(() => {
  const c = props.crop
  if (!c) return null
  const isFull = c.left === 0 && c.top === 0 && c.width === 1 && c.height === 1
  return isFull ? null : c
})

// Crop rect in the 0..100 viewBox space.
const cropBox = computed(() => {
  const c = activeCrop.value
  if (!c) return null
  return {
    x: c.left * 100,
    y: c.top * 100,
    w: c.width * 100,
    h: c.height * 100
  }
})

// Rule-of-thirds line positions (percent). When a crop is active, draw the thirds
// INSIDE the keep-rect (that's the composition that survives); otherwise across
// the whole frame.
const thirds = computed(() => {
  const b = cropBox.value
  const x0 = b ? b.x : 0
  const y0 = b ? b.y : 0
  const w = b ? b.w : 100
  const h = b ? b.h : 100
  return {
    vx: [x0 + w / 3, x0 + (2 * w) / 3],
    hy: [y0 + h / 3, y0 + (2 * h) / 3],
    x0,
    y0,
    w,
    h
  }
})
</script>

<template>
  <svg
    v-if="show"
    class="pointer-events-none absolute inset-0 h-full w-full"
    viewBox="0 0 100 100"
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <!-- Dim the cropped-away margins so the keep-rect reads as the new frame. -->
    <template v-if="cropBox">
      <path
        :d="`M0,0 H100 V100 H0 Z M${cropBox.x},${cropBox.y} V${cropBox.y + cropBox.h} H${cropBox.x + cropBox.w} V${cropBox.y} Z`"
        fill="rgb(0 0 0 / 0.45)"
        fill-rule="evenodd"
      />
      <!-- Crop keep-rectangle border. -->
      <rect
        :x="cropBox.x"
        :y="cropBox.y"
        :width="cropBox.w"
        :height="cropBox.h"
        fill="none"
        stroke="rgb(255 255 255 / 0.9)"
        stroke-width="0.4"
        vector-effect="non-scaling-stroke"
      />
    </template>

    <!-- Rule-of-thirds grid. A dark halo (drawn first, slightly wider) keeps the
         white lines legible over light images; the white line rides on top. -->
    <g
      stroke="rgb(0 0 0 / 0.35)"
      stroke-width="1.6"
      vector-effect="non-scaling-stroke"
    >
      <line
        v-for="x in thirds.vx"
        :key="`vh-${x}`"
        :x1="x"
        :y1="thirds.y0"
        :x2="x"
        :y2="thirds.y0 + thirds.h"
      />
      <line
        v-for="y in thirds.hy"
        :key="`hh-${y}`"
        :x1="thirds.x0"
        :y1="y"
        :x2="thirds.x0 + thirds.w"
        :y2="y"
      />
    </g>
    <g
      stroke="rgb(255 255 255 / 0.7)"
      stroke-width="0.6"
      vector-effect="non-scaling-stroke"
    >
      <line
        v-for="x in thirds.vx"
        :key="`v-${x}`"
        :x1="x"
        :y1="thirds.y0"
        :x2="x"
        :y2="thirds.y0 + thirds.h"
      />
      <line
        v-for="y in thirds.hy"
        :key="`h-${y}`"
        :x1="thirds.x0"
        :y1="y"
        :x2="thirds.x0 + thirds.w"
        :y2="y"
      />
    </g>
  </svg>
</template>
