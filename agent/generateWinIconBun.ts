/**
 * Temporary Bun-compatible Windows app icon generator.
 *
 * Reads resources/icon/axiomate.png and writes resources/icon/axiomate-bun.ico,
 * an ICO container with exactly one 256x256 PNG entry.
 *
 * Bun 1.3.x currently writes a broken RT_GROUP_ICON when given a multi-size ICO:
 * Explorer can select the group that claims 256x256 but points at the 16x16
 * image. Using a single 256 entry avoids that mismatch until Bun fixes it.
 *
 * Run manually whenever the source PNG changes:
 *   bun run agent/generateWinIconBun.ts
 */

import { writeFileSync } from 'fs'
import { dirname, join } from 'path'
import sharp from 'sharp'

const ICON_SIZE = 256

export async function generateBunIco(sourcePng: string): Promise<Buffer> {
  const png = await sharp(sourcePng)
    .resize(ICON_SIZE, ICON_SIZE, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer()

  const headerSize = 6
  const dirEntrySize = 16
  const imageOffset = headerSize + dirEntrySize

  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: 1 = icon
  header.writeUInt16LE(1, 4) // image count

  const entry = Buffer.alloc(dirEntrySize)
  entry.writeUInt8(0, 0) // width: 0 encodes 256 px
  entry.writeUInt8(0, 1) // height: 0 encodes 256 px
  entry.writeUInt8(0, 2) // palette colors (0 = none)
  entry.writeUInt8(0, 3) // reserved
  entry.writeUInt16LE(1, 4) // color planes
  entry.writeUInt16LE(32, 6) // bits per pixel
  entry.writeUInt32LE(png.length, 8) // image data size
  entry.writeUInt32LE(imageOffset, 12) // image data offset

  return Buffer.concat([header, entry, png])
}

// Run directly: bun run agent/generateWinIconBun.ts
if (import.meta.main) {
  const iconDir = join(dirname(import.meta.path), 'resources', 'icon')
  const src = join(iconDir, 'axiomate.png')
  const dest = join(iconDir, 'axiomate-bun.ico')
  const buf = await generateBunIco(src)
  writeFileSync(dest, buf)
  console.log(`Wrote ${dest} (${(buf.length / 1024).toFixed(1)} KB)`)
}
