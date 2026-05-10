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

type OverlayOptions = {
  base64: string
  imageWidth: number
  imageHeight: number
  gridMode?: GridMode
  range?: OverlayRange
  marks?: OverlayMark[]
  jpegQuality?: number
}

const RULER_BAND = 28
const GRID_COLOR = 'rgba(255,0,0,0.32)'
const TICK_COLOR = 'rgba(255,0,0,0.72)'
const TEXT_COLOR = '#ff3b30'
const TEXT_BG = 'rgba(0,0,0,0.45)'
const TEXT_FONT = '12px Menlo, Monaco, Consolas, monospace'
const MARK_FILL = 'rgba(220, 38, 38, 0.82)'
const MARK_STROKE = '#ffffff'
const MARK_RADIUS = 12

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

  // Backing bands so labels stay legible on busy screenshots.
  parts.push(`<rect x="0" y="0" width="${width}" height="${RULER_BAND}" fill="rgba(0,0,0,0.42)"/>`)
  parts.push(`<rect x="0" y="${height - RULER_BAND}" width="${width}" height="${RULER_BAND}" fill="rgba(0,0,0,0.42)"/>`)
  parts.push(`<rect x="0" y="0" width="${RULER_BAND}" height="${height}" fill="rgba(0,0,0,0.42)"/>`)
  parts.push(`<rect x="${width - RULER_BAND}" y="0" width="${RULER_BAND}" height="${height}" fill="rgba(0,0,0,0.42)"/>`)

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
    if (mode === 'full') {
      parts.push(`<line x1="${px}" y1="0" x2="${px}" y2="${height}" stroke="${GRID_COLOR}" stroke-width="1"/>`)
    }
    parts.push(`<line x1="${px}" y1="0" x2="${px}" y2="${RULER_BAND}" stroke="${TICK_COLOR}" stroke-width="1"/>`)
    parts.push(`<line x1="${px}" y1="${height - RULER_BAND}" x2="${px}" y2="${height}" stroke="${TICK_COLOR}" stroke-width="1"/>`)
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
    if (mode === 'full') {
      parts.push(`<line x1="0" y1="${py}" x2="${width}" y2="${py}" stroke="${GRID_COLOR}" stroke-width="1"/>`)
    }
    parts.push(`<line x1="0" y1="${py}" x2="${RULER_BAND}" y2="${py}" stroke="${TICK_COLOR}" stroke-width="1"/>`)
    parts.push(`<line x1="${width - RULER_BAND}" y1="${py}" x2="${width}" y2="${py}" stroke="${TICK_COLOR}" stroke-width="1"/>`)
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
      // Match Win behavior: horizontal labels win over vertical labels.
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
      `<text x="${l.textX}" y="${l.textY}" fill="${TEXT_COLOR}" font-family="Menlo, Monaco, Consolas, monospace" font-size="12">${l.value}</text>`,
    )
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

export async function overlayScreenshotArtifacts(
  opts: OverlayOptions,
): Promise<string> {
  const { base64, imageWidth, imageHeight, gridMode = 'none', range, marks = [], jpegQuality = 92 } = opts
  if (gridMode === 'none' && marks.length === 0) return base64

  const svgParts: string[] = []
  if (gridMode !== 'none' && range && range.rangeW > 0 && range.rangeH > 0) {
    svgParts.push(buildGridSvg({ width: imageWidth, height: imageHeight, range, mode: gridMode }))
  }
  if (marks.length > 0) {
    svgParts.push(buildMarksSvg(imageWidth, imageHeight, marks))
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
