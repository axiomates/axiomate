/**
 * Clipboard image access — delegates to clipboard-axiomate.
 * Re-exports for API compatibility with axiomate's image-processor-napi.
 */

import type { ClipboardImageResult, NativeModule } from './types.js'

let clipboardModule: typeof import('clipboard-axiomate') | null = null
let loadAttempted = false

function getClipboard(): typeof import('clipboard-axiomate') | null {
  if (loadAttempted) return clipboardModule
  loadAttempted = true

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    clipboardModule = require('clipboard-axiomate')
    return clipboardModule
  } catch {
    return null
  }
}

/**
 * Check if the clipboard contains an image.
 * Sync on macOS (NAPI), returns false on other platforms without NAPI.
 */
export function hasClipboardImage(): boolean {
  const mod = getClipboard()
  return mod ? mod.hasClipboardImage() : false
}

/**
 * Read an image from the clipboard with optional downscaling.
 * Sync on macOS (NAPI), returns null on other platforms without NAPI.
 */
export function readClipboardImage(
  maxWidth: number,
  maxHeight: number,
): ClipboardImageResult | null {
  const mod = getClipboard()
  return mod ? mod.readClipboardImage(maxWidth, maxHeight) : null
}

/**
 * Async clipboard image check — cross-platform.
 */
export async function hasClipboardImageAsync(): Promise<boolean> {
  const mod = getClipboard()
  return mod ? mod.hasClipboardImageAsync() : false
}

/**
 * Async clipboard image read — cross-platform.
 */
export async function readClipboardImageAsync(
  maxWidth: number,
  maxHeight: number,
): Promise<ClipboardImageResult | null> {
  const mod = getClipboard()
  return mod ? mod.readClipboardImageAsync(maxWidth, maxHeight) : null
}

/**
 * Async clipboard file-path read — cross-platform where supported.
 */
export async function readClipboardFilePaths(): Promise<string[]> {
  const mod = getClipboard()
  return mod && 'readClipboardFilePaths' in mod
    ? mod.readClipboardFilePaths()
    : []
}

/**
 * Get a NativeModule-compatible object for backward compatibility
 * with axiomate's getNativeModule() pattern.
 */
export function getNativeModule(): NativeModule | null {
  const mod = getClipboard()
  if (!mod) return null

  return {
    processImage: async (_input: Buffer) => {
      throw new Error('processImage not supported — use getImageProcessor() from sharp.ts instead')
    },
    hasClipboardImage: () => mod.hasClipboardImage(),
    readClipboardImage: (maxWidth: number, maxHeight: number) =>
      mod.readClipboardImage(maxWidth, maxHeight),
  }
}
