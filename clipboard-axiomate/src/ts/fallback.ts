/**
 * Cross-platform clipboard fallback using system commands.
 * Used when Rust NAPI is not available (non-macOS, or macOS without native build).
 */

import { execFile } from 'child_process'
import { readFile, unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

export type ClipboardImageResult = {
  png: Buffer
  originalWidth: number
  originalHeight: number
  width: number
  height: number
}

function exec(cmd: string, args: string[], timeout = 5000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        code: error ? (error as any).code ?? 1 : 0,
      })
    })
  })
}

function execBuffer(cmd: string, args: string[], timeout = 10000): Promise<{ stdout: Buffer; code: number }> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, encoding: 'buffer' as any, maxBuffer: 50 * 1024 * 1024 }, (error, stdout) => {
      resolve({
        stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || ''),
        code: error ? 1 : 0,
      })
    })
  })
}

// --- macOS (osascript fallback) ---

async function macHasImage(): Promise<boolean> {
  const { code } = await exec('osascript', ['-e', 'the clipboard as «class PNGf»'])
  return code === 0
}

async function macReadImage(): Promise<Buffer | null> {
  const tmpPath = join(tmpdir(), `clipboard-axiomate-${Date.now()}.png`)
  const script = [
    `set png_data to (the clipboard as «class PNGf»)`,
    `set fp to open for access POSIX file "${tmpPath}" with write permission`,
    `write png_data to fp`,
    `close access fp`,
  ].join('\n')

  const { code } = await exec('osascript', ['-e', script])
  if (code !== 0) return null

  try {
    const buf = await readFile(tmpPath)
    return buf
  } catch {
    return null
  } finally {
    await unlink(tmpPath).catch(() => {})
  }
}

async function macReadText(): Promise<string | null> {
  const { stdout, code } = await exec('osascript', ['-e', 'get the clipboard as text'])
  return code === 0 ? stdout.trim() : null
}

// --- Windows (PowerShell) ---

async function winHasImage(): Promise<boolean> {
  const { stdout } = await exec('powershell', [
    '-NoProfile', '-Command', '(Get-Clipboard -Format Image) -ne $null'
  ])
  return stdout.trim() === 'True'
}

async function winReadImage(): Promise<Buffer | null> {
  // First check if there's an image
  if (!(await winHasImage())) return null

  const tmpPath = join(tmpdir(), `clipboard-axiomate-${Date.now()}.png`)
  const script = `$img = Get-Clipboard -Format Image; if ($img) { $img.Save('${tmpPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'saved' } else { Write-Output 'empty' }`

  const { stdout, code } = await exec('powershell', ['-NoProfile', '-Command', script])
  if (code !== 0 || stdout.trim() !== 'saved') return null

  try {
    const buf = await readFile(tmpPath)
    return buf
  } catch {
    return null
  } finally {
    await unlink(tmpPath).catch(() => {})
  }
}

async function winReadText(): Promise<string | null> {
  const { stdout, code } = await exec('powershell', ['-NoProfile', '-Command', 'Get-Clipboard'])
  return code === 0 ? stdout.trim() : null
}

async function winReadFilePaths(): Promise<string[]> {
  const script = 'Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }'
  const { stdout, code } = await exec('powershell', ['-NoProfile', '-Command', script])
  if (code !== 0 || !stdout.trim()) return []
  return stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
}

// --- Linux (xclip / wl-paste) ---

async function linuxHasImage(): Promise<boolean> {
  // Try xclip first, then wl-paste (Wayland)
  const { stdout: xclipOut, code: xclipCode } = await exec('xclip', [
    '-selection', 'clipboard', '-t', 'TARGETS', '-o'
  ])
  if (xclipCode === 0 && /image\/(png|jpeg|jpg|gif|webp|bmp)/.test(xclipOut)) {
    return true
  }

  const { stdout: wlOut, code: wlCode } = await exec('wl-paste', ['-l'])
  if (wlCode === 0 && /image\/(png|jpeg|jpg|gif|webp|bmp)/.test(wlOut)) {
    return true
  }

  return false
}

async function linuxReadImage(): Promise<Buffer | null> {
  // Try xclip first
  const { stdout: xclipBuf, code: xclipCode } = await execBuffer('xclip', [
    '-selection', 'clipboard', '-t', 'image/png', '-o'
  ])
  if (xclipCode === 0 && xclipBuf.length > 0) return xclipBuf

  // Try wl-paste (Wayland)
  const { stdout: wlBuf, code: wlCode } = await execBuffer('wl-paste', ['--type', 'image/png'])
  if (wlCode === 0 && wlBuf.length > 0) return wlBuf

  return null
}

async function linuxReadText(): Promise<string | null> {
  const { stdout, code } = await exec('xclip', ['-selection', 'clipboard', '-o'])
  if (code === 0) return stdout

  const { stdout: wlOut, code: wlCode } = await exec('wl-paste', [])
  if (wlCode === 0) return wlOut

  return null
}

async function linuxReadFilePaths(): Promise<string[]> {
  const text = await linuxReadText()
  if (!text) return []
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
}

// --- Public API ---

export async function hasClipboardImageAsync(): Promise<boolean> {
  switch (process.platform) {
    case 'darwin': return macHasImage()
    case 'win32': return winHasImage()
    case 'linux': return linuxHasImage()
    default: return false
  }
}

export async function readClipboardImageAsync(
  _maxWidth: number,
  _maxHeight: number,
): Promise<ClipboardImageResult | null> {
  // Note: fallback paths don't resize — they return the raw PNG.
  // Resizing is left to the consumer (e.g., image-processor-axiomate).
  // The maxWidth/maxHeight params are accepted for API compatibility
  // but only the Rust NAPI path (macOS) does native resizing.
  let buf: Buffer | null = null

  switch (process.platform) {
    case 'darwin': buf = await macReadImage(); break
    case 'win32': buf = await winReadImage(); break
    case 'linux': buf = await linuxReadImage(); break
    default: return null
  }

  if (!buf || buf.length === 0) return null

  // TODO: extract actual dimensions from PNG header for originalWidth/originalHeight
  // For now, return 0 — consumers should use image-processor-axiomate for metadata
  return {
    png: buf,
    originalWidth: 0,
    originalHeight: 0,
    width: 0,
    height: 0,
  }
}

export async function readClipboardText(): Promise<string | null> {
  switch (process.platform) {
    case 'darwin': return macReadText()
    case 'win32': return winReadText()
    case 'linux': return linuxReadText()
    default: return null
  }
}

export async function readClipboardFilePaths(): Promise<string[]> {
  switch (process.platform) {
    case 'win32': return winReadFilePaths()
    case 'linux': return linuxReadFilePaths()
    default: return []
  }
}
