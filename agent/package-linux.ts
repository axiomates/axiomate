/**
 * Package axiomate as a standalone Linux executable.
 *
 * Steps:
 *   0. Clean dist/ and pre-build workspace packages that need compilation.
 *   1. Bun.build() API - bundle all JS (including npm deps) into a single file.
 *   2. bun build --compile - compile the bundled JS into dist/axiomate.
 *   3. Copy native .node/.so files alongside the executable + patchelf rpath.
 *
 * Usage: bun run package:linux
 *
 * Notes:
 *  - Linux does NOT include Computer Use. The agent's gates.ts disables the
 *    25+ desktop automation tools when process.platform !== 'darwin' &&
 *    !== 'win32'. We don't bundle nut-js, node-screenshots, or the
 *    computer-use-* workspaces — they only exist for mac/win.
 *  - sharp's Linux .node has RPATH entries pointing into the original
 *    .pnpm/<sharp-libvips>/lib tree; flattening into dist/ breaks them.
 *    We patchelf-rewrite RPATH to $ORIGIN so libvips loads from the
 *    same directory as the .node file.
 *  - audio-capture is the only first-party NAPI module on Linux.
 *  - Build matrix: x64-gnu, arm64-gnu. (musl is a follow-up — would need
 *    a separate Bun target and a separate Rust target.)
 */

import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'fs'
import { arch, platform } from 'os'
import { basename, dirname, join, resolve } from 'path'
import { getBuildDefine, parseFeatures, printBuildFeatures } from './buildConfig.ts'
import { nativeExeDirPlugin } from './bunPluginNativeExeDir.ts'
import { makeComputerUseStubPlugin } from './bunPluginComputerUseStub.ts'
import { spawnEnv } from './buildEnv.ts'
import { resetDistDir } from './buildPaths.ts'
import { locatePlatformSubpackage } from './packageNatives.ts'
import type { BunPlugin } from 'bun'

if (platform() !== 'linux') {
  console.error('package:linux must be run on Linux (or WSL).')
  process.exit(1)
}

const agentDir = dirname(import.meta.path)
const pkg = JSON.parse(readFileSync(join(agentDir, 'package.json'), 'utf-8'))
const root = resolve(agentDir, '..')
const distDir = join(agentDir, 'dist')
const agentPackageJson = join(agentDir, 'package.json')
const linuxArch = arch() === 'arm64' ? 'arm64' : 'x64'
const sharpArch = linuxArch
const nodePlatformArch = `linux-${linuxArch}-gnu`
const rustTarget = linuxArch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
const keepBundledCli = process.env.AXIOMATE_KEEP_PACKAGED_CLI === '1'
const sharpLinuxRuntimeName = `sharp-linux-${sharpArch}.node`
const sharpLibvipsSoName = 'libvips-cpp.so.42'

let versionChangelog = ''
try {
  versionChangelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf-8')
} catch {
  // CHANGELOG.md not found; release notes will be empty.
}

function runBuildStep(label: string, command: string[], cwd: string) {
  console.log(`  Building ${label} ...`)
  const proc = Bun.spawnSync(command, {
    cwd,
    env: spawnEnv(),
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  if (proc.exitCode !== 0) {
    console.error(`  ERROR ${label} failed`)
    process.exit(1)
  }
  console.log(`  OK ${label}`)
}

function buildTscWorkspace(name: string) {
  runBuildStep(`${name} (tsc)`, ['npx', 'tsc', '-p', 'tsconfig.json'], join(root, name))
}

function buildNapiWorkspace(name: string) {
  const generatedDts = '.napi-generated.d.ts'
  runBuildStep(
    `${name} (napi build ${rustTarget})`,
    ['npx', 'napi', 'build', '--release', '--target', rustTarget, '--dts', generatedDts],
    join(root, name),
  )
}

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
    console.log(`  SKIP ${subPkg}/${subPath} (not found)`)
    return false
  }
  copyFileSync(srcPath, join(distDir, destName))
  console.log(`  OK ${destName}`)
  return true
}

function copyWorkspaceNativeFiles(workspace: string) {
  const workspaceDir = join(root, workspace)
  const plainFile = `${workspace}.node`
  const platformFile = `${workspace}.${nodePlatformArch}.node`
  const preferredSource = existsSync(join(workspaceDir, platformFile))
    ? platformFile
    : existsSync(join(workspaceDir, plainFile))
      ? plainFile
      : null

  if (!preferredSource) {
    const fallback = readdirSync(workspaceDir).find(file => file.endsWith('.node'))
    if (!fallback) {
      console.log(`  SKIP ${workspace} native .node (not found)`)
      return
    }
    copyFileSync(join(workspaceDir, fallback), join(distDir, plainFile))
    console.log(`  OK ${plainFile} <- ${fallback}`)
    return
  }

  copyFileSync(join(workspaceDir, preferredSource), join(distDir, plainFile))
  console.log(
    preferredSource === plainFile
      ? `  OK ${plainFile}`
      : `  OK ${plainFile} <- ${preferredSource}`,
  )
}

function runOptionalStep(label: string, command: string[], cwd: string) {
  const proc = Bun.spawnSync(command, {
    cwd,
    env: spawnEnv(),
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  if (proc.exitCode === 0) {
    console.log(`  OK ${label}`)
  } else {
    console.log(`  SKIP ${label}`)
  }
}

const sharpLinuxRuntimePlugin: BunPlugin = {
  name: 'sharp-linux-runtime',
  setup(build) {
    build.onLoad({ filter: /sharp(?:[\\/]|-)lib[\\/]sharp\.js$/ }, () => ({
      contents:
        "'use strict';\n" +
        "const { dirname, join } = require('node:path');\n" +
        "const exeDir = dirname(process.execPath);\n" +
        "const runtimeName = " + JSON.stringify(sharpLinuxRuntimeName) + ";\n" +
        "try {\n" +
        "  module.exports = require(join(exeDir, runtimeName));\n" +
        "} catch (err) {\n" +
        "  const help = [\n" +
        "    'Could not load the \"sharp\" module using the " + nodePlatformArch + " runtime',\n" +
        "    err && err.message ? err.message : String(err),\n" +
        "    'Expected native file: ' + join(exeDir, runtimeName)\n" +
        "  ];\n" +
        "  throw new Error(help.join('\\n'));\n" +
        "}\n",
      loader: 'js',
    }))
  },
}

// -- Step 0: Pre-build workspace packages -------------------------------------

console.log('Step 0/4: Pre-building workspace packages ...')

console.log('  Cleaning dist/ ...')
resetDistDir(distDir)

// Same tsc workspaces as mac/win — pure-JS, cross-platform.
buildTscWorkspace('clipboard-axiomate')
buildTscWorkspace('treeify-axiomate')
buildTscWorkspace('sandbox-axiomate')
buildTscWorkspace('mcpb-axiomate')
buildTscWorkspace('computer-use-mcp-axiomate')
buildTscWorkspace('browser-bridge-axiomate')
buildTscWorkspace('image-processor-axiomate')

// audio-capture is the only first-party NAPI on Linux. clipboard-axiomate's
// native build is mac-only; on Linux we ship its TS-only fallback that shells
// out to xclip / wl-paste.
buildNapiWorkspace('audio-capture-axiomate')

// -- Step 1: Bundle everything into a single JS file --------------------------

console.log('\nStep 1/4: Bundling all modules into dist/cli.js ...')

// No DARWIN or WIN32 feature on Linux. The computer-use stub plugin fills in
// the gap so feature('DARWIN')/feature('WIN32') call sites compile away.
const features = parseFeatures(Bun.argv, process.env, [])
printBuildFeatures('package:linux', features)

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

  // Bun compiled binaries resolve bundled JS from a virtual path, so runtime
  // npm packages should be bundled. Native addons are copied beside the binary.
  // mac-only and win-only workspaces stay external so the bundler DCEs them
  // (gated by feature('DARWIN') / feature('WIN32') call sites that are
  // never set on Linux).
  external: [
    'modifiers-mac-napi-axiomate',         // macOS-only
    'url-handler-mac-napi-axiomate',       // macOS-only
    'computer-use-mac-napi-axiomate',      // macOS-only
    'computer-use-win-napi-axiomate',      // Windows-only
    'computer-use-mcp-axiomate',           // workspace pkg (loaded via stub on linux)
    'browser-bridge-axiomate',             // workspace pkg
    'agent-browser-axiomate',              // sidecar binary resolver (createRequire at runtime)
    'rtk-axiomate',                        // see build.ts external list
  ],

  // Rewrite literal .node imports to load from <exeDir>/<basename>.node
  // at runtime (Bun's virtual-path resolver can't reach the real files).
  // Computer-use stub enabled on Linux: the real source tree is mac/win-only,
  // so we replace it with a no-op export. gates.ts already disables tool
  // surface; this just prevents the unreachable imports from breaking the
  // bundler.
  plugins: [nativeExeDirPlugin, sharpLinuxRuntimePlugin, makeComputerUseStubPlugin(true)],
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

// -- Step 2: Compile bundled JS into standalone executable --------------------

console.log('\nStep 2/4: Compiling dist/cli.js -> dist/axiomate ...')

const executablePath = join(distDir, 'axiomate')
const proc = Bun.spawnSync([
  Bun.argv[0], 'build',
  'dist/cli.js',
  '--compile',
  '--outfile', 'dist/axiomate',
  '--target', 'bun',
], {
  cwd: agentDir,
  stdio: ['inherit', 'inherit', 'inherit'],
  env: spawnEnv(),
})

if (proc.exitCode !== 0) {
  console.error(`Compile failed with exit code ${proc.exitCode}`)
  process.exit(1)
}

// -- Step 3: Copy native files alongside the executable + patchelf rpath ------

console.log('\nStep 3/4: Copying native files ...')

const sharpCopied = copyFromPlatformSubpackage(
  'sharp',
  `@img/sharp-linux-${sharpArch}`,
  `lib/${sharpLinuxRuntimeName}`,
  sharpLinuxRuntimeName,
)
const libvipsCopied = copyFromPlatformSubpackage(
  'sharp',
  `@img/sharp-libvips-linux-${sharpArch}`,
  `lib/${sharpLibvipsSoName}`,
)

// Rewrite RPATH on the sharp native so it finds libvips beside it instead of
// in the original .pnpm/<...>/lib tree. Without this, sharp throws
// `libvips-cpp.so.42: cannot open shared object file` when the user moves
// axiomate to /opt/, /usr/local/bin/, etc.
if (sharpCopied && libvipsCopied) {
  runBuildStep(
    `patched sharp RPATH for libvips ($ORIGIN)`,
    ['patchelf', '--set-rpath', '$ORIGIN', join(distDir, sharpLinuxRuntimeName)],
    agentDir,
  )
}

// Bundle ripgrep binary alongside the axiomate executable. See package-win.ts
// for full rationale — same pattern, platform-specific subpackage resolved
// at packaging time via packageNatives.ts, found at runtime via
// dirname(process.execPath).
copyFromPlatformSubpackage(
  '@vscode/ripgrep',
  `@vscode/ripgrep-linux-${linuxArch}`,
  'bin/rg',
)

// Bundle rtk binary alongside the axiomate executable. See package-win.ts
// for full rationale on the workspace-package indirection.
{
  console.log('  Ensuring rtk-axiomate is built ...')
  const fetchResult = Bun.spawnSync(
    ['pnpm', '--filter', 'rtk-axiomate', 'run', 'build'],
    { cwd: root, env: spawnEnv(), stdio: ['ignore', 'inherit', 'inherit'] },
  )
  if (fetchResult.exitCode !== 0) {
    console.log('  ⊘ rtk-axiomate build failed — bundling skipped')
  } else {
    const rtkSrc = join(root, 'rtk-axiomate', 'bin', 'rtk')
    if (existsSync(rtkSrc)) {
      copyFileSync(rtkSrc, join(distDir, 'rtk'))
      console.log('  ✓ rtk')
    } else {
      console.log('  ⊘ rtk (rtk-axiomate/bin/ empty after build; bundling skipped)')
    }
  }
}

// Bundle agent-browser binary alongside the axiomate executable — same model
// as rtk/rg (agent-browser-axiomate/index.js + browser-bridge resolver).
{
  console.log('  Ensuring agent-browser-axiomate is built ...')
  const fetchResult = Bun.spawnSync(
    ['pnpm', '--filter', 'agent-browser-axiomate', 'run', 'build'],
    { cwd: root, env: spawnEnv(), stdio: ['ignore', 'inherit', 'inherit'] },
  )
  if (fetchResult.exitCode !== 0) {
    console.log('  ⊘ agent-browser-axiomate build failed — bundling skipped')
  } else {
    const abSrc = join(root, 'agent-browser-axiomate', 'bin', 'agent-browser')
    if (existsSync(abSrc)) {
      copyFileSync(abSrc, join(distDir, 'agent-browser'))
      console.log('  ✓ agent-browser')
    } else {
      console.log('  ⊘ agent-browser (agent-browser-axiomate/bin/ empty after build; bundling skipped)')
    }
  }
}

copyWorkspaceNativeFiles('audio-capture-axiomate')

const bundledCliPath = join(distDir, 'cli.js')
if (existsSync(bundledCliPath)) {
  if (keepBundledCli) {
    console.log('  OK kept intermediate cli.js (AXIOMATE_KEEP_PACKAGED_CLI=1)')
  } else {
    unlinkSync(bundledCliPath)
    console.log('  OK removed intermediate cli.js')
  }
}

// -- Step 4: Summary ----------------------------------------------------------

console.log('\nStep 4/4: Summary')
console.log('\nBuild complete.\n')

if (existsSync(executablePath)) {
  const stat = statSync(executablePath)
  console.log(`  ${executablePath}  (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
}

const distFiles = new Bun.Glob('*').scanSync(distDir)
let totalSize = 0
for (const file of distFiles) {
  const filePath = join(distDir, file)
  const s = statSync(filePath)
  if (s.isFile()) totalSize += s.size
}
console.log(`  Total dist/ size: ${(totalSize / 1024 / 1024).toFixed(1)} MB`)
