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
import type { BunPlugin } from 'bun'
import { getBuildDefine, parseFeatures, printBuildFeatures } from './buildConfig.ts'
import { nativeExeDirPlugin } from './bunPluginNativeExeDir.ts'
import { makeComputerUseStubPlugin } from './bunPluginComputerUseStub.ts'
import { spawnEnv } from './buildEnv.ts'
import { resetDistDir } from './buildPaths.ts'
import { locatePlatformSubpackage } from './packageNatives.ts'

const agentDir = dirname(import.meta.path)
const pkg = JSON.parse(readFileSync(join(agentDir, 'package.json'), 'utf-8'))

// Build-time plugin: replace sharp's native loader (lib/sharp.js) with a
// minimal version that loads the .node from the exe directory using the same
// dlopen pattern as scripts/load-napi.js. Mirrors sharpMacRuntimePlugin.
const sharpWinNodeName = 'sharp-win32-x64.node'
const sharpWinRuntimePlugin: BunPlugin = {
  name: 'sharp-win-runtime',
  setup(build) {
    build.onLoad({ filter: /sharp(?:[\\/]|-)lib[\\/]sharp\.js$/ }, () => ({
      contents:
        "'use strict';\n" +
        "const { dirname, join, basename } = require('node:path');\n" +
        "const Module = require('node:module');\n" +
        "const nodeName = " + JSON.stringify(sharpWinNodeName) + ";\n" +
        "const execBase = basename(process.execPath).toLowerCase();\n" +
        "const isExe = !/^(bun|node)(\\.exe)?$/.test(execBase);\n" +
        "const searchDir = isExe ? dirname(process.execPath) : __dirname;\n" +
        "const candidate = join(searchDir, nodeName);\n" +
        "try {\n" +
        "  module.exports = require(candidate);\n" +
        "} catch (e) {\n" +
        "  try {\n" +
        "    const m = new Module(candidate);\n" +
        "    process.dlopen(m, candidate);\n" +
        "    module.exports = m.exports;\n" +
        "  } catch (e2) {\n" +
        "    throw new Error(\n" +
        "      'Could not load the \"sharp\" module (win32-x64)\\n' +\n" +
        "      candidate + ': ' + (e2.message || e2)\n" +
        "    );\n" +
        "  }\n" +
        "}\n",
      loader: 'js',
    }))
  },
}
const root = resolve(agentDir, '..')
const distDir = join(agentDir, 'dist')
const agentPackageJson = join(agentDir, 'package.json')

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

/**
 * Locate a platform-specific subpackage on disk via shared probe (see
 * packageNatives.ts), then copy the file at `subPath` into dist/. Skips
 * with a warning if not found so optional-on-this-host natives degrade
 * gracefully instead of failing the build.
 */
function copyFromPlatformSubpackage(
  parentPkg: string,
  subPkg: string,
  subPath: string,
  destName = basename(subPath),
) {
  const srcPath = locatePlatformSubpackage(
    agentPackageJson,
    root,
    parentPkg,
    subPkg,
    subPath,
  )
  if (!srcPath) {
    console.log(`  ⊘ ${subPkg}/${subPath} (not found, skipping)`)
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
    'agent-browser-axiomate',              // sidecar binary resolver (createRequire at runtime)
    'rtk-axiomate',                        // see build.ts external list
  ],

  // Rewrite literal .node imports to load from <exeDir>/<basename>.node
  // at runtime (Bun's virtual-path resolver can't reach the real files).
  // The computer-use stub plugin still fires when WIN32 feature is
  // absent (e.g. when --features overrides). With WIN32 set (default
  // for package:win), the plugin no-ops and the full computer-use tree
  // is included.
  plugins: [
    nativeExeDirPlugin,
    sharpWinRuntimePlugin,
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

// Embed the pre-generated application icon so Windows shows it in Explorer/
// taskbar instead of Bun's default. Bun 1.3.x mishandles multi-size ICOs, so
// use the temporary single-entry 256x256 icon generated by
// generateWinIconBun.ts. Switch back to resources/icon/axiomate.ico when Bun
// handles multi-frame ICOs correctly.
const iconArgs: string[] = []
const icoPath = join(agentDir, 'resources', 'icon', 'axiomate-bun.ico')
if (existsSync(icoPath)) {
  iconArgs.push(`--windows-icon=${icoPath}`)
  console.log('  ✓ embedding resources/icon/axiomate-bun.ico')
} else {
  console.log('  ⊘ resources/icon/axiomate-bun.ico not found — using default Bun icon')
}

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
  ...iconArgs,
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
//
// Known harmless leak: Bun's CJS interop hardcodes `__dirname` literals
// into the compiled exe. `@grpc/grpc-js` (pulled in by the OTLP-gRPC
// telemetry exporters) ships CJS modules, so the build-machine path
// `<...>/.pnpm/@grpc+grpc-js@<ver>/...` appears as a string inside
// axiomate.exe. The variable is only read by grpc-js's own require chain;
// runtime never resolves anything from that path. Functional behavior
// is unaffected. See follow-up task for stripping it via a Bun plugin
// or dropping OTLP-gRPC altogether.

console.log('\nStep 3/4: Copying native .node files ...')

copyFromPlatformSubpackage(
  'sharp',
  '@img/sharp-win32-x64',
  'lib/sharp-win32-x64.node',
)
// sharp's native addon depends on libvips DLLs at load time.
// They must be in the same directory as the .node file (exe dir).
copyFromPlatformSubpackage(
  'sharp',
  '@img/sharp-win32-x64',
  'lib/libvips-42.dll',
)
copyFromPlatformSubpackage(
  'sharp',
  '@img/sharp-win32-x64',
  'lib/libvips-cpp.dll',
)
copyFromPlatformSubpackage(
  '@nut-tree-fork/nut-js',
  '@nut-tree-fork/libnut-win32',
  'build/Release/libnut.node',
)
copyFromPlatformSubpackage(
  'node-screenshots',
  'node-screenshots-win32-x64-msvc',
  'node-screenshots.win32-x64-msvc.node',
  'node-screenshots.node',
)

// Bundle ripgrep binary alongside axiomate.exe.
// At runtime, getRipgrepConfig (utils/ripgrep.ts) looks for `rg.exe` in
// dirname(process.execPath) — i.e. next to axiomate.exe — so the user
// gets a fixed ripgrep version with no PATH lookup or system-install
// requirement. The platform-specific subpackage is installed under
// `@vscode/ripgrep/node_modules/` by pnpm — we anchor on the parent
// (resolvable from agent/package.json) and walk to the binary.
copyFromPlatformSubpackage(
  '@vscode/ripgrep',
  '@vscode/ripgrep-win32-x64',
  'bin/rg.exe',
)

// Bundle rtk binary alongside axiomate.exe — same resolution model as rg
// (see agent/src/utils/rtk.ts and rtk-axiomate/index.js). The workspace
// package's `build` script (run during bootstrap) downloads the binary
// from axiomates/rtk releases into rtk-axiomate/bin/, cached under
// rtk-axiomate/.cache/<version>-<target>/ so subsequent runs are no-ops.
// We invoke it here too so a fresh `pnpm run package:win` works without
// prior bootstrap. Fail-soft: if download fails, skip the copy.
{
  console.log('  Ensuring rtk-axiomate is built ...')
  const fetchResult = Bun.spawnSync(
    ['pnpm', '--filter', 'rtk-axiomate', 'run', 'build'],
    { cwd: root, env: spawnEnv(), stdio: ['ignore', 'inherit', 'inherit'] },
  )
  if (fetchResult.exitCode !== 0) {
    console.log('  ⊘ rtk-axiomate build failed — bundling skipped')
  } else {
    const rtkSrc = join(root, 'rtk-axiomate', 'bin', 'rtk.exe')
    if (existsSync(rtkSrc)) {
      copyFileSync(rtkSrc, join(distDir, 'rtk.exe'))
      console.log('  ✓ rtk.exe')
    } else {
      console.log('  ⊘ rtk.exe (rtk-axiomate/bin/ empty after build; bundling skipped)')
    }
  }
}

// Bundle agent-browser binary alongside axiomate.exe — same resolution model
// as rtk/rg (see agent-browser-axiomate/index.js + browser-bridge resolver).
// The workspace package's `build` fetches the pinned binary into bin/.
{
  console.log('  Ensuring agent-browser-axiomate is built ...')
  const fetchResult = Bun.spawnSync(
    ['pnpm', '--filter', 'agent-browser-axiomate', 'run', 'build'],
    { cwd: root, env: spawnEnv(), stdio: ['ignore', 'inherit', 'inherit'] },
  )
  if (fetchResult.exitCode !== 0) {
    console.log('  ⊘ agent-browser-axiomate build failed — bundling skipped')
  } else {
    const abSrc = join(root, 'agent-browser-axiomate', 'bin', 'agent-browser.exe')
    if (existsSync(abSrc)) {
      copyFileSync(abSrc, join(distDir, 'agent-browser.exe'))
      console.log('  ✓ agent-browser.exe')
    } else {
      console.log('  ⊘ agent-browser.exe (agent-browser-axiomate/bin/ empty after build; bundling skipped)')
    }
  }
}

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
