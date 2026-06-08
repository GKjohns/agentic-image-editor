import { storage } from '~~/server/utils/storage'

/**
 * Create a session from an uploaded image.
 * Expects multipart/form-data with the image in a field named `image`; falls
 * back to the first file part if the field name differs.
 */
export default defineEventHandler(async (event) => {
  const parts = await readMultipartFormData(event)
  if (!parts || parts.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'No file uploaded' })
  }

  // A real file part carries a filename. Prefer the `image` field, then fall
  // back to the first file part. Plain text fields (no filename) are ignored.
  const named = parts.find(p => p.name === 'image' && p.filename && p.data?.length)
  const filePart = named ?? parts.find(p => p.filename && p.data?.length)

  if (!filePart || !filePart.data?.length) {
    throw createError({ statusCode: 400, statusMessage: 'No image file in upload' })
  }

  const id = await storage.createSession()
  await storage.writeOriginal(id, Buffer.from(filePart.data))

  return { id }
})
