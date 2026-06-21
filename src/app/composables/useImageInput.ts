/**
 * Source-image input state: the file the user picked (or a sample they loaded),
 * its object-URL preview, and the free-text intent. Owns object-URL lifecycle
 * (revoke on replace + on unmount) and the built-in sample library. `canRun`
 * gates the primary action — a file plus a non-empty intent.
 */
export function useImageInput() {
  const file = ref<File | null>(null)
  const previewUrl = ref<string | null>(null)
  const intent = ref('')

  function onFileChange(value: File | File[] | null) {
    const next = Array.isArray(value) ? value[0] ?? null : value
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
    file.value = next
    previewUrl.value = next ? URL.createObjectURL(next) : null
  }

  function onInputFile(event: Event) {
    const target = event.target as HTMLInputElement
    onFileChange(target.files?.[0] ?? null)
  }

  // Sample images for users who don't have a photo handy.
  // Real unedited shots straight off the camera — known-good frames whose
  // graded versions exist, so each still has obvious global work to do.
  const samples = [
    { src: '/samples/rooftop-bomber-skyline.jpg', label: 'Rooftop skyline' },
    { src: '/samples/swirl-mural-portrait.jpg', label: 'Mural portrait' },
    { src: '/samples/hill-country-hiker.jpg', label: 'Hill-country hike' },
    { src: '/samples/neon-arcade-pose.jpg', label: 'Neon arcade' },
    { src: '/samples/granite-dome-vista.jpg', label: 'Granite dome' },
    { src: '/samples/austin-skyline-mural.jpg', label: 'Skyline mural' },
    { src: '/samples/south-congress-street.jpg', label: 'Street scene' },
    { src: '/samples/south-congress-skyline.jpg', label: 'Avenue skyline' },
    { src: '/samples/pedestrian-bridge.jpg', label: 'Pedestrian bridge' },
    { src: '/samples/glass-steel-station.jpg', label: 'Train station' },
    { src: '/samples/museum-gallery-wall.jpg', label: 'Gallery wall' },
    { src: '/samples/potted-cactus.jpg', label: 'Potted cactus' },
    { src: '/samples/strawberry-cake.jpg', label: 'Strawberry cake' },
    { src: '/samples/henna-application.jpg', label: 'Henna' }
  ]

  async function loadSample(sample: { src: string, label: string }) {
    const res = await fetch(sample.src)
    const blob = await res.blob()
    const name = sample.src.split('/').pop() ?? 'sample.jpg'
    onFileChange(new File([blob], name, { type: blob.type || 'image/jpeg' }))
  }

  /** Clear file + intent back to an empty setup screen. */
  function reset() {
    onFileChange(null)
    intent.value = ''
  }

  const canRun = computed(() => !!file.value && intent.value.trim().length > 0)

  onBeforeUnmount(() => {
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  })

  return { file, previewUrl, intent, samples, loadSample, onFileChange, onInputFile, canRun, reset }
}
