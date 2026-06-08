import { storage } from '~~/server/utils/storage'

/**
 * Serve a session image. `step` is `original`, a bare number, or `step-NN`.
 * Intermediates are non-cacheable (they can be regenerated/overwritten during a
 * run); `original` is cacheable.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const rawStep = getRouterParam(event, 'step')

  if (!id || !rawStep) {
    throw createError({ statusCode: 400, statusMessage: 'Missing id or step' })
  }

  let step: 'original' | number
  if (rawStep === 'original') {
    step = 'original'
  } else {
    const match = rawStep.match(/^(?:step-)?(\d+)$/)
    if (!match) {
      throw createError({ statusCode: 400, statusMessage: `Invalid step: ${rawStep}` })
    }
    step = Number(match[1])
  }

  let buffer: Buffer
  try {
    buffer = await storage.read(id, step)
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'Image not found' })
  }

  setHeader(event, 'Content-Type', 'image/jpeg')
  setHeader(
    event,
    'Cache-Control',
    step === 'original' ? 'public, max-age=31536000, immutable' : 'no-store'
  )
  return buffer
})
