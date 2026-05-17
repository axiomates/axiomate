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
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'fs'
import { basename, join, dirname, resolve } from 'path'
import { getBuildDefine, parseFeatures, printBuildFeatures } from './buildConfig.ts'
import { nativeExeDirPlugin } from './bunPluginNativeExeDir.ts'
import { makeComputerUseStubPlugin } from './bunPluginComputerUseStub.ts'
import { spawnEnv } from './buildEnv.ts'
import { resetDistDir } from './buildPaths.ts'

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
  // See `buildEnv.ts` — clean env so child npx/tsc don't print
  // `Unknown env config` warnings for pnpm-only keys.
  console.log(`  Building ${label} ...`)
  const proc = Bun.spawnSync(command, {
    cwd,
    env: spawnEnv(),
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

function buildNapiWorkspace(name: string) {
  const generatedDts = '.napi-generated.d.ts'
  runBuildStep(
    `${name} (napi build)`,
    ['npx', 'napi', 'build', '--release', '--dts', generatedDts],
    join(root, name),
  )
  rmSync(join(root, name, generatedDts), { force: true })
}

function copyIfExists(relPath: string, destName = basename(relPath)) {
  const srcPath = join(root, relPath)
  if (!existsSync(srcPath)) {
    console.log(`  ⊘ ${relPath} (not found, skipping)`)
    return false
  }
  copyFileSync(srcPath, join(distDir, destName))
  console.log(`  ✓ ${destName}`)
  return true
}

function copyWorkspaceNativeFiles(workspace: string) {
  const workspaceDir = join(root, workspace)
  for (const file of readdirSync(workspaceDir)) {
    if (file.endsWith('.node')) {
      copyFileSync(join(workspaceDir, file), join(distDir, file))
      console.log(`  ✓ ${file}`)
    }
  }
}

// ── Step 0: Pre-build workspace packages ─────────────────────────────────────

console.log('Step 0/4: Pre-building workspace packages ...')

// Start from a clean dist/ so stale outputs from other build flows don't get
// mistaken for runtime requirements of the packaged executable.
console.log('  Cleaning dist/ ...')
resetDistDir(distDir)

// These workspace packages are bundled into the Windows exe, so their
// package exports must exist before Bun can resolve them.
buildTscWorkspace('clipboard-axiomate')
buildTscWorkspace('treeify-axiomate')
buildTscWorkspace('sandbox-axiomate')
buildTscWorkspace('mcpb-axiomate')
buildTscWorkspace('computer-use-mcp-axiomate')
buildTscWorkspace('browser-bridge-axiomate')
buildTscWorkspace('image-processor-axiomate')

buildNapiWorkspace('audio-capture-axiomate')
buildNapiWorkspace('computer-use-win-napi-axiomate')

// ── Step 1: Bundle everything into a single JS file ──────────────────────────

console.log('\nStep 1/4: Bundling all modules into dist/cli.js ...')

// Auto-include WIN32 feature so the packaged exe has the computer-use
// suite enabled (Windows is now a real native target alongside mac).
// Explicit --features can still override.
const features = parseFeatures(Bun.argv, process.env, ['WIN32'])
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
  // mac-only packages stay external so the bundler DCEs them when the
  // win build emits requires for them (gated by feature('DARWIN')).
  // computer-use-{mcp,win-napi}-axiomate stay external (workspace packages
  // with their own runtime native loaders).
  external: [
    'modifiers-mac-napi-axiomate',         // macOS-only
    'url-handler-mac-napi-axiomate',       // macOS-only
    'computer-use-mac-napi-axiomate',      // macOS-only (DARWIN-gated)
    'computer-use-win-napi-axiomate',      // win-only NAPI workspace
    'computer-use-mcp-axiomate',           // workspace pkg
    'browser-bridge-axiomate',             // workspace pkg
    'chrome-remote-interface',             // CDP client (deep node-only graph, keep external)
  ],

  // Rewrite literal .node imports to load from <exeDir>/<basename>.node
  // at runtime (Bun's virtual-path resolver can't reach the real files).
  // The computer-use stub plugin still fires when WIN32 feature is
  // absent (e.g. when --features overrides). With WIN32 set (default
  // for package:win), the plugin no-ops and the full computer-use tree
  // is included.
  plugins: [
    nativeExeDirPlugin,
    makeComputerUseStubPlugin(
      !features.includes('DARWIN') && !features.includes('WIN32'),
    ),
  ],
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
  env: spawnEnv(),
})

if (proc.exitCode !== 0) {
  console.error(`Compile failed with exit code ${proc.exitCode}`)
  process.exit(1)
}

// ── Step 3: Copy native .node files alongside the exe ────────────────────────

console.log('\nStep 3/4: Copying native .node files ...')

copyIfExists('node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node')
copyIfExists('node_modules/@nut-tree-fork/libnut-win32/build/Release/libnut.node')
copyIfExists('node_modules/node-screenshots-win32-x64-msvc/node-screenshots.win32-x64-msvc.node', 'node-screenshots.node')

// Bundle ripgrep binary alongside axiomate.exe.
// At runtime, getRipgrepConfig (utils/ripgrep.ts) looks for `rg.exe` in
// dirname(process.execPath) — i.e. next to axiomate.exe — so the user
// gets a fixed ripgrep version with no PATH lookup or system-install
// requirement. Source is the @vscode/ripgrep platform-specific subpackage
// resolved via pnpm. The wrapper @vscode/ripgrep package itself only
// exports an rgPath constant; pnpm hoists the actual binary into the
// platform-suffixed subpackage at the path below.
copyIfExists(
  'node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe',
)

copyWorkspaceNativeFiles('audio-capture-axiomate')
copyWorkspaceNativeFiles('computer-use-win-napi-axiomate')

const bundledCliPath = join(distDir, 'cli.js')
if (existsSync(bundledCliPath)) {
  unlinkSync(bundledCliPath)
  console.log('  ✓ removed intermediate cli.js')
}

// ── Step 4: Summary ──────────────────────────────────────────────────────────

console.log('\nStep 4/4: Summary')
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
