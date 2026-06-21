// Frame-agnostic zoom + pan state for the lightbox inspection surface (Sprint 4).
// A ~100-line composable instead of an npm dep (plan "Considered and Rejected"):
// wheel-zoom-to-cursor, drag pan, two-finger pinch, double-click toggles fit↔100%.
// It tracks an absolute `scale` (1 = fit-to-box) plus a `translate` in CSS pixels,
// clamped to [MIN_SCALE, MAX_SCALE]. The consumer applies the resulting transform
// to whatever it's showing — the composable knows nothing about images or frames.

const MIN_SCALE = 0.5
const MAX_SCALE = 8
const WHEEL_STEP = 1.0015 // per wheel delta unit — smooth, trackpad-friendly

export function useZoomPan() {
  // `scale` is relative to FIT (1 = the object-contain fit size). The "100%"
  // (1:1, actual-pixel) scale is derived from the displayed image so the readout
  // is honest: it's natural width / fit-rendered width.
  const scale = ref(1)
  const tx = ref(0)
  const ty = ref(0)

  // The element the gestures attach to (the viewport box around the image).
  const target = ref<HTMLElement | null>(null)
  // The image element — lets us compute the true 1:1 ("100%") scale.
  const imageEl = ref<HTMLImageElement | null>(null)

  // Scale (relative to fit) at which the image renders at its natural pixels.
  function hundredScale(): number {
    const img = imageEl.value
    if (!img || !img.naturalWidth || !img.clientWidth) return 2
    return clampScale(img.naturalWidth / img.clientWidth)
  }
  // Percent shown to the user: 100% at fit-scale 1's actual pixels... we report
  // scale relative to the 1:1 size so "100%" === actual pixels.
  function toPercent(s: number): number {
    return Math.round((s / hundredScale()) * 100)
  }

  const isDragging = ref(false)
  let startX = 0
  let startY = 0
  let startTx = 0
  let startTy = 0

  // Pinch state — distance between the two active touches at gesture start.
  let pinchStartDist = 0
  let pinchStartScale = 1

  const isZoomed = computed(() => Math.abs(scale.value - 1) > 0.001)

  function clampScale(s: number): number {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
  }

  function reset() {
    scale.value = 1
    tx.value = 0
    ty.value = 0
  }

  /**
   * Zoom toward an anchor point (cursor / pinch midpoint) given in coordinates
   * relative to the target's center, so the pixel under the anchor stays put.
   */
  function zoomTo(nextScale: number, anchorX: number, anchorY: number) {
    const clamped = clampScale(nextScale)
    const ratio = clamped / scale.value
    // Keep the anchor fixed: new_translate = anchor - ratio * (anchor - old_translate)
    tx.value = anchorX - ratio * (anchorX - tx.value)
    ty.value = anchorY - ratio * (anchorY - ty.value)
    scale.value = clamped
    if (!isZoomed.value) {
      // Snap translate back to center when we land at fit.
      tx.value = 0
      ty.value = 0
    }
  }

  // Anchor relative to the target's center (matches a translate origin of center).
  function anchorFromEvent(clientX: number, clientY: number) {
    const el = target.value
    if (!el) return { x: 0, y: 0 }
    const r = el.getBoundingClientRect()
    return {
      x: clientX - (r.left + r.width / 2),
      y: clientY - (r.top + r.height / 2)
    }
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault()
    const { x, y } = anchorFromEvent(e.clientX, e.clientY)
    zoomTo(scale.value * WHEEL_STEP ** -e.deltaY, x, y)
  }

  function zoomIn() {
    zoomTo(scale.value * 1.4, 0, 0)
  }
  function zoomOut() {
    zoomTo(scale.value / 1.4, 0, 0)
  }
  function zoomToFit() {
    reset()
  }
  function zoomToHundred() {
    zoomTo(hundredScale(), 0, 0)
  }

  function toggleFitHundred() {
    if (isZoomed.value) reset()
    else zoomToHundred()
  }

  // Pointer capture keeps drag tracking outside the element; guard the calls —
  // they throw if the pointer id isn't currently active (e.g. synthetic events).
  function capturePointer(e: PointerEvent) {
    try {
      (e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId)
    } catch {
      // no active pointer — safe to ignore
    }
  }
  function releasePointer(e: PointerEvent) {
    try {
      (e.currentTarget as HTMLElement)?.releasePointerCapture?.(e.pointerId)
    } catch {
      // no active pointer — safe to ignore
    }
  }

  // --- Drag pan (mouse) ------------------------------------------------------
  function onPointerDown(e: PointerEvent) {
    if (!isZoomed.value) return // nothing to pan at fit
    isDragging.value = true
    startX = e.clientX
    startY = e.clientY
    startTx = tx.value
    startTy = ty.value
    capturePointer(e)
  }
  function onPointerMove(e: PointerEvent) {
    if (!isDragging.value) return
    tx.value = startTx + (e.clientX - startX)
    ty.value = startTy + (e.clientY - startY)
  }
  function onPointerUp(e: PointerEvent) {
    isDragging.value = false
    releasePointer(e)
  }

  // --- Pinch (touch) ---------------------------------------------------------
  function touchDist(t: TouchList) {
    const dx = t[0]!.clientX - t[1]!.clientX
    const dy = t[0]!.clientY - t[1]!.clientY
    return Math.hypot(dx, dy)
  }
  function onTouchStart(e: TouchEvent) {
    if (e.touches.length === 2) {
      pinchStartDist = touchDist(e.touches)
      pinchStartScale = scale.value
    } else if (e.touches.length === 1 && isZoomed.value) {
      isDragging.value = true
      startX = e.touches[0]!.clientX
      startY = e.touches[0]!.clientY
      startTx = tx.value
      startTy = ty.value
    }
  }
  function onTouchMove(e: TouchEvent) {
    if (e.touches.length === 2 && pinchStartDist > 0) {
      e.preventDefault()
      const dist = touchDist(e.touches)
      const midX = (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2
      const midY = (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2
      const { x, y } = anchorFromEvent(midX, midY)
      zoomTo(pinchStartScale * (dist / pinchStartDist), x, y)
    } else if (e.touches.length === 1 && isDragging.value) {
      e.preventDefault()
      tx.value = startTx + (e.touches[0]!.clientX - startX)
      ty.value = startTy + (e.touches[0]!.clientY - startY)
    }
  }
  function onTouchEnd(e: TouchEvent) {
    if (e.touches.length < 2) pinchStartDist = 0
    if (e.touches.length === 0) isDragging.value = false
  }

  // CSS transform string the consumer binds to the image (origin: center).
  const transform = computed(
    () => `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`
  )
  // Rounded percent for the footer / controls — relative to actual pixels, so
  // "100%" is the true 1:1 size (depends on the displayed image).
  const percent = computed(() => toPercent(scale.value))

  return {
    // state
    scale,
    transform,
    percent,
    isZoomed,
    isDragging,
    target,
    imageEl,
    // actions
    reset,
    zoomIn,
    zoomOut,
    zoomToFit,
    zoomToHundred,
    toggleFitHundred,
    // handlers
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    MIN_SCALE,
    MAX_SCALE
  }
}
