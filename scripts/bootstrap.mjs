#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, platform } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const rawArgs = process.argv.slice(2)
const args = new Set(rawArgs)

const isWindows = platform() === 'win32'
const isMac = platform() === 'darwin'
const isLinux = platform() === 'linux'

const MIN_PNPM_MAJOR = 11
const PNPM_INSTALL_TARGET = 'pnpm@11'

const options = {
  checkOnly: args.has('--check'),
  skipTools: args.has('--skip-tools'),
  skipBun: args.has('--skip-bun'),
  skipRust: args.has('--skip-rust'),
  skipInstall: args.has('--skip-install'),
  noBuild: args.has('--no-build'),
  noAgentBuild: args.has('--no-agent-build'),
  // Native NAPI modules ship with axiomate (audio-capture cross-platform;
  // mac adds clipboard/modifiers/url-handler/computer-use). Bootstrap is
  // a one-shot setup command — building them by default is the right
  // behavior. `--no-native` lets pure-JS developers skip the Rust step.
  native: !args.has('--no-native'),
}

if (args.has('--help') || args.has('-h')) {
  printHelp()
  process.exit(0)
}

let failures = 0
let warnings = 0

main()

function main() {
  section('System')
  checkVersion('node', ['--version'], { required: true, minMajor: 20 })
  // npm is required ONLY as the install path for pnpm (see ensurePnpm
  // below — `npm install -g pnpm`). axiomate's runtime + workspace
  // tooling is fully on pnpm; npm is never invoked after bootstrap.
  // Alternative install paths (corepack, standalone installer, brew/
  // winget/scoop) work too — if you have pnpm via any of those,
  // ensurePnpm short-circuits and npm just sits unused.
  checkVersion('npm', ['--version'], { required: true })
  checkVersion('git', ['--version'], { required: true })

  section('Toolchain')
  ensurePnpm()
  ensureBun()
  ensureRust()
  ensureVcBuildTools()
  checkPlatformPrerequisites()

  section('Dependencies')
  if (!options.checkOnly && !options.skipInstall) {
    run('pnpm', ['install'])
  } else {
    note(options.checkOnly ? 'Check mode: skipping pnpm install.' : 'Skipping pnpm install.')
  }
  verifyNodeModules()
  verifyTransitivePackages()

  if (failures > 0) {
    printSummary()
    return
  }

  if (!options.checkOnly && !options.noBuild) {
    section('Build')
    buildJsWorkspaces()

    if (options.native) {
      buildNativeWorkspaces()
      smokeTestNapiBindings()
    } else {
      note('Skipping native NAPI builds (--no-native).')
    }

    if (!options.noAgentBuild) {
      run('pnpm', ['run', 'build:agent'])
      run('pnpm', ['run', 'build:sdk'])
    } else {
      note('Skipping agent build.')
    }
  }

  printSummary()
}

function printSummary() {
  section('Summary')
  if (failures > 0) {
    console.error(`Found ${failures} required issue(s).`)
    process.exitCode = 1
    return
  }

  const suffix = warnings > 0 ? ` with ${warnings} warning(s)` : ''
  console.log(`${options.checkOnly ? 'Doctor check' : 'Bootstrap'} complete${suffix}.`)
}

function printHelp() {
  console.log(`Usage: node scripts/bootstrap.mjs [options]

Options:
  --check          Check the environment only. Used by pnpm doctor.
  --skip-tools     Do not auto-install Bun or Rust.
  --skip-bun       Do not auto-install Bun.
  --skip-rust      Do not auto-install Rust.
  --skip-install   Do not run pnpm install.
  --no-build       Do not build workspaces or the agent.
  --no-agent-build Build support workspaces only.
  --no-native      Skip platform native NAPI module builds (Rust optional).
`)
}

function section(title) {
  console.log(`\n== ${title} ==`)
}

function ok(message) {
  console.log(`OK   ${message}`)
}

function note(message) {
  console.log(`INFO ${message}`)
}

function warn(message) {
  warnings += 1
  console.warn(`WARN ${message}`)
}

function fail(message) {
  failures += 1
  console.error(`FAIL ${message}`)
}

function envWithToolPaths() {
  const env = { ...process.env }
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH'
  const home = homedir()
  const extras = [
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
  ]
  env[pathKey] = `${extras.join(delimiter)}${delimiter}${env[pathKey] || ''}`
  return env
}

function executable(command) {
  return command
}

function invocation(command, commandArgs) {
  if (command === 'bun') {
    const bun = bunPath()
    if (bun) {
      return {
        command: bun,
        args: commandArgs,
      }
    }
  }

  // npm has a special dispatch path on non-windows: route through Node +
  // npm-cli.js to avoid space-in-path issues with `npm` shim on
  // Program Files\nodejs\. Windows path falls through to the generic
  // PATHEXT-resolution branch below.
  if (command === 'npm' && !isWindows) {
    const npmCli = npmCliPath()
    if (npmCli) {
      return {
        command: process.execPath,
        args: [npmCli, ...commandArgs],
      }
    }
  }

  // Windows: explicitly wrap in `cmd.exe /d /s /c` so .cmd / .ps1 / .bat
  // shims (pnpm, npm, npx, winget) resolve via PATHEXT. This is what
  // Node does internally when `shell: true` is set, but doing it
  // manually keeps the spawn call at `shell: false` (avoiding Node 22+
  // DEP0190: shell:true + array args). Node 22+ also refuses to spawn
  // .cmd files directly via execFile semantics post-CVE-2024-27980, so
  // walking PATH × PATHEXT to a literal `.CMD` path doesn't work either.
  //
  // /d : ignore AutoRun command from registry (faster, deterministic)
  // /s : strict-quote rules (KB 64972) — our quoting matches cmd's view
  // /c : run command and exit
  if (isWindows) {
    const quoted = [executable(command), ...commandArgs].map(quoteCmdArg).join(' ')
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', quoted],
    }
  }

  return {
    command: executable(command),
    args: commandArgs,
  }
}

/**
 * Quote a single token for cmd.exe consumption. Most args are token-safe
 * and pass through unchanged. Args containing whitespace / cmd-special
 * chars get wrapped in double quotes; embedded double quotes are doubled
 * (cmd.exe convention) — this is the inverse of the cmd.exe parser
 * documented in MSDN's "Parsing C Command-Line Arguments".
 */
function quoteCmdArg(s) {
  if (typeof s !== 'string') s = String(s)
  if (s.length === 0) return '""'
  if (!/[\s"&|<>^%!()]/.test(s)) return s
  return `"${s.replace(/"/g, '""')}"`
}

function bunPath() {
  const candidates = [
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, 'bin', isWindows ? 'bun.exe' : 'bun') : null,
    join(homedir(), '.bun', 'bin', isWindows ? 'bun.exe' : 'bun'),
    isWindows ? join(dirname(process.execPath), 'node_modules', 'bun', 'bin', 'bun.exe') : null,
  ].filter(Boolean)

  return candidates.find(candidate => existsSync(candidate)) || null
}

function npmCliPath() {
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    return process.env.npm_execpath
  }

  const candidate = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(candidate) ? candidate : null
}

function spawn(command, commandArgs = [], extra = {}) {
  const call = invocation(command, commandArgs)
  return spawnSync(call.command, call.args, {
    cwd: extra.cwd || rootDir,
    env: envWithToolPaths(),
    encoding: extra.encoding || 'utf8',
    stdio: extra.stdio || 'pipe',
    // shell:false everywhere. Windows .cmd / .ps1 / .bat resolution
    // happens in `resolveWindowsExecutable()` (called from invocation())
    // — bypassing the cmd.exe / sh -c hop avoids Node 22+ DEP0190
    // (shell:true + array args).
    shell: extra.shell ?? false,
  })
}

function run(command, commandArgs = [], extra = {}) {
  const shown = [command, ...commandArgs].join(' ')
  console.log(`> ${shown}`)

  const call = invocation(command, commandArgs)
  const result = spawnSync(call.command, call.args, {
    cwd: extra.cwd || rootDir,
    env: envWithToolPaths(),
    stdio: 'inherit',
    // Same shell:false rationale as spawn() above.
    shell: extra.shell ?? false,
  })

  if (result.status === 0) return true

  const message = result.error
    ? `${shown} failed: ${result.error.message}`
    : `${shown} exited with code ${result.status}`

  if (extra.allowFail) {
    warn(message)
    return false
  }

  console.error(`ERROR ${message}`)
  process.exit(result.status || 1)
}

function commandExists(command, commandArgs = ['--version']) {
  const result = spawn(command, commandArgs)
  return result.status === 0
}

function commandText(command, commandArgs = ['--version']) {
  const result = spawn(command, commandArgs)
  if (result.status !== 0) return null
  return `${result.stdout || ''}${result.stderr || ''}`.trim()
}

function checkVersion(command, commandArgs, { required = false, minMajor } = {}) {
  const text = commandText(command, commandArgs)
  if (!text) {
    if (required) fail(`${command} is not available on PATH.`)
    else warn(`${command} is not available on PATH.`)
    return false
  }

  const firstLine = text.split(/\r?\n/)[0]
  if (minMajor !== undefined) {
    const major = parseMajor(firstLine)
    if (major !== null && major < minMajor) {
      fail(`${command} ${firstLine} is too old. Use ${command} ${minMajor}+.`)
      return false
    }
  }

  ok(`${command}: ${firstLine}`)
  return true
}

function parseMajor(text) {
  const match = text.match(/v?(\d+)/)
  return match ? Number(match[1]) : null
}

function ensurePnpm() {
  const version = commandText('pnpm', ['--version'])
  if (version) {
    const firstLine = version.split(/\r?\n/)[0]
    const major = parseMajor(firstLine)
    if (major !== null && major >= MIN_PNPM_MAJOR) {
      ok(`pnpm: ${firstLine}`)
      return
    }
    if (options.checkOnly || options.skipTools || options.skipInstall) {
      fail(`pnpm ${firstLine} is too old. pnpm ${MIN_PNPM_MAJOR}+ required. Upgrade with: npm install -g ${PNPM_INSTALL_TARGET}`)
      return
    }
    note(`Upgrading pnpm from ${firstLine} to ${MIN_PNPM_MAJOR}+ via npm...`)
    run('npm', ['install', '-g', PNPM_INSTALL_TARGET])
    if (!checkVersion('pnpm', ['--version'], { required: false, minMajor: MIN_PNPM_MAJOR })) {
      failAndExit(`pnpm upgrade attempted but version still below ${MIN_PNPM_MAJOR}. Restart the terminal or check global npm bin in PATH.`)
    }
    return
  }

  if (options.checkOnly || options.skipTools || options.skipInstall) {
    fail(`pnpm ${MIN_PNPM_MAJOR}+ is required. Install with: npm install -g ${PNPM_INSTALL_TARGET}`)
    return
  }

  // We use npm here as the bootstrap install path because every Node
  // install ships npm — zero extra prereq. Other valid pnpm install
  // paths (corepack enable pnpm; brew install pnpm; standalone
  // installer at https://pnpm.io/installation) work fine — this
  // function only fires when `pnpm --version` already failed.
  // We pin to pnpm@11 rather than @latest because pnpm 12+ may ship
  // breaking config changes — bumping the floor should be a deliberate
  // repo-wide migration, not an opportunistic auto-upgrade.
  note('Installing pnpm globally via npm...')
  run('npm', ['install', '-g', PNPM_INSTALL_TARGET])

  if (!checkVersion('pnpm', ['--version'], { required: false, minMajor: MIN_PNPM_MAJOR })) {
    failAndExit('pnpm installed, but this terminal cannot find it. Restart the terminal or check global npm bin in PATH.')
  }
}

function ensureBun() {
  const version = commandText('bun', ['--version'])
  if (version) {
    const bunPath = commandText(
      isWindows ? 'where' : 'which',
      ['bun'],
    )
    // WSL trap: Windows installs of Node typically bundle bun.exe and
    // expose it on PATH from `/mnt/c/`. From WSL that bun runs under
    // Wine/Win32 semantics (process.platform === 'win32', UNC-path
    // errors on workspace dirs). Treat a `/mnt/` path on Linux as
    // "not installed natively" so we install a real Linux Bun.
    const firstPath = bunPath?.split(/\r?\n/)[0]?.trim()
    const isCrossPlatformBun =
      isLinux && firstPath && (firstPath.startsWith('/mnt/') || firstPath.endsWith('.exe'))
    if (!isCrossPlatformBun) {
      ok(`bun: ${version.split(/\r?\n/)[0]}`)
      return
    }
    note(
      `Detected Windows Bun at ${firstPath} via WSL PATH passthrough — installing a native Linux Bun.`,
    )
  }

  const needsBun = options.checkOnly || (!options.noBuild && !options.noAgentBuild)
  if (!needsBun) {
    note('Skipping Bun check because the agent build is disabled.')
    return
  }

  const shouldInstall = !options.checkOnly && !options.skipTools && !options.skipBun
  if (!shouldInstall) {
    fail('Bun is required for agent/build.ts. Install Bun or run pnpm bootstrap without --skip-tools.')
    return
  }

  note('Installing Bun...')
  if (isWindows) {
    run('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'irm bun.sh/install.ps1 | iex',
    ], { shell: false })
  } else {
    if (!commandExists('curl')) failAndExit('curl is required to install Bun.')
    if (!commandExists('bash')) failAndExit('bash is required to install Bun.')
    if (isLinux && !commandExists('unzip', ['-v'])) {
      warn('Bun installer needs unzip on Linux. Install it with your system package manager if installation fails.')
    }
    run('bash', ['-lc', 'curl -fsSL https://bun.com/install | bash'])
  }

  if (!checkVersion('bun', ['--version'], { required: false })) {
    failAndExit('Bun installed, but this terminal cannot find it. Restart the terminal or add ~/.bun/bin to PATH.')
  }
}

function ensureRust() {
  const rustcVersion = commandText('rustc', ['--version'])
  const cargoVersion = commandText('cargo', ['--version'])
  const rustcOk = Boolean(rustcVersion)
  const cargoOk = Boolean(cargoVersion)
  if (rustcVersion) ok(`rustc: ${rustcVersion.split(/\r?\n/)[0]}`)
  if (cargoVersion) ok(`cargo: ${cargoVersion.split(/\r?\n/)[0]}`)
  if (rustcOk && cargoOk) return

  const shouldInstall = !options.checkOnly && !options.skipTools && !options.skipRust
  const shouldReport = options.checkOnly || options.native || shouldInstall
  if (!shouldReport) {
    note('Skipping Rust check because native builds are disabled.')
    return
  }

  if (!shouldInstall) {
    warn('Rust is missing. It is needed for native audio and packaging, but not for JS-only builds.')
    return
  }

  note('Installing Rust with rustup...')
  if (isWindows) {
    run('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      "$ErrorActionPreference='Stop'; $p=Join-Path $env:TEMP 'rustup-init.exe'; Invoke-WebRequest -Uri https://win.rustup.rs -OutFile $p; & $p -y --default-toolchain stable",
    ], { shell: false })
  } else {
    if (!commandExists('curl')) failAndExit('curl is required to install Rust.')
    if (!commandExists('sh', ['-c', 'true'])) failAndExit('sh is required to install Rust.')
    run('sh', ['-c', "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"])
  }

  if (!checkVersion('rustc', ['--version'], { required: false }) || !checkVersion('cargo', ['--version'], { required: false })) {
    failAndExit('Rust installed, but this terminal cannot find it. Restart the terminal or add ~/.cargo/bin to PATH.')
  }
}

function ensureVcBuildTools() {
  if (!isWindows) return
  const detected = detectVcBuildTools()
  if (detected) {
    ok(`Visual Studio Build Tools (C++ workload): ${detected}`)
    return
  }
  if (options.checkOnly || options.skipTools) {
    warn(
      'Visual Studio 2022 Build Tools (C++ workload) not detected. ' +
      'Native Rust crates will fail to link. Install with: ' +
      'winget install --id Microsoft.VisualStudio.2022.BuildTools ' +
      '--override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive"',
    )
    return
  }
  if (!commandExists('winget')) {
    warn(
      'Visual Studio 2022 Build Tools (C++ workload) not detected and `winget` ' +
      'is unavailable on this system. Install manually from ' +
      'https://aka.ms/vs/17/release/vs_BuildTools.exe and re-run bootstrap.',
    )
    return
  }
  note('Installing Visual Studio 2022 Build Tools (C++ workload) via winget...')
  // --override is a single string passed verbatim to the installer; --passive
  // shows progress without blocking on UI. accept-* avoids the y/N prompts.
  const result = run(
    'winget',
    [
      'install',
      '--id', 'Microsoft.VisualStudio.2022.BuildTools',
      '--source', 'winget',
      '--override',
      '--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive',
      '--accept-package-agreements',
      '--accept-source-agreements',
    ],
    { allowFail: true },
  )
  if (!result) {
    warn('winget exit code non-zero — install may have partially succeeded. ' +
         'Re-run bootstrap; if VS Build Tools still missing, install manually.')
    return
  }
  if (!detectVcBuildTools()) {
    failAndExit('VS Build Tools install completed but post-check finds nothing. ' +
                'Restart the terminal so the Installer registry entries become visible.')
  }
}

/**
 * Three-tier VS Build Tools probe (most reliable → fallback):
 *   1. vswhere.exe (VS Installer's own enumerator, ships at a fixed path)
 *   2. cl.exe on PATH (only true inside a VS Developer shell, but valid)
 *   3. registry entry HKLM\SOFTWARE\Microsoft\VisualStudio\Setup
 *
 * Returns the install path on success or null when none match. The
 * returned string is purely diagnostic — callers only check truthy/null.
 */
function detectVcBuildTools() {
  if (!isWindows) return null

  // Tier 1: vswhere.exe — Microsoft's official enumerator. Ships with
  // any VS Installer at a fixed Program Files (x86) path.
  const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe'
  if (existsSync(vswhere)) {
    const result = spawnSync(vswhere, [
      '-products', '*',
      '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property', 'installationPath',
      '-format', 'value',
    ], { encoding: 'utf8' })
    if (result.status === 0) {
      const first = (result.stdout || '').split(/\r?\n/).map(s => s.trim()).find(Boolean)
      if (first) return first
    }
  }

  // Tier 2: cl.exe in PATH — uncommon outside a Developer shell but
  // unambiguous when present.
  if (commandExists('where.exe', ['cl'])) return 'cl.exe on PATH'

  // Tier 3: VS Installer registry shared-installation-path probe. Even
  // when VC++ workload isn't perfectly identified above, this catches
  // the broader "any VS install present" case so we don't redundantly
  // re-install. `reg query` is on every Windows.
  const reg = spawnSync('reg', [
    'query',
    'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\Setup',
    '/v', 'SharedInstallationPath',
    '/reg:64',
  ], { encoding: 'utf8' })
  if (reg.status === 0 && /SharedInstallationPath/.test(reg.stdout || '')) {
    return 'VS Installer registry entry'
  }

  return null
}

function checkPlatformPrerequisites() {
  if (!options.checkOnly && !options.native) {
    note('Skipping native platform prerequisite checks.')
    return
  }

  if (isMac) {
    if (!commandExists('xcode-select', ['-p'])) {
      warn('macOS native builds need Xcode Command Line Tools. Run: xcode-select --install')
    } else {
      ok('macOS Xcode Command Line Tools detected.')
    }
    return
  }

  if (isWindows) {
    // VS Build Tools detection + auto-install lives in ensureVcBuildTools()
    // (called earlier in the Toolchain section). Here we just ensure the
    // rust msvc target is present.
    if (!options.checkOnly && options.native && commandExists('rustup')) {
      run('rustup', ['target', 'add', 'x86_64-pc-windows-msvc'], { allowFail: true })
    }
    return
  }

  if (isLinux) {
    if (!commandExists('cc')) warn('Linux native builds need a C compiler. Debian/Ubuntu: sudo apt install build-essential')
    if (!commandExists('pkg-config')) warn('Linux native builds often need pkg-config. Debian/Ubuntu: sudo apt install pkg-config')
    if (!commandExists('xclip') && !commandExists('wl-paste')) {
      warn('Linux clipboard image fallback needs xclip or wl-clipboard.')
    }
  }
}

function verifyNodeModules() {
  const nodeModules = join(rootDir, 'node_modules')

  if (!existsPath(nodeModules)) {
    fail('node_modules is missing. Run pnpm install or pnpm bootstrap.')
    return
  }
  ok('node_modules exists.')
}

function verifyTransitivePackages() {
  const packages = [
    'lodash.debounce',
    'proxy-from-env',
    'combined-stream',
    'hasown',
    'json-schema-traverse',
    'shebang-regex',
  ]

  const missing = packages.filter(name => !canResolvePackage(name))
  if (missing.length === 0) {
    ok('Bun-sensitive transitive packages resolve from pnpm install.')
    return
  }

  fail(`Missing transitive packages: ${missing.join(', ')}. Run pnpm install from the repo root.`)
}

function canResolvePackage(name) {
  try {
    require.resolve(`${name}/package.json`, { paths: [rootDir] })
    return true
  } catch {
    try {
      require.resolve(name, { paths: [rootDir] })
      return true
    } catch {
      return false
    }
  }
}

function buildJsWorkspaces() {
  const builds = [
    ['clipboard-axiomate', 'build:ts-only'],
    ['treeify-axiomate', 'build'],
    ['sandbox-axiomate', 'build'],
    ['mcpb-axiomate', 'build'],
    ['computer-use-mcp-axiomate', 'build'],
    ['browser-bridge-axiomate', 'build'],
    ['image-processor-axiomate', 'build'],
    // rtk-axiomate's `build` downloads the rtk binary for the host
    // platform from axiomates/rtk's latest GitHub release. Fails soft —
    // see rtk-axiomate/scripts/fetch.mjs.
    ['rtk-axiomate', 'build'],
    // agent-browser-axiomate's `build` downloads the PINNED agent-browser
    // binary for the host platform from vercel-labs/agent-browser releases.
    // Fails soft — see agent-browser-axiomate/scripts/fetch.mjs.
    ['agent-browser-axiomate', 'build'],
  ]

  for (const [workspace, script] of builds) {
    run('pnpm', ['--filter', workspace, 'run', script])
  }
}

function buildNativeWorkspaces() {
  const builds = [['audio-capture-axiomate', 'build']]

  if (isMac) {
    builds.push(
      ['clipboard-axiomate', 'build:native'],
      ['modifiers-mac-napi-axiomate', 'build'],
      ['url-handler-mac-napi-axiomate', 'build'],
      ['computer-use-mac-napi-axiomate', 'build'],
    )
  } else if (isWindows) {
    builds.push(['computer-use-win-napi-axiomate', 'build'])
    note('Skipping macOS-only clipboard/modifier/url-handler native packages on this platform.')
  } else {
    note('Skipping macOS-only and Windows-only native packages on this platform.')
  }

  for (const [workspace, script] of builds) {
    run('pnpm', ['--filter', workspace, 'run', script])
  }
}

/**
 * Verify each freshly-built NAPI binding actually loads. Catches the class
 * of "build succeeded but the .node file isn't loadable" bug that hid for
 * months previously: silent loader filename mismatches, arch mismatches,
 * dyld errors, ABI drift, etc. Hard-fails bootstrap if any binding probes
 * to false, so the user sees the issue at install time, not weeks later
 * when a feature silently no-ops.
 *
 * Each entry is { workspace, fn, platform? }:
 *   - fn: name of an exported function that returns true iff native loaded
 *   - platform: when set, smoke-test only runs on that process.platform
 *     (mac-only NAPI packages skip on win/linux); cross-platform packages
 *     omit it
 */
function smokeTestNapiBindings() {
  const targets = [
    { workspace: 'audio-capture-axiomate', fn: 'isNativeAudioAvailable' },
    { workspace: 'clipboard-axiomate', fn: 'isAvailable', platform: 'darwin' },
    { workspace: 'modifiers-mac-napi-axiomate', fn: 'isAvailable', platform: 'darwin' },
    { workspace: 'url-handler-mac-napi-axiomate', fn: 'isAvailable', platform: 'darwin' },
    { workspace: 'computer-use-mac-napi-axiomate', fn: 'isAvailable', platform: 'darwin' },
    { workspace: 'computer-use-win-napi-axiomate', fn: 'isAvailable', platform: 'win32' },
  ]

  for (const t of targets) {
    if (t.platform && process.platform !== t.platform) {
      note(`Skipping NAPI smoke-test for ${t.workspace} on ${process.platform} (${t.platform}-only)`)
      continue
    }
    smokeTestSingleBinding(t.workspace, t.fn)
  }
}

function smokeTestSingleBinding(workspace, fnName) {
  // Probe child node process: require the package, call its
  // is-native-loaded fn, print a single JSON line. This isolates failures
  // (e.g. dyld crash) from the bootstrap process itself.
  const indexPath = join(rootDir, workspace, 'index.js')
  const probe = `(()=>{
    try {
      const m = require(${JSON.stringify(indexPath)});
      const fn = m[${JSON.stringify(fnName)}];
      const ok = typeof fn === 'function' ? !!fn() : false;
      const err = (typeof m.getLoadError === 'function') ? m.getLoadError() : null;
      console.log(JSON.stringify({ ok, error: err }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: 'require threw: ' + (e && e.message ? e.message : String(e)) }));
    }
  })()`

  const result = spawnSync('node', ['-e', probe], {
    cwd: rootDir,
    env: envWithToolPaths(),
    encoding: 'utf8',
    shell: false,
  })

  if (result.error) {
    fail(`NAPI smoke-test for ${workspace} could not spawn node: ${result.error.message}`)
    return
  }

  const out = (result.stdout || '').trim()
  let parsed
  try {
    parsed = JSON.parse(out)
  } catch {
    fail(`NAPI smoke-test for ${workspace} produced unparseable output: ${out || '(empty)'}`)
    return
  }

  if (parsed.ok) {
    ok(`NAPI smoke-test passed for ${workspace}`)
  } else {
    fail(`NAPI smoke-test failed for ${workspace}: ${parsed.error ?? 'isAvailable() returned false'}`)
  }
}

function existsPath(path) {
  try {
    return Boolean(require('node:fs').existsSync(path))
  } catch {
    return false
  }
}

function failAndExit(message) {
  console.error(`ERROR ${message}`)
  process.exit(1)
}
