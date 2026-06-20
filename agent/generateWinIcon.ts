/**
 * One-shot generator for the Windows app icon.
 *
 * Reads resources/icon/axiomate.png and writes resources/icon/axiomate.ico.
 *
 * Encoding strategy (maximizes Explorer/shell sharpness across DPI):
 *   - sizes <= 128 are stored as uncompressed 32-bit BGRA DIBs (BITMAPINFO-
 *     HEADER + bottom-up pixels + AND mask). This is what classic Win32 icon
 *     rendering paths expect; GDI scales these crisply.
 *   - the 256 entry is stored PNG-compressed (Vista+ requirement: 256px
 *     entries must be PNG to keep the file small).
 *
 * Run manually whenever the source PNG changes:
 *   bun run agent/generateWinIcon.ts
 *
 * This is the full multi-size icon. package-win.ts currently embeds
 * axiomate-bun.ico instead because Bun 1.3.x writes a broken group icon when
 * given a multi-size ICO. Switch package-win.ts back to axiomate.ico once Bun
 * handles multi-frame ICOs correctly.
 */

import { writeFileSync } from 'fs'
import { dirname, join } from 'path'
import sharp from 'sharp'

// Sizes Windows expects in a well-formed application icon.
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256] as const
// Entries at/above this size are stored as PNG; smaller ones as raw DIB.
const PNG_THRESHOLD = 256

/**
 * Encode one size as an uncompressed 32-bit BGRA DIB icon image:
 * BITMAPINFOHEADER (height doubled for XOR+AND), bottom-up BGRA pixels,
 * then a padded 1-bpp AND mask (all-zero — alpha channel does the masking).
 */
function encodeDib(rgba: Buffer, size: number): Buffer {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(size, 4) // biWidth
  header.writeInt32LE(size * 2, 8) // biHeight (XOR + AND)
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  header.writeUInt32LE(0, 16) // biCompression = BI_RGB

  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const srcRow = y * size * 4
    const dstRow = (size - 1 - y) * size * 4 // bottom-up
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4
      const d = dstRow + x * 4
      xor[d] = rgba[s + 2] // B
      xor[d + 1] = rgba[s + 1] // G
      xor[d + 2] = rgba[s] // R
      xor[d + 3] = rgba[s + 3] // A
    }
  }

  // AND mask: 1 bpp, rows padded to 32-bit boundary. Left all-zero so the
  // 32-bit alpha controls transparency.
  const maskRowBytes = Math.ceil(size / 32) * 4
  const mask = Buffer.alloc(maskRowBytes * size)

  return Buffer.concat([header, xor, mask])
}

/**
 * Build an ICO buffer from a source PNG path. Small entries are raw DIB,
 * the 256 entry is PNG; the directory header points at them by offset.
 */
export async function generateIco(sourcePng: string): Promise<Buffer> {
  const images = await Promise.all(
    ICON_SIZES.map(async size => {
      const resized = sharp(sourcePng).resize(size, size, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      if (size >= PNG_THRESHOLD) {
        return resized.png().toBuffer()
      }
      const rgba = await resized.raw().ensureAlpha().toBuffer()
      return encodeDib(rgba, size)
    }),
  )

  const count = images.length
  const headerSize = 6
  const dirEntrySize = 16
  const dirSize = dirEntrySize * count

  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: 1 = icon
  header.writeUInt16LE(count, 4) // image count

  const dir = Buffer.alloc(dirSize)
  let offset = headerSize + dirSize
  for (let i = 0; i < count; i++) {
    const size = ICON_SIZES[i]
    const img = images[i]
    const entry = dir.subarray(i * dirEntrySize, (i + 1) * dirEntrySize)
    // 0/0 width/height encodes 256 px per the ICO spec.
    entry.writeUInt8(size >= 256 ? 0 : size, 0) // width
    entry.writeUInt8(size >= 256 ? 0 : size, 1) // height
    entry.writeUInt8(0, 2) // palette colors (0 = none)
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // color planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(img.length, 8) // image data size
    entry.writeUInt32LE(offset, 12) // image data offset
    offset += img.length
  }

  return Buffer.concat([header, dir, ...images])
}

// Run directly: bun run agent/generateWinIcon.ts
if (import.meta.main) {
  const iconDir = join(dirname(import.meta.path), 'resources', 'icon')
  const src = join(iconDir, 'axiomate.png')
  const dest = join(iconDir, 'axiomate.ico')
  const buf = await generateIco(src)
  writeFileSync(dest, buf)
  console.log(`Wrote ${dest} (${(buf.length / 1024).toFixed(1)} KB)`)
}
