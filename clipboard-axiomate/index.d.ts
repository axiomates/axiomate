export type ClipboardImageResult = {
  png: Buffer
  originalWidth: number
  originalHeight: number
  width: number
  height: number
}

// --- Sync API (macOS NAPI only, returns false/null on other platforms) ---

/** Sync clipboard image check. macOS NAPI only, returns false elsewhere. */
export function hasClipboardImage(): boolean

/** Sync clipboard image read with downscaling. macOS NAPI only, returns null elsewhere. */
export function readClipboardImage(maxWidth: number, maxHeight: number): ClipboardImageResult | null

// --- Async API (cross-platform) ---

/** Cross-platform clipboard image check. macOS: NAPI/osascript, Windows: PowerShell, Linux: xclip/wl-paste. */
export function hasClipboardImageAsync(): Promise<boolean>

/** Cross-platform clipboard image read. Fallback paths return raw PNG without resizing. */
export function readClipboardImageAsync(maxWidth: number, maxHeight: number): Promise<ClipboardImageResult | null>

/** Cross-platform clipboard text read. */
export function readClipboardText(): Promise<string | null>

/** Cross-platform clipboard file paths read. Windows: FileDropList; Linux: text/URI fallback. */
export function readClipboardFilePaths(): Promise<string[]>
