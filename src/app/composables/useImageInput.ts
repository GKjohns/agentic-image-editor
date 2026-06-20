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
  const samples = [
    { src: '/samples/flat-and-crooked.jpg', label: 'Flat & crooked' },
    { src: '/samples/foggy-ocean-horizon.jpg', label: 'Foggy ocean' },
    { src: '/samples/foggy-rocky-shore.jpg', label: 'Foggy shore' },
    { src: '/samples/cozy-cafe-warm-cast.jpg', label: 'Warm café' },
    { src: '/samples/overcast-ocean-horizon.jpg', label: 'Overcast coast' }
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
