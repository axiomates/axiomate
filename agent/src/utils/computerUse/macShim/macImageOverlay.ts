import { getImageProcessor } from 'image-processor-axiomate'
import { computeRulerIntervals } from 'computer-use-mcp-axiomate'

type GridMode = 'none' | 'edge' | 'full'

export type OverlayMark = {
  id: number
  x: number
  y: number
}

export type OverlayRange = {
  originX: number
  originY: number
  rangeW: number
  rangeH: number
}

export type OverlayCursor = {
  x: number
  y: number
}

type OverlayOptions = {
  base64: string
  imageWidth: number
  imageHeight: number
  gridMode?: GridMode
  range?: OverlayRange
  marks?: OverlayMark[]
  cursor?: OverlayCursor
  jpegQuality?: number
}

const RULER_BAND = 20
const LABEL_TICK = 5
const PLAIN_TICK = 10
const GRID_COLOR = 'rgba(255,0,0,0.32)'
const TICK_COLOR = 'rgba(255,0,0,0.72)'
const TEXT_COLOR = '#ff3b30'
const TEXT_STROKE = 'rgba(0,0,0,0.9)'
const TEXT_BG = 'rgba(0,0,0,0.62)'
const MARK_FILL = 'rgba(220, 38, 38, 0.82)'
const MARK_STROKE = '#ffffff'
const MARK_RADIUS = 12
const RING_COLOR = '#00ff00'

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function buildGridSvg(opts: {
  width: number
  height: number
  range: OverlayRange
  mode: Exclude<GridMode, 'none'>
}): string {
  const { width, height, range, mode } = opts
  const { tick: tickX, label: labelX } = computeRulerIntervals(range.rangeW, width)
  const { tick: tickY, label: labelY } = computeRulerIntervals(range.rangeH, height)

  const parts: string[] = []

  type LabelInfo = {
    kind: 'top' | 'left' | 'bottom' | 'right'
    x0: number
    y0: number
    x1: number
    y1: number
    textX: number
    textY: number
    value: string
  }
  const labels: LabelInfo[] = []

  const pushVertical = (coord: number, labelStep: boolean) => {
    const px = clamp(Math.round(((coord - range.originX) / range.rangeW) * width), 0, width)
    const tickLen = labelStep ? LABEL_TICK : PLAIN_TICK
    parts.push(`<line x1="${px}" y1="0" x2="${px}" y2="${tickLen}" stroke="${TICK_COLOR}" stroke-width="1"/>`)
    parts.push(`<line x1="${px}" y1="${height - tickLen}" x2="${px}" y2="${height}" stroke="${TICK_COLOR}" stroke-width="1"/>`)
    if (labelStep) {
      const value = String(Math.round(coord))
      const label = escapeXml(value)
      const approxW = Math.max(12, value.length * 7)
      labels.push({
        kind: 'top',
        x0: clamp(px - Math.floor(approxW / 2) - 2, 0, width),
        y0: 2,
        x1: clamp(px + Math.ceil(approxW / 2) + 2, 0, width),
        y1: 16,
        textX: clamp(px - Math.floor(approxW / 2), 0, width),
        textY: 13,
        value: label,
      })
      labels.push({
        kind: 'bottom',
        x0: clamp(px - Math.floor(approxW / 2) - 2, 0, width),
        y0: height - 16,
        x1: clamp(px + Math.ceil(approxW / 2) + 2, 0, width),
        y1: height - 2,
        textX: clamp(px - Math.floor(approxW / 2), 0, width),
        textY: height - 5,
        value: label,
      })
    }
  }

  const pushHorizontal = (coord: number, labelStep: boolean) => {
    const py = clamp(Math.round(((coord - range.originY) / range.rangeH) * height), 0, height)
    const tickLen = labelStep ? LABEL_TICK : PLAIN_TICK
    parts.push(`<line x1="0" y1="${py}" x2="${tickLen}" y2="${py}" stroke="${TICK_COLOR}" stroke-width="1"/>`)
    parts.push(`<line x1="${width - tickLen}" y1="${py}" x2="${width}" y2="${py}" stroke="${TICK_COLOR}" stroke-width="1"/>`)
    if (labelStep) {
      const value = String(Math.round(coord))
      const label = escapeXml(value)
      const approxW = Math.max(12, value.length * 7)
      labels.push({
        kind: 'left',
        x0: 2,
        y0: clamp(py - 7, 0, height),
        x1: 2 + approxW + 4,
        y1: clamp(py + 7, 0, height),
        textX: 4,
        textY: clamp(py + 4, 0, height),
        value: label,
      })
      labels.push({
        kind: 'right',
        x0: width - approxW - 6,
        y0: clamp(py - 7, 0, height),
        x1: width - 2,
        y1: clamp(py + 7, 0, height),
        textX: width - approxW - 4,
        textY: clamp(py + 4, 0, height),
        value: label,
      })
    }
  }

  const xStart = Math.ceil(range.originX / tickX) * tickX
  for (let x = xStart; x <= range.originX + range.rangeW; x += tickX) {
    const isLabel = Math.abs((x / labelX) - Math.round(x / labelX)) < 1e-6
    pushVertical(x, isLabel)
  }

  const yStart = Math.ceil(range.originY / tickY) * tickY
  for (let y = yStart; y <= range.originY + range.rangeH; y += tickY) {
    const isLabel = Math.abs((y / labelY) - Math.round(y / labelY)) < 1e-6
    pushHorizontal(y, isLabel)
  }

  const overlaps = (a: LabelInfo, b: LabelInfo) =>
    a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0

  const shouldSkip = new Set<number>()
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i]!
      const b = labels[j]!
      if (!overlaps(a, b)) continue
      const aHorizontal = a.kind === 'top' || a.kind === 'bottom'
      const bHorizontal = b.kind === 'top' || b.kind === 'bottom'
      if (aHorizontal === bHorizontal) continue
      shouldSkip.add(aHorizontal ? j : i)
    }
  }

  for (let i = 0; i < labels.length; i++) {
    if (shouldSkip.has(i)) continue
    const l = labels[i]!
    parts.push(
      `<rect x="${l.x0}" y="${l.y0}" width="${Math.max(0, l.x1 - l.x0)}" height="${Math.max(0, l.y1 - l.y0)}" fill="${TEXT_BG}"/>`,
    )
    parts.push(
      `<text x="${l.textX}" y="${l.textY}" fill="${TEXT_STROKE}" font-family="Menlo, Monaco, Consolas, monospace" font-size="12">${l.value}</text>`,
    )
    parts.push(
      `<text x="${l.textX - 1}" y="${l.textY}" fill="${TEXT_STROKE}" font-family="Menlo, Monaco, Consolas, monospace" font-size="12">${l.value}</text>`,
    )
    parts.push(
      `<text x="${l.textX + 1}" y="${l.textY}" fill="${TEXT_STROKE}" font-family="Menlo, Monaco, Consolas, monospace" font-size="12">${l.value}</text>`,
    )
    parts.push(
      `<text x="${l.textX}" y="${l.textY - 1}" fill="${TEXT_STROKE}" font-family="Menlo, Monaco, Consolas, monospace" font-size="12">${l.value}</text>`,
    )
    parts.push(
      `<text x="${l.textX}" y="${l.textY + 1}" fill="${TEXT_STROKE}" font-family="Menlo, Monaco, Consolas, monospace" font-size="12">${l.value}</text>`,
    )
    parts.push(
      `<text x="${l.textX}" y="${l.textY}" fill="${TEXT_COLOR}" font-family="Menlo, Monaco, Consolas, monospace" font-size="12">${l.value}</text>`,
    )
  }

  if (mode === 'full') {
    const xStartLabel = Math.ceil(range.originX / labelX) * labelX
    for (let x = xStartLabel; x <= range.originX + range.rangeW; x += labelX) {
      const px = clamp(Math.round(((x - range.originX) / range.rangeW) * width), 0, width)
      if (px <= 0 || px >= width) continue
      parts.push(
        `<line x1="${px}" y1="${RULER_BAND}" x2="${px}" y2="${height - RULER_BAND}" stroke="${GRID_COLOR}" stroke-width="1"/>`,
      )
    }

    const yStartLabel = Math.ceil(range.originY / labelY) * labelY
    for (let y = yStartLabel; y <= range.originY + range.rangeH; y += labelY) {
      const py = clamp(Math.round(((y - range.originY) / range.rangeH) * height), 0, height)
      if (py <= 0 || py >= height) continue
      parts.push(
        `<line x1="${RULER_BAND}" y1="${py}" x2="${width - RULER_BAND}" y2="${py}" stroke="${GRID_COLOR}" stroke-width="1"/>`,
      )
    }
  }

  return parts.join('')
}

function buildMarksSvg(width: number, height: number, marks: OverlayMark[]): string {
  const parts: string[] = []
  for (const mark of marks) {
    const x = clamp(Math.round(mark.x), 0, width)
    const y = clamp(Math.round(mark.y), 0, height)
    const label = escapeXml(String(mark.id))
    parts.push(`<circle cx="${x}" cy="${y}" r="${MARK_RADIUS}" fill="${MARK_FILL}" stroke="${MARK_STROKE}" stroke-width="2"/>`)
    parts.push(
      `<text x="${x}" y="${y + 4}" text-anchor="middle" fill="${TEXT_COLOR}" font-family="Menlo, Monaco, Consolas, monospace" font-size="12" font-weight="700">${label}</text>`,
    )
  }
  return parts.join('')
}

function buildCursorSvg(width: number, height: number, cursor: OverlayCursor): string {
  const x = clamp(Math.round(cursor.x), 0, width)
  const y = clamp(Math.round(cursor.y), 0, height)
  const parts: string[] = []
  // Simple white arrow with black outline.
  parts.push(
    `<path d="M ${x} ${y} L ${x} ${y + 18} L ${x + 5} ${y + 13} L ${x + 9} ${y + 22} L ${x + 12} ${y + 21} L ${x + 8} ${y + 12} L ${x + 15} ${y + 12} Z" fill="black"/>`,
  )
  parts.push(
    `<path d="M ${x + 1} ${y + 1} L ${x + 1} ${y + 16} L ${x + 5} ${y + 12} L ${x + 9} ${y + 20} L ${x + 10} ${y + 19} L ${x + 6} ${y + 11} L ${x + 13} ${y + 11} Z" fill="white"/>`,
  )
  parts.push(
    `<circle cx="${x}" cy="${y}" r="10" fill="none" stroke="${RING_COLOR}" stroke-width="3"/>`,
  )
  return parts.join('')
}

export async function overlayScreenshotArtifacts(
  opts: OverlayOptions,
): Promise<string> {
  const { base64, imageWidth, imageHeight, gridMode = 'none', range, marks = [], cursor, jpegQuality = 95 } = opts
  if (gridMode === 'none' && marks.length === 0 && !cursor) return base64

  const svgParts: string[] = []
  if (gridMode !== 'none' && range && range.rangeW > 0 && range.rangeH > 0) {
    svgParts.push(buildGridSvg({ width: imageWidth, height: imageHeight, range, mode: gridMode }))
  }
  if (marks.length > 0) {
    svgParts.push(buildMarksSvg(imageWidth, imageHeight, marks))
  }
  if (cursor) {
    svgParts.push(buildCursorSvg(imageWidth, imageHeight, cursor))
  }
  if (svgParts.length === 0) return base64

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidth}" height="${imageHeight}" viewBox="0 0 ${imageWidth} ${imageHeight}">`,
    svgParts.join(''),
    `</svg>`,
  ].join('')

  const sharp = await getImageProcessor()
  const input = Buffer.from(base64, 'base64')
  const out = await sharp(input)
    .composite([{ input: Buffer.from(svg) } as never])
    .jpeg({ quality: jpegQuality })
    .toBuffer()
  return out.toString('base64')
}

export async function resizeScreenshotBase64(opts: {
  base64: string
  width: number
  height: number
  targetWidth: number
  targetHeight: number
  jpegQuality?: number
}): Promise<string> {
  const { base64, width, height, targetWidth, targetHeight, jpegQuality = 95 } = opts
  if (
    targetWidth <= 0 ||
    targetHeight <= 0 ||
    (width === targetWidth && height === targetHeight)
  ) {
    return base64
  }
  const sharp = await getImageProcessor()
  const input = Buffer.from(base64, 'base64')
  const out = await sharp(input)
    .resize(targetWidth, targetHeight, { fit: 'fill' })
    .jpeg({ quality: jpegQuality })
    .toBuffer()
  return out.toString('base64')
}
