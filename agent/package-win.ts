/**
 * Package axiomate as a standalone Windows executable.
 *
 * Steps:
 *   0. Clean dist/ and pre-build workspace packages that need compilation
 *   1. Bun.build() API — bundle all JS (including npm deps) into a single file
 *      with define/loader support that the CLI doesn't have.
 *   2. bun build --compile — compile the bundled JS into axiomate.exe.
 *   3. Copy native .node files alongside the exe and remove the intermediate bundle.
 *
 * Usage: bun run package:win
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'fs'
import { join, dirname, resolve } from 'path'
import { getBuildDefine, parseFeatures, printBuildFeatures } from './buildConfig.ts'
import { nativeExeDirPlugin } from './bunPluginNativeExeDir.ts'
import { makeComputerUseStubPlugin } from './bunPluginComputerUseStub.ts'

const agentDir = dirname(import.meta.path)
const pkg = JSON.parse(readFileSync(join(agentDir, 'package.json'), 'utf-8'))
const root = resolve(agentDir, '..')
const distDir = join(agentDir, 'dist')

let versionChangelog = ''
try {
  versionChangelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf-8')
} catch {
  // CHANGELOG.md not found — release notes will be empty
}

function runBuildStep(
  label: string,
  command: string[],
  cwd: string,
) {
  console.log(`  Building ${label} ...`)
  const proc = Bun.spawnSync(command, {
    cwd,
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  if (proc.exitCode !== 0) {
    console.error(`  ✗ ${label} failed`)
    process.exit(1)
  }
  console.log(`  ✓ ${label}`)
}

function buildTscWorkspace(name: string) {
  runBuildStep(`${name} (tsc)`, ['npx', 'tsc', '-p', 'tsconfig.json'], join(root, name))
}

// ── Step 0: Pre-build workspace packages ─────────────────────────────────────

console.log('Step 0/4: Pre-building workspace packages ...')

// Start from a clean dist/ so stale outputs from other build flows don't get
// mistaken for runtime requirements of the packaged executable.
console.log('  Cleaning dist/ ...')
rmSync(distDir, { recursive: true, force: true })
mkdirSync(distDir, { recursive: true })

// These workspace packages are bundled into the Windows exe, so their
// package exports must exist before Bun can resolve them.
buildTscWorkspace('clipboard-axiomate')
buildTscWorkspace('treeify-axiomate')
buildTscWorkspace('sandbox-axiomate')
buildTscWorkspace('mcpb-axiomate')
buildTscWorkspace('computer-use-dispatch-axiomate')
buildTscWorkspace('image-processor-axiomate')
buildTscWorkspace('computer-use-native-axiomate')

// audio-capture-axiomate: Rust NAPI build for Windows
const audioDir = join(root, 'audio-capture-axiomate')
runBuildStep(
  'audio-capture-axiomate (napi build)',
  ['npx', 'napi', 'build', '--release', '--target', 'x86_64-pc-windows-msvc'],
  audioDir,
)

// ── Step 1: Bundle everything into a single JS file ──────────────────────────

console.log('\nStep 1/4: Bundling all modules into dist/cli.js ...')

const features = parseFeatures(Bun.argv, process.env, [])
printBuildFeatures('package:win', features)

const result = await Bun.build({
  entrypoints: ['src/entrypoints/cli.tsx'],
  outdir: 'dist',
  target: 'bun',
  format: 'esm',

  loader: {
    '.md': 'text',
    '.txt': 'text',
  },

  features,

  define: getBuildDefine(pkg, versionChangelog),

  // Bundle as much as possible. Bun compiled binaries resolve from a virtual
  // path (B:/~BUN/root/) so external packages can't be found at runtime.
  // Only macOS-only packages stay external (they're never loaded on Windows).
  // builtinTools.ts wraps computer-use loads in feature('DARWIN') so the DCE
  // pass on Windows strips the require chain — these externals are a
  // belt-and-suspenders if some require slipped through.
  external: [
    'modifiers-mac-napi-axiomate',  // macOS-only
    'url-handler-mac-napi-axiomate', // macOS-only
    'computer-use-dispatch-axiomate',  // macOS-only, gated by feature('DARWIN')
    'computer-use-native-axiomate', // macOS-only, gated by feature('DARWIN')
  ],

  // Rewrite literal .node imports to load from <exeDir>/<basename>.node
  // at runtime (Bun's virtual-path resolver can't reach the real files).
  // Computer-use stub: alias utils/computerUse/builtinTools to a no-op so
  // the entire CU source graph is excluded from the windows bundle.
  plugins: [nativeExeDirPlugin, makeComputerUseStubPlugin(true)],
})

if (!result.success) {
  console.error('Bundle failed:')
  for (const msg of result.logs) {
    console.error(msg)
  }
  process.exit(1)
}

for (const output of result.outputs) {
  console.log(`  ${output.path} (${(output.size / 1024 / 1024).toFixed(1)} MB)`)
}

// ── Step 2: Compile bundled JS into standalone exe ───────────────────────────

console.log('\nStep 2/4: Compiling dist/cli.js → dist/axiomate.exe ...')

const proc = Bun.spawnSync([
  Bun.argv[0], 'build',
  'dist/cli.js',
  '--compile',
  '--outfile', 'dist/axiomate',
  '--target', 'bun',
  '--windows-hide-console',
  '--windows-title', 'Axiomate',
  '--windows-description', pkg.description || 'AI agent CLI',
  '--windows-version', `${pkg.version || '0.1.0'}.0`,
], {
  cwd: agentDir,
  stdio: ['inherit', 'inherit', 'inherit'],
  env: { ...process.env },
})

if (proc.exitCode !== 0) {
  console.error(`Compile failed with exit code ${proc.exitCode}`)
  process.exit(1)
}

// ── Step 3: Copy native .node files alongside the exe ────────────────────────

console.log('\nStep 3/4: Copying native .node files ...')

const nativeFiles = [
  'node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node',
  'node_modules/@nut-tree-fork/libnut-win32/build/Release/libnut.node',
  'node_modules/node-screenshots-win32-x64-msvc/node-screenshots.win32-x64-msvc.node',
  'audio-capture-axiomate/audio-capture-axiomate.node',
]

for (const relPath of nativeFiles) {
  const srcPath = join(root, relPath)
  if (existsSync(srcPath)) {
    const filename = relPath.split('/').pop()!
    copyFileSync(srcPath, join(distDir, filename))
    console.log(`  ✓ ${filename}`)
  } else {
    console.log(`  ⊘ ${relPath} (not found, skipping)`)
  }
}

const bundledCliPath = join(distDir, 'cli.js')
if (existsSync(bundledCliPath)) {
  unlinkSync(bundledCliPath)
  console.log('  ✓ removed intermediate cli.js')
}

// ── Step 4: Summary ──────────────────────────────────────────────────────────

console.log('\n✓ Build complete!\n')

const exePath = join(distDir, 'axiomate.exe')
if (existsSync(exePath)) {
  const stat = statSync(exePath)
  console.log(`  ${exePath}  (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
}

const distFiles = new Bun.Glob('*').scanSync(distDir)
let totalSize = 0
for (const file of distFiles) {
  const filePath = join(distDir, file)
  const s = statSync(filePath)
  if (s.isFile()) totalSize += s.size
}
console.log(`  Total dist/ size: ${(totalSize / 1024 / 1024).toFixed(1)} MB`)
