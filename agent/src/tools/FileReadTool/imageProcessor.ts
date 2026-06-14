import type { Buffer } from 'buffer'
import { isInBundledMode } from '../../utils/bundledMode.js'

export type SharpInstance = {
  metadata(): Promise<{ width: number; height: number; format: string }>
  resize(
    width: number,
    height: number,
    options?: { fit?: string; withoutEnlargement?: boolean },
  ): SharpInstance
  jpeg(options?: { quality?: number }): SharpInstance
  png(options?: {
    compressionLevel?: number
    palette?: boolean
    colors?: number
  }): SharpInstance
  webp(options?: { quality?: number }): SharpInstance
  toBuffer(): Promise<Buffer>
}

export type SharpFunction = (input: Buffer) => SharpInstance

type SharpCreatorOptions = {
  create: {
    width: number
    height: number
    channels: 3 | 4
    background: { r: number; g: number; b: number }
  }
}

type SharpCreator = (options: SharpCreatorOptions) => SharpInstance

let imageProcessorModule: { default: SharpFunction } | null = null
let imageCreatorModule: { default: SharpCreator } | null = null

/**
 * Extract a callable sharp function from a dynamically imported module.
 * Handles multiple module shapes encountered across bundled/unbundled contexts:
 * - CJS: module itself is the function
 * - ESM: { default: function }
 * - Double-wrapped: { default: { default: function } }
 */
function extractSharpFunction(mod: unknown): SharpFunction | null {
  if (typeof mod === 'function') return mod as SharpFunction
  if (mod && typeof mod === 'object') {
    const obj = mod as Record<string, unknown>
    if (typeof obj.default === 'function') return obj.default as SharpFunction
    // Double-wrapped (seen in some Bun compiled binary contexts)
    if (obj.default && typeof obj.default === 'object') {
      const inner = obj.default as Record<string, unknown>
      if (typeof inner.default === 'function') return inner.default as SharpFunction
    }
  }
  return null
}

export async function getImageProcessor(): Promise<SharpFunction> {
  if (imageProcessorModule) {
    return imageProcessorModule.default
  }

  if (isInBundledMode()) {
    // Try to load the native image processor first.
    // IMPORTANT: use getImageProcessor() (async), NOT the sync `sharp` export.
    // The sync wrapper throws if cachedSharp hasn't been initialized yet.
    try {
      const imageProcessor = await import('image-processor-axiomate') as any
      const sharp = await imageProcessor.getImageProcessor()
      if (typeof sharp === 'function') {
        imageProcessorModule = { default: sharp }
        return sharp
      }
    } catch (e) {
      // Log the actual error for diagnostics, then fall through.
      // biome-ignore lint/suspicious/noConsole: intentional diagnostic
      console.error(
        `[getImageProcessor] image-processor-axiomate failed: ${(e as Error)?.message}`,
      )
    }
  }

  // Use sharp for non-bundled builds or as fallback.
  // Module shape varies by bundler/runtime: CJS exports fn directly,
  // ESM wraps in { default: fn }, compiled binaries may double-wrap.
  const imported = await import('sharp') as any
  const sharp = extractSharpFunction(imported)
  if (!sharp) {
    throw new Error(
      `[getImageProcessor] sharp unusable: typeof=${typeof imported}, ` +
        `keys=${imported ? Object.keys(imported).slice(0, 8).join(',') : 'null'}, ` +
        `typeof .default=${typeof imported?.default}`,
    )
  }
  imageProcessorModule = { default: sharp }
  return sharp
}

/**
 * Get image creator for generating new images from scratch.
 * Note: image-processor-napi doesn't support image creation,
 * so this always uses sharp directly.
 */
export async function getImageCreator(): Promise<SharpCreator> {
  if (imageCreatorModule) {
    return imageCreatorModule.default
  }

  const imported = await import('sharp')
  const sharp = extractSharpFunction(imported) as unknown as SharpCreator | null
  if (!sharp) {
    throw new Error('Unable to load sharp for image creation')
  }
  imageCreatorModule = { default: sharp }
  return sharp
}
