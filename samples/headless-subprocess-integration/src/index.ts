import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import sharp from 'sharp'

type SampleInput = {
  left?: string[]
  right?: string[]
  leftDir?: string
  rightDir?: string
  visionModel?: string
  ocrModel?: string
  visionImageScaleFactor?: number
  ocrImageScaleFactor?: number
  pixelCompareScaleFactor?: number
  outputPath?: string
  axiomateBin?: string
}

type ImagePair = {
  pairId: string
  leftPath: string
  rightPath: string
}

type PixelComparison = {
  leftDimensions: { width: number; height: number }
  rightDimensions: { width: number; height: number }
  fileHashEqual: boolean
  exactPixelMatch: boolean
  meanAbsoluteDifference: number
  mse: number
  similarityScore: number
  comparisonMode:
    | 'explicit_scale_factor'
    | 'original_dimensions'
    | 'smallest_common_dimensions'
  compareWidth: number
  compareHeight: number
}

type SourceError = {
  source: 'pixel' | 'vl' | 'ocr'
  message: string
}

type VlResult = {
  same: boolean
  confidence: number
  reason: string
}

type OcrExtraction = {
  text: string
  confidence: number
  language?: string
}

type OcrComparison = {
  left: OcrExtraction
  right: OcrExtraction
  normalizedLeftText: string
  normalizedRightText: string
  similarityScore: number | null
}

type FinalVerdict = {
  label: 'same' | 'different' | 'uncertain'
  sameProbability: number
}

type PairReport = {
  pairId: string
  imageType: string
  leftPath: string
  rightPath: string
  pixel: PixelComparison | null
  vl: VlResult | null
  ocr: OcrComparison | null
  final: FinalVerdict
  errors: SourceError[]
}

type SummaryReport = {
  generatedAt: string
  axiomateBinary: string
  totalPairs: number
  sameCount: number
  differentCount: number
  uncertainCount: number
  outputPath: string
  pairs: PairReport[]
}

type ContentBlock =
  | {
      type: 'text'
      text: string
    }
  | {
      type: 'image'
      source:
        | {
            type: 'base64'
            media_type: string
            data: string
          }
        | {
            type: 'url'
            url: string
          }
    }

type StructuredCallOptions = {
  axiomateBinary: string
  model: string
  systemPrompt: string
  schema: Record<string, unknown>
  content: ContentBlock[]
}

const __filename = resolve(process.argv[1] ?? join(SAMPLE_ROOT_FALLBACK(), 'dist', 'index.js'))
const __dirname = dirname(__filename)
const SAMPLE_ROOT = resolve(__dirname, '..')

function SAMPLE_ROOT_FALLBACK(): string {
  return resolve(process.cwd(), 'samples', 'headless-subprocess-integration')
}

function getHtmlOutputPath(outputPath: string): string {
  const extension = extname(outputPath)
  if (extension.length === 0) {
    return `${outputPath}.html`
  }
  return outputPath.slice(0, -extension.length) + '.html'
}

async function createReportHtml(
  report: SummaryReport,
  _reportJsonFileName: string,
): Promise<string> {
  const templatePath = resolve(SAMPLE_ROOT, 'res', 'report.template.html')
  const template = await fs.readFile(templatePath, 'utf8')

  const metaLine = escapeHtml(
    `Generated at ${report.generatedAt} · Axiomate binary: ${report.axiomateBinary}`,
  )

  const summaryCards = [
    ['Total Pairs', String(report.totalPairs)],
    ['Same', String(report.sameCount)],
    ['Different', String(report.differentCount)],
    ['Uncertain', String(report.uncertainCount)],
  ]
    .map(
      ([label, value]) => `
        <div class="stat">
          <div class="stat-label">${escapeHtml(label)}</div>
          <div class="stat-value">${escapeHtml(value)}</div>
        </div>`,
    )
    .join('')

  const pairCards = report.pairs.map(renderPairCardHtml).join('')

  return template
    .replaceAll('__REPORT_TITLE__', escapeHtml('Headless Subprocess Integration Report'))
    .replace('__META_LINE__', metaLine)
    .replace('__SUMMARY_CARDS__', summaryCards)
    .replace('__PAIR_CARDS__', pairCards)
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderPairCardHtml(pair: PairReport): string {
  const pixelSection = pair.pixel
    ? `
      <div class="source-card">
        <div class="source-title"><h3>Pixel</h3><span class="muted">${escapeHtml(pair.pixel.comparisonMode)}</span></div>
        <div class="kv">
          <div class="kv-row"><div class="kv-key">Similarity</div><div>${escapeHtml(formatPercent(pair.pixel.similarityScore))}</div></div>
          <div class="kv-row"><div class="kv-key">Exact Match</div><div>${escapeHtml(String(pair.pixel.exactPixelMatch))}</div></div>
          <div class="kv-row"><div class="kv-key">File Hash Equal</div><div>${escapeHtml(String(pair.pixel.fileHashEqual))}</div></div>
          <div class="kv-row"><div class="kv-key">Compare Size</div><div>${escapeHtml(`${pair.pixel.compareWidth} × ${pair.pixel.compareHeight}`)}</div></div>
          <div class="kv-row"><div class="kv-key">Left Size</div><div>${escapeHtml(`${pair.pixel.leftDimensions.width} × ${pair.pixel.leftDimensions.height}`)}</div></div>
          <div class="kv-row"><div class="kv-key">Right Size</div><div>${escapeHtml(`${pair.pixel.rightDimensions.width} × ${pair.pixel.rightDimensions.height}`)}</div></div>
          <div class="kv-row"><div class="kv-key">MAD</div><div>${escapeHtml(String(pair.pixel.meanAbsoluteDifference))}</div></div>
          <div class="kv-row"><div class="kv-key">MSE</div><div>${escapeHtml(String(pair.pixel.mse))}</div></div>
        </div>
      </div>`
    : `
      <div class="source-card">
        <div class="source-title"><h3>Pixel</h3><span class="muted">not available</span></div>
      </div>`

  const vlSection = pair.vl
    ? `
      <div class="source-card">
        <div class="source-title"><h3>Vision</h3><span class="muted">${escapeHtml(formatPercent(pair.vl.confidence))}</span></div>
        <div class="kv">
          <div class="kv-row"><div class="kv-key">Same</div><div>${escapeHtml(String(pair.vl.same))}</div></div>
        </div>
        <div class="block">${escapeHtml(pair.vl.reason)}</div>
      </div>`
    : `
      <div class="source-card">
        <div class="source-title"><h3>Vision</h3><span class="muted">not available</span></div>
      </div>`

  const ocrSection = pair.ocr
    ? `
      <div class="source-card">
        <div class="source-title"><h3>OCR</h3><span class="muted">${escapeHtml(pair.ocr.similarityScore == null ? 'n/a' : formatPercent(pair.ocr.similarityScore))}</span></div>
        <div class="kv">
          <div class="kv-row"><div class="kv-key">Left Confidence</div><div>${escapeHtml(formatPercent(pair.ocr.left.confidence))}</div></div>
          <div class="kv-row"><div class="kv-key">Right Confidence</div><div>${escapeHtml(formatPercent(pair.ocr.right.confidence))}</div></div>
          <div class="kv-row"><div class="kv-key">Left Language</div><div>${escapeHtml(pair.ocr.left.language || 'unknown')}</div></div>
          <div class="kv-row"><div class="kv-key">Right Language</div><div>${escapeHtml(pair.ocr.right.language || 'unknown')}</div></div>
        </div>
        <div class="block"><strong>Left text</strong>\n${escapeHtml(pair.ocr.left.text || '')}</div>
        <div class="block"><strong>Right text</strong>\n${escapeHtml(pair.ocr.right.text || '')}</div>
      </div>`
    : `
      <div class="source-card">
        <div class="source-title"><h3>OCR</h3><span class="muted">not available</span></div>
      </div>`

  const errorSection =
    pair.errors.length > 0
      ? `
        <div>
          <h3>Errors</h3>
          <div class="error-list">
            ${pair.errors
              .map(
                error => `
                  <div class="error-item">
                    <strong>${escapeHtml(error.source.toUpperCase())}</strong>
                    <div class="block">${escapeHtml(error.message)}</div>
                  </div>`,
              )
              .join('')}
          </div>
        </div>`
      : ''

  return `
    <article class="pair-card">
      <div class="pair-header">
        <div class="pair-title">
          <strong>${escapeHtml(pair.pairId)}</strong>
          <div class="muted">${escapeHtml(pair.imageType)}</div>
        </div>
        <span class="badge ${escapeHtml(pair.final.label)}">${escapeHtml(pair.final.label)} · ${escapeHtml(formatPercent(pair.final.sameProbability))}</span>
      </div>
      <div class="pair-body">
        <div class="two-col">
          <div class="source-card">
            <div class="source-title"><h3>Left Image</h3></div>
            <div class="path">${escapeHtml(pair.leftPath)}</div>
            <img class="image" src="${escapeHtml(toFileUrl(pair.leftPath))}" alt="">
          </div>
          <div class="source-card">
            <div class="source-title"><h3>Right Image</h3></div>
            <div class="path">${escapeHtml(pair.rightPath)}</div>
            <img class="image" src="${escapeHtml(toFileUrl(pair.rightPath))}" alt="">
          </div>
        </div>
        <div class="source-grid">
          ${pixelSection}
          ${vlSection}
          ${ocrSection}
        </div>
        ${errorSection}
      </div>
    </article>`
}

function toFileUrl(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`
  }
  return encodeURI(normalized)
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const inputPath = resolve(args.input)
  const input = (await readJsonFile(inputPath)) as SampleInput

  await validateInput(input, inputPath)

  const pixelCompareScaleFactor = input.pixelCompareScaleFactor
  const outputPath = resolveInputRelative(
    inputPath,
    input.outputPath ?? args.output ?? './report.json',
  )
  const axiomateBinary = resolveAxiomateBinary(
    args.axiomateBin ?? input.axiomateBin,
  )

  const pairs = await pairImages(input, inputPath)
  const reports: PairReport[] = []

  for (const pair of pairs) {
    const leftPath = pair.leftPath
    const rightPath = pair.rightPath

    const errors: SourceError[] = []

    const pixel = await tryRun(
      'pixel',
      errors,
      () =>
        comparePixels(leftPath, rightPath, pixelCompareScaleFactor),
    )

    const vl =
      input.visionModel !== undefined
        ? await tryRun(
            'vl',
            errors,
            () =>
              runVisionComparison(
                axiomateBinary,
                input.visionModel!,
                leftPath,
                rightPath,
                input.visionImageScaleFactor,
              ),
          )
        : null

    const ocr =
      input.ocrModel !== undefined
        ? await tryRun(
            'ocr',
            errors,
            () =>
              runOcrComparison(
                axiomateBinary,
                input.ocrModel!,
                leftPath,
                rightPath,
                input.ocrImageScaleFactor,
              ),
          )
        : null

    const final = fuseScores(pixel, vl, ocr)

    reports.push({
      pairId: pair.pairId,
      imageType: 'generic',
      leftPath,
      rightPath,
      pixel,
      vl,
      ocr,
      final,
      errors,
    })
  }

  const summary: SummaryReport = {
    generatedAt: new Date().toISOString(),
    axiomateBinary,
    totalPairs: reports.length,
    sameCount: reports.filter(report => report.final.label === 'same').length,
    differentCount: reports.filter(report => report.final.label === 'different')
      .length,
    uncertainCount: reports.filter(report => report.final.label === 'uncertain')
      .length,
    outputPath,
    pairs: reports,
  }

  await fs.mkdir(dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, JSON.stringify(summary, null, 2), 'utf8')
  const htmlPath = getHtmlOutputPath(outputPath)
  await fs.writeFile(
    htmlPath,
    await createReportHtml(summary, basename(outputPath)),
    'utf8',
  )

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        outputPath,
        htmlPath,
        totalPairs: summary.totalPairs,
        sameCount: summary.sameCount,
        differentCount: summary.differentCount,
        uncertainCount: summary.uncertainCount,
      },
      null,
      2,
    ) + '\n',
  )
}

function parseArgs(argv: string[]): {
  input: string
  output?: string
  axiomateBin?: string
} {
  let input: string | undefined
  let output: string | undefined
  let axiomateBin: string | undefined

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--input') {
      input = argv[++index]
    } else if (arg === '--output') {
      output = argv[++index]
    } else if (arg === '--axiomate-bin') {
      axiomateBin = argv[++index]
    } else if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!input) {
    printHelpAndExit(1)
  }

  return { input, output, axiomateBin }
}

function printHelpAndExit(code: number): never {
  process.stderr.write(
    [
      'Usage:',
      '  node samples/headless-subprocess-integration/dist/index.js --input <input.json> [--output <report.json>] [--axiomate-bin <path>]',
      '',
      'This sample demonstrates headless subprocess integration with Axiomate.',
      '',
    ].join('\n'),
  )
  process.exit(code)
}

async function validateInput(input: SampleInput, inputPath: string): Promise<void> {
  const hasArrays =
    Array.isArray(input.left) &&
    input.left.length > 0 &&
    Array.isArray(input.right) &&
    input.right.length > 0

  const hasDirs =
    typeof input.leftDir === 'string' &&
    input.leftDir.length > 0 &&
    typeof input.rightDir === 'string' &&
    input.rightDir.length > 0

  if (!hasArrays && !hasDirs) {
    throw new Error(
      'Input must provide either non-empty "left"/"right" arrays or both "leftDir" and "rightDir".',
    )
  }

  if (hasArrays && hasDirs) {
    throw new Error(
      'Input must use exactly one mode: arrays or directories, not both.',
    )
  }

  validateScaleFactor(
    'visionImageScaleFactor',
    input.visionImageScaleFactor,
  )
  validateScaleFactor(
    'ocrImageScaleFactor',
    input.ocrImageScaleFactor,
  )

  if (
    input.pixelCompareScaleFactor !== undefined &&
    (!Number.isFinite(input.pixelCompareScaleFactor) ||
      input.pixelCompareScaleFactor <= 0 ||
      input.pixelCompareScaleFactor > 1)
  ) {
    throw new Error(
      'pixelCompareScaleFactor must be a number greater than 0 and less than or equal to 1.',
    )
  }

  if (hasArrays) {
    if (input.left!.length !== input.right!.length) {
      throw new Error(
        'Input "left" and "right" arrays must have the same length because pairing is index-based.',
      )
    }
    return
  }

  const leftDir = resolveInputRelative(inputPath, input.leftDir!)
  const rightDir = resolveInputRelative(inputPath, input.rightDir!)
  const [leftStat, rightStat] = await Promise.all([
    fs.stat(leftDir),
    fs.stat(rightDir),
  ])

  if (!leftStat.isDirectory()) {
    throw new Error(`leftDir is not a directory: ${leftDir}`)
  }
  if (!rightStat.isDirectory()) {
    throw new Error(`rightDir is not a directory: ${rightDir}`)
  }
}

async function tryRun<T>(
  source: SourceError['source'],
  errors: SourceError[],
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn()
  } catch (error) {
    errors.push({
      source,
      message: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

function validateScaleFactor(
  fieldName: string,
  value: number | undefined,
): void {
  if (
    value !== undefined &&
    (!Number.isFinite(value) || value <= 0 || value > 1)
  ) {
    throw new Error(
      `${fieldName} must be a number greater than 0 and less than or equal to 1.`,
    )
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  const content = await fs.readFile(path, 'utf8')
  return JSON.parse(content)
}

async function pairImages(
  input: SampleInput,
  inputPath: string,
): Promise<ImagePair[]> {
  if (Array.isArray(input.left) && Array.isArray(input.right)) {
    return input.left.map((entry, index) => {
      const leftPath = resolveInputRelative(inputPath, entry)
      const rightPath = resolveInputRelative(inputPath, input.right![index]!)
      return {
        pairId: basename(leftPath) || `pair-${index + 1}`,
        leftPath,
        rightPath,
      }
    })
  }

  const leftDir = resolveInputRelative(inputPath, input.leftDir!)
  const rightDir = resolveInputRelative(inputPath, input.rightDir!)
  const [leftEntries, rightEntries] = await Promise.all([
    listSupportedFiles(leftDir),
    listSupportedFiles(rightDir),
  ])

  const rightByName = new Map(
    rightEntries.map(entry => [basename(entry), entry] as const),
  )

  const pairs = leftEntries
    .filter(leftEntry => rightByName.has(basename(leftEntry)))
    .map((leftEntry, index) => ({
      pairId: basename(leftEntry) || `pair-${index + 1}`,
      leftPath: leftEntry,
      rightPath: rightByName.get(basename(leftEntry))!,
    }))

  if (pairs.length === 0) {
    throw new Error(
      `No same-name files found between directories:\n${leftDir}\n${rightDir}`,
    )
  }

  return pairs
}

async function listSupportedFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  return entries
    .filter(entry => entry.isFile())
    .map(entry => resolve(dirPath, entry.name))
    .filter(path => isSupportedImageExtension(path))
    .sort((left, right) => left.localeCompare(right))
}

function resolveInputRelative(inputPath: string, maybeRelativePath: string): string {
  if (isAbsolute(maybeRelativePath)) {
    return maybeRelativePath
  }
  return resolve(dirname(inputPath), maybeRelativePath)
}

function resolveAxiomateBinary(override?: string): string {
  const candidates = [
    override,
    process.env.AXIOMATE_BIN,
    process.platform === 'win32'
      ? resolve(SAMPLE_ROOT, 'axiomate.exe')
      : undefined,
    'axiomate',
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidate of candidates) {
    if (candidate === 'axiomate') {
      return candidate
    }
    if (existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(
    'Could not resolve an Axiomate binary. Set --axiomate-bin or AXIOMATE_BIN.',
  )
}

async function comparePixels(
  leftPath: string,
  rightPath: string,
  compareScaleFactor?: number,
): Promise<PixelComparison> {
  const [leftFile, rightFile] = await Promise.all([
    fs.readFile(leftPath),
    fs.readFile(rightPath),
  ])

  const [leftMeta, rightMeta] = await Promise.all([
    sharp(leftFile).metadata(),
    sharp(rightFile).metadata(),
  ])

  const leftWidth = leftMeta.width ?? 0
  const leftHeight = leftMeta.height ?? 0
  const rightWidth = rightMeta.width ?? 0
  const rightHeight = rightMeta.height ?? 0

  if (
    leftWidth <= 0 ||
    leftHeight <= 0 ||
    rightWidth <= 0 ||
    rightHeight <= 0
  ) {
    throw new Error(
      `Could not read image dimensions for pixel comparison:\n${leftPath}\n${rightPath}`,
    )
  }

  let compareWidth: number
  let compareHeight: number
  let comparisonMode: PixelComparison['comparisonMode']

  if (compareScaleFactor !== undefined) {
    compareWidth = Math.max(1, Math.round(Math.min(leftWidth, rightWidth) * compareScaleFactor))
    compareHeight = Math.max(1, Math.round(Math.min(leftHeight, rightHeight) * compareScaleFactor))
    comparisonMode = 'explicit_scale_factor'
  } else if (leftWidth === rightWidth && leftHeight === rightHeight) {
    compareWidth = leftWidth
    compareHeight = leftHeight
    comparisonMode = 'original_dimensions'
  } else {
    compareWidth = Math.min(leftWidth, rightWidth)
    compareHeight = Math.min(leftHeight, rightHeight)
    comparisonMode = 'smallest_common_dimensions'
  }

  const [leftRaw, rightRaw] = await Promise.all([
    renderImageForPixelCompare(leftFile, compareWidth, compareHeight),
    renderImageForPixelCompare(rightFile, compareWidth, compareHeight),
  ])

  let mse = 0
  let absolute = 0
  for (let index = 0; index < leftRaw.length; index++) {
    const diff = leftRaw[index]! - rightRaw[index]!
    absolute += Math.abs(diff)
    mse += diff * diff
  }

  mse /= leftRaw.length
  const meanAbsoluteDifference = absolute / leftRaw.length
  const mseScore = clamp01(1 - mse / (255 * 255))
  const absScore = clamp01(1 - meanAbsoluteDifference / 255)
  const similarityScore = Number(((mseScore + absScore) / 2).toFixed(4))

  let exactPixelMatch = false
  if (
    leftMeta.width === rightMeta.width &&
    leftMeta.height === rightMeta.height &&
    leftMeta.width !== undefined &&
    leftMeta.height !== undefined
  ) {
    const [leftExact, rightExact] = await Promise.all([
      sharp(leftFile).removeAlpha().toColourspace('srgb').raw().toBuffer(),
      sharp(rightFile).removeAlpha().toColourspace('srgb').raw().toBuffer(),
    ])
    exactPixelMatch = leftExact.equals(rightExact)
  }

  return {
    leftDimensions: {
      width: leftWidth,
      height: leftHeight,
    },
    rightDimensions: {
      width: rightWidth,
      height: rightHeight,
    },
    fileHashEqual: sha256(leftFile) === sha256(rightFile),
    exactPixelMatch,
    meanAbsoluteDifference: Number(meanAbsoluteDifference.toFixed(4)),
    mse: Number(mse.toFixed(4)),
    similarityScore,
    comparisonMode,
    compareWidth,
    compareHeight,
  }
}

async function runVisionComparison(
  axiomateBinary: string,
  model: string,
  leftPath: string,
  rightPath: string,
  visionImageScaleFactor?: number,
): Promise<VlResult> {
  const schema = {
    type: 'object',
    properties: {
      same: { type: 'boolean' },
      confidence: { type: 'number' },
      reason: { type: 'string' },
    },
    required: ['same', 'confidence', 'reason'],
    additionalProperties: false,
  }

  const result = (await runStructuredAxiomateCall({
    axiomateBinary,
    model,
    systemPrompt:
      'You compare exactly two images. Return strict JSON only. Decide whether they represent the same content. "same" is your binary decision. "confidence" must be the probability that the two images should be considered the same, from 0 to 1. Use around 0.5 when uncertain. Use values above 0.9 only when evidence is very strong. Use values below 0.1 only when evidence strongly shows they are different. Do not always return extreme values.',
    schema,
    content: [
      await imageFileToBlock(leftPath, visionImageScaleFactor),
      await imageFileToBlock(rightPath, visionImageScaleFactor),
      {
        type: 'text',
        text: 'Decide whether these two images are the same.',
      },
    ],
  })) as VlResult

  return {
    same: Boolean(result.same),
    confidence: clamp01(Number(result.confidence)),
    reason: String(result.reason),
  }
}

async function runOcrComparison(
  axiomateBinary: string,
  model: string,
  leftPath: string,
  rightPath: string,
  ocrImageScaleFactor?: number,
): Promise<OcrComparison> {
  const [left, right] = await Promise.all([
    runOcrExtraction(
      axiomateBinary,
      model,
      leftPath,
      ocrImageScaleFactor,
    ),
    runOcrExtraction(
      axiomateBinary,
      model,
      rightPath,
      ocrImageScaleFactor,
    ),
  ])

  const normalizedLeftText = normalizeOcrText(left.text)
  const normalizedRightText = normalizeOcrText(right.text)
  const similarityScore =
    normalizedLeftText.length === 0 && normalizedRightText.length === 0
      ? null
      : Number(
          stringSimilarity(normalizedLeftText, normalizedRightText).toFixed(4),
        )

  return {
    left,
    right,
    normalizedLeftText,
    normalizedRightText,
    similarityScore,
  }
}

async function runOcrExtraction(
  axiomateBinary: string,
  model: string,
  imagePath: string,
  ocrImageScaleFactor?: number,
): Promise<OcrExtraction> {
  const schema = {
    type: 'object',
    properties: {
      text: { type: 'string' },
      confidence: { type: 'number' },
      language: { type: 'string' },
    },
    required: ['text', 'confidence'],
    additionalProperties: false,
  }

  const result = (await runStructuredAxiomateCall({
    axiomateBinary,
    model,
    systemPrompt:
      'You are an OCR extraction tool. Read visible text from the provided image and return strict JSON only.',
    schema,
    content: [
      await imageFileToBlock(imagePath, ocrImageScaleFactor),
      {
        type: 'text',
        text: 'Extract visible OCR text from this image.',
      },
    ],
  })) as OcrExtraction

  return {
    text: String(result.text ?? ''),
    confidence: clamp01(Number(result.confidence ?? 0)),
    language:
      result.language !== undefined ? String(result.language) : undefined,
  }
}

async function imageFileToBlock(
  path: string,
  scaleFactor?: number,
): Promise<ContentBlock> {
  const mediaType = mediaTypeFromPath(path)
  const originalBuffer = await fs.readFile(path)
  const buffer =
    scaleFactor !== undefined && scaleFactor < 1
      ? await resizeImageBufferForModel(originalBuffer, scaleFactor)
      : originalBuffer
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data: buffer.toString('base64'),
    },
  }
}

async function resizeImageBufferForModel(
  buffer: Buffer,
  scaleFactor: number,
): Promise<Buffer> {
  const image = sharp(buffer)
  const metadata = await image.metadata()
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0

  if (width <= 0 || height <= 0) {
    return buffer
  }

  const resizedWidth = Math.max(1, Math.round(width * scaleFactor))
  const resizedHeight = Math.max(1, Math.round(height * scaleFactor))

  if (resizedWidth === width && resizedHeight === height) {
    return buffer
  }

  return image
    .resize(resizedWidth, resizedHeight, {
      fit: 'fill',
    })
    .toBuffer()
}

async function renderImageForPixelCompare(
  buffer: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  const image = sharp(buffer)
  const metadata = await image.metadata()
  const sourceWidth = metadata.width ?? 0
  const sourceHeight = metadata.height ?? 0

  const pipeline =
    sourceWidth === width && sourceHeight === height
      ? image
      : image.resize(width, height, { fit: 'fill' })

  return pipeline
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer()
}

function mediaTypeFromPath(path: string): string {
  const ext = extname(path).toLowerCase()
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    default:
      throw new Error(
        `Unsupported image extension for vision input: ${ext || '(none)'}`,
      )
  }
}

function isSupportedImageExtension(path: string): boolean {
  const ext = extname(path).toLowerCase()
  return ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp'
}

async function runStructuredAxiomateCall(
  options: StructuredCallOptions,
): Promise<unknown> {
  const args = [
    '-p',
    '--bare',
    '--tools',
    '',
    '--model',
    options.model,
    '--system-prompt',
    options.systemPrompt,
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--thinking',
    'disabled',
    '--max-turns',
    '10',
    '--no-session-persistence',
    '--json-schema',
    JSON.stringify(options.schema),
  ]

  const child = spawn(options.axiomateBinary, args, {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const stdinMessage = {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: options.content,
    },
  }

  child.stdin.write(JSON.stringify(stdinMessage) + '\n')
  child.stdin.end()

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    stdout += chunk
  })
  child.stderr.on('data', chunk => {
    stderr += chunk
  })

  const exitCode = await new Promise<number>((resolvePromise, rejectPromise) => {
    child.on('error', rejectPromise)
    child.on('close', resolvePromise)
  })

  const stdoutLines = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  const parsed = stdoutLines.map(line => {
    try {
      return JSON.parse(line) as Record<string, unknown>
    } catch (error) {
      throw new Error(`Failed to parse Axiomate NDJSON line: ${line}\n${String(error)}`)
    }
  })

  const resultMessage = [...parsed]
    .reverse()
    .find(message => message.type === 'result')

  if (!resultMessage) {
    throw new Error(
      `Axiomate did not emit a result message.\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}`,
    )
  }

  if (exitCode !== 0 || resultMessage.is_error === true) {
    throw new Error(
      `Axiomate call failed.\nExit code: ${exitCode}\nSTDERR:\n${stderr}\nResult:\n${JSON.stringify(
        resultMessage,
        null,
        2,
      )}`,
    )
  }

  if (!('structured_output' in resultMessage)) {
    const fallback = tryExtractStructuredOutputFromResult(resultMessage)
    if (fallback !== undefined) {
      return fallback
    }

    throw new Error(
      `Expected structured_output in result message.\nResult:\n${JSON.stringify(
        resultMessage,
        null,
        2,
      )}`,
    )
  }

  return resultMessage.structured_output
}

function tryExtractStructuredOutputFromResult(
  resultMessage: Record<string, unknown>,
): unknown | undefined {
  const rawResult = resultMessage.result
  if (typeof rawResult !== 'string' || rawResult.trim().length === 0) {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawResult)
  } catch {
    return undefined
  }

  if (!parsed || typeof parsed !== 'object') {
    return undefined
  }

  const candidate = parsed as {
    name?: unknown
    arguments?: unknown
  }

  if (
    candidate.name === 'StructuredOutput' &&
    candidate.arguments !== undefined
  ) {
    return candidate.arguments
  }

  return parsed
}

function fuseScores(
  pixel: PixelComparison | null,
  vl: VlResult | null,
  ocr: OcrComparison | null,
): FinalVerdict {
  if (pixel?.fileHashEqual || pixel?.exactPixelMatch) {
    return { label: 'same', sameProbability: 1 }
  }

  if (pixel && pixel.similarityScore <= 0) {
    return { label: 'different', sameProbability: 0 }
  }

  const weightedSignals: Array<{ weight: number; sameProbability: number }> = []

  if (pixel) {
    weightedSignals.push({
      weight: 0.45,
      sameProbability: pixel.fileHashEqual
        ? 1
        : pixel.exactPixelMatch
          ? 0.995
          : pixel.similarityScore,
    })
  }

  if (vl) {
    weightedSignals.push({
      weight: 0.4,
      sameProbability: vl.same ? vl.confidence : 1 - vl.confidence,
    })
  }

  if (ocr && ocr.similarityScore !== null) {
    weightedSignals.push({
      weight: 0.15,
      sameProbability: ocr.similarityScore,
    })
  }

  if (weightedSignals.length === 0) {
    return { label: 'uncertain', sameProbability: 0.5 }
  }

  const totalWeight = weightedSignals.reduce(
    (sum, signal) => sum + signal.weight,
    0,
  )
  const sameProbability = Number(
    (
      weightedSignals.reduce(
        (sum, signal) => sum + signal.sameProbability * signal.weight,
        0,
      ) / totalWeight
    ).toFixed(4),
  )

  if (sameProbability >= 0.8) {
    return { label: 'same', sameProbability }
  }
  if (sameProbability <= 0.2) {
    return { label: 'different', sameProbability }
  }
  return { label: 'uncertain', sameProbability }
}

function normalizeOcrText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
}

function stringSimilarity(left: string, right: string): number {
  if (left === right) {
    return 1
  }
  if (left.length === 0 || right.length === 0) {
    return 0
  }

  const distance = levenshteinDistance(left, right)
  const maxLength = Math.max(left.length, right.length)
  return clamp01(1 - distance / maxLength)
}

function levenshteinDistance(left: string, right: string): number {
  const rows = left.length + 1
  const cols = right.length + 1
  const matrix = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))

  for (let row = 0; row < rows; row++) {
    matrix[row]![0] = row
  }
  for (let col = 0; col < cols; col++) {
    matrix[0]![col] = col
  }

  for (let row = 1; row < rows; row++) {
    for (let col = 1; col < cols; col++) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1
      matrix[row]![col] = Math.min(
        matrix[row - 1]![col]! + 1,
        matrix[row]![col - 1]! + 1,
        matrix[row - 1]![col - 1]! + cost,
      )
    }
  }

  return matrix[rows - 1]![cols - 1]!
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(1, Math.max(0, value))
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
