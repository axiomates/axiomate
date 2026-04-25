/**
 * Package axiomate as a standalone macOS executable.
 *
 * Steps:
 *   0. Clean dist/ and pre-build workspace packages that need compilation.
 *   1. Bun.build() API - bundle all JS (including npm deps) into a single file.
 *   2. bun build --compile - compile the bundled JS into dist/axiomate.
 *   3. Copy native .node/.dylib files alongside the executable.
 *
 * Usage: bun run package:mac
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'fs'
import { arch, platform } from 'os'
import { basename, dirname, join, resolve } from 'path'
import { getBuildDefine, parseFeatures, printBuildFeatures } from './buildConfig.ts'
import { nativeExeDirPlugin } from './bunPluginNativeExeDir.ts'
import { makeComputerUseStubPlugin } from './bunPluginComputerUseStub.ts'

if (platform() !== 'darwin') {
  console.error('package:mac must be run on macOS.')
  process.exit(1)
}

const agentDir = dirname(import.meta.path)
const pkg = JSON.parse(readFileSync(join(agentDir, 'package.json'), 'utf-8'))
const root = resolve(agentDir, '..')
const distDir = join(agentDir, 'dist')
const macArch = arch() === 'arm64' ? 'arm64' : 'x64'
const sharpArch = arch() === 'arm64' ? 'arm64' : 'x64'
const nodePlatformArch = `darwin-${macArch}`
const rustTarget = arch() === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'

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
  rmSync(join(root, name, generatedDts), { force: true })
}

function copyIfExists(relPath: string, destName = basename(relPath)) {
  const srcPath = join(root, relPath)
  if (!existsSync(srcPath)) {
    console.log(`  SKIP ${relPath} (not found)`)
    return false
  }

  copyFileSync(srcPath, join(distDir, destName))
  console.log(`  OK ${destName}`)
  return true
}

function copyWorkspaceNativeFiles(workspace: string) {
  const workspaceDir = join(root, workspace)
  for (const file of readdirSync(workspaceDir)) {
    if (file.endsWith('.node')) {
      copyFileSync(join(workspaceDir, file), join(distDir, file))
      console.log(`  OK ${file}`)

      const platformFile = `${workspace}.${nodePlatformArch}.node`
      if (file !== platformFile) {
        copyFileSync(join(workspaceDir, file), join(distDir, platformFile))
        console.log(`  OK ${platformFile}`)
      }
    }
  }
}

function runOptionalStep(label: string, command: string[], cwd: string) {
  const proc = Bun.spawnSync(command, {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  if (proc.exitCode === 0) {
    console.log(`  OK ${label}`)
  } else {
    console.log(`  SKIP ${label}`)
  }
}

// -- Step 0: Pre-build workspace packages -------------------------------------

console.log('Step 0/4: Pre-building workspace packages ...')

console.log('  Cleaning dist/ ...')
rmSync(distDir, { recursive: true, force: true })
mkdirSync(distDir, { recursive: true })

buildTscWorkspace('clipboard-axiomate')
buildTscWorkspace('treeify-axiomate')
buildTscWorkspace('sandbox-axiomate')
buildTscWorkspace('mcpb-axiomate')
buildTscWorkspace('computer-use-dispatch-axiomate')
buildTscWorkspace('image-processor-axiomate')
buildTscWorkspace('computer-use-native-axiomate')

buildNapiWorkspace('clipboard-axiomate')
buildNapiWorkspace('audio-capture-axiomate')
buildNapiWorkspace('modifiers-mac-napi-axiomate')
buildNapiWorkspace('url-handler-mac-napi-axiomate')

// -- Step 1: Bundle everything into a single JS file --------------------------

console.log('\nStep 1/4: Bundling all modules into dist/cli.js ...')

// DARWIN unlocks the computer-use module via feature('DARWIN') guards in
// builtinTools.ts. Always-on for mac packaging.
const features = parseFeatures(Bun.argv, process.env, ['DARWIN'])
printBuildFeatures('package:mac', features)

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
  external: [],

  // Rewrite literal .node imports to load from <exeDir>/<basename>.node
  // at runtime (Bun's virtual-path resolver can't reach the real files).
  // Computer-use stub disabled on darwin: real source tree is bundled.
  plugins: [nativeExeDirPlugin, makeComputerUseStubPlugin(false)],
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
  env: { ...process.env },
})

if (proc.exitCode !== 0) {
  console.error(`Compile failed with exit code ${proc.exitCode}`)
  process.exit(1)
}

runOptionalStep(
  'removed Bun placeholder code signature',
  ['codesign', '--remove-signature', executablePath],
  agentDir,
)
runBuildStep('axiomate (ad-hoc codesign)', ['codesign', '--force', '--sign', '-', executablePath], agentDir)

// -- Step 3: Copy native .node/.dylib files alongside the executable ----------

console.log('\nStep 3/4: Copying native files ...')

copyIfExists(`node_modules/@img/sharp-darwin-${sharpArch}/lib/sharp-darwin-${sharpArch}.node`)
if (copyIfExists(`node_modules/@img/sharp-libvips-darwin-${sharpArch}/lib/libvips-cpp.42.dylib`)) {
  runOptionalStep(
    `patched sharp rpath for libvips`,
    [
      'install_name_tool',
      '-change',
      '@rpath/libvips-cpp.42.dylib',
      '@loader_path/libvips-cpp.42.dylib',
      join(distDir, `sharp-darwin-${sharpArch}.node`),
    ],
    agentDir,
  )
}

copyIfExists('node_modules/@nut-tree-fork/libnut-darwin/build/Release/libnut.node')
copyIfExists('node_modules/@nut-tree-fork/node-mac-permissions/build/Release/permissions.node')
copyIfExists(`node_modules/node-screenshots-darwin-${macArch}/node-screenshots.${nodePlatformArch}.node`)

copyWorkspaceNativeFiles('clipboard-axiomate')
copyWorkspaceNativeFiles('audio-capture-axiomate')
copyWorkspaceNativeFiles('modifiers-mac-napi-axiomate')
copyWorkspaceNativeFiles('url-handler-mac-napi-axiomate')

const bundledCliPath = join(distDir, 'cli.js')
if (existsSync(bundledCliPath)) {
  unlinkSync(bundledCliPath)
  console.log('  OK removed intermediate cli.js')
}

// -- Step 4: Summary ----------------------------------------------------------

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
