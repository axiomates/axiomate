import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest'
import { runCheckpointGit } from '../../../../utils/checkpoints/git.js'
import {
  DEFAULT_EXCLUDES,
  indexPath,
  projectHash,
} from '../../../../utils/checkpoints/paths.js'
import {
  collectCheckpointFiles,
  stageWorktreeSnapshotIndex,
} from '../../../../utils/checkpoints/snapshotIndex.js'
import { ensureStore } from '../../../../utils/checkpoints/store.js'

let tmpRoot: string
let workTree: string
let storeDir: string
let indexFile: string
let originalBase: string | undefined

beforeAll(() => {
  originalBase = process.env.AXIOMATE_CHECKPOINT_BASE
})

afterAll(() => {
  if (originalBase === undefined) delete process.env.AXIOMATE_CHECKPOINT_BASE
  else process.env.AXIOMATE_CHECKPOINT_BASE = originalBase
})

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'axiomate-snapshot-index-'))
  process.env.AXIOMATE_CHECKPOINT_BASE = join(tmpRoot, 'cp')
  workTree = mkdtempSync(join(tmpRoot, 'wt-'))
  const r = await ensureStore()
  if (r.ok === false) throw new Error(`ensureStore failed: ${r.reason}`)
  storeDir = r.store
  indexFile = indexPath(projectHash(workTree))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

function touch(rel: string, content = ''): void {
  const full = join(workTree, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

async function stagedTreePaths(): Promise<string[]> {
  const writeTree = await runCheckpointGit(['write-tree'], {
    store: storeDir,
    workTree,
    indexFile,
  })
  if (writeTree.ok === false) throw new Error(writeTree.message)
  const lsTree = await runCheckpointGit(
    ['ls-tree', '-r', '-z', '--name-only', writeTree.stdout.trim()],
    { store: storeDir, workTree, indexFile },
  )
  if (lsTree.ok === false) throw new Error(lsTree.message)
  return lsTree.stdout.split('\0').filter(p => p.length > 0).sort()
}

async function showIndexPath(rel: string): Promise<string> {
  const r = await runCheckpointGit(['show', `:${rel}`], {
    store: storeDir,
    workTree,
    indexFile,
  })
  if (r.ok === false) throw new Error(r.message)
  return r.stdout
}

async function stagedTreeObjects(): Promise<Map<string, string>> {
  const lsFiles = await runCheckpointGit(['ls-files', '-s', '-z'], {
    store: storeDir,
    workTree,
    indexFile,
  })
  if (lsFiles.ok === false) throw new Error(lsFiles.message)
  return parseObjectMap(lsFiles.stdout)
}

function isolatedGitEnv(): NodeJS.ProcessEnv {
  const nullDev = process.platform === 'win32' ? 'NUL' : '/dev/null'
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: nullDev,
    GIT_CONFIG_SYSTEM: nullDev,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    env: isolatedGitEnv(),
    stdio: 'pipe',
  })
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    env: isolatedGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function gitCommit(cwd: string, message: string): void {
  git(cwd, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    message,
  ])
}

function splitGitZ(stdout: string): string[] {
  return stdout.split('\0').filter(p => p.length > 0).sort()
}

function writeDefaultExclude(repo: string): void {
  writeFileSync(
    join(repo, '.git/info/exclude'),
    DEFAULT_EXCLUDES.join('\n') + '\n',
  )
}

function gitAddOracle(cwd: string, indexName = 'oracle.index'): Map<string, string> {
  const index = join(cwd, '.git', indexName)
  execFileSync('git', ['-C', cwd, 'read-tree', '--empty'], {
    env: { ...isolatedGitEnv(), GIT_INDEX_FILE: index },
    stdio: 'pipe',
  })
  execFileSync('git', ['-C', cwd, 'add', '-A'], {
    env: { ...isolatedGitEnv(), GIT_INDEX_FILE: index },
    stdio: 'pipe',
  })
  return parseObjectMap(
    execFileSync('git', ['-C', cwd, 'ls-files', '-s', '-z'], {
      encoding: 'utf-8',
      env: { ...isolatedGitEnv(), GIT_INDEX_FILE: index },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  )
}

function liveGitAddOracle(cwd: string): Map<string, string> {
  git(cwd, ['add', '-A'])
  return parseObjectMap(gitOutput(cwd, ['ls-files', '-s', '-z']))
}

function prefixedOracle(
  prefix: string,
  oracle: Map<string, string>,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const [rel, content] of oracle) {
    out.set(`${prefix}/${rel}`, content)
  }
  return out
}

function mergeOracles(...oracles: Map<string, string>[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const oracle of oracles) {
    for (const [rel, content] of oracle) out.set(rel, content)
  }
  return out
}

function sortedEntries(map: Map<string, string>): [string, string][] {
  return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
}

function parseObjectMap(stdout: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const record of splitGitZ(stdout)) {
    const tab = record.indexOf('\t')
    if (tab < 0) throw new Error(`unexpected ls-files record: ${record}`)
    const meta = record.slice(0, tab)
    const rel = record.slice(tab + 1)
    const [mode, objectId] = meta.split(/\s+/)
    if (mode === '160000') continue
    out.set(rel, objectId)
  }
  return out
}

describe('collectCheckpointFiles', () => {
  test('uses tiny defaults and leaves env/log/build outputs to user .gitignore', async () => {
    touch('a.txt', 'a')
    touch('node_modules/pkg/index.js', 'ignored')
    touch('.DS_Store', 'ignored')
    touch('.env', 'kept')
    touch('app.log', 'kept')
    touch('.next/cache.bin', 'kept')
    touch('build/output.bin', 'kept')

    const r = await collectCheckpointFiles({
      store: storeDir,
      workTree,
      indexFile,
    })
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    expect(r.paths.sort()).toEqual([
      '.env',
      '.next/cache.bin',
      'a.txt',
      'app.log',
      'build/output.bin',
    ])
  })

  test('lets user .gitignore negation override non-VCS tiny defaults', async () => {
    touch(
      '.gitignore',
      [
        '!node_modules/',
        '!node_modules/pkg/',
        '!node_modules/pkg/index.js',
        '!.DS_Store',
        '',
      ].join('\n'),
    )
    touch('node_modules/pkg/index.js', 'explicitly kept')
    touch('.DS_Store', 'explicitly kept')
    touch('.git/HEAD', 'still hard metadata')

    const r = await collectCheckpointFiles({
      store: storeDir,
      workTree,
      indexFile,
    })
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    expect(r.paths.sort()).toEqual([
      '.DS_Store',
      '.gitignore',
      'node_modules/pkg/index.js',
    ])
  })

  test('honors nested .gitignore with Git semantics', async () => {
    touch('.gitignore', 'root-ignored.txt\n')
    touch('root-ignored.txt', 'ignored')
    touch('root-kept.txt', 'kept')
    touch('nested/.gitignore', 'nested-ignored.txt\n')
    touch('nested/nested-ignored.txt', 'ignored')
    touch('nested/nested-kept.txt', 'kept')
    touch('sibling/nested-ignored.txt', 'not ignored by nested rule')

    const r = await collectCheckpointFiles({
      store: storeDir,
      workTree,
      indexFile,
    })
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    expect(r.paths.sort()).toEqual([
      '.gitignore',
      'nested/.gitignore',
      'nested/nested-kept.txt',
      'root-kept.txt',
      'sibling/nested-ignored.txt',
    ])
  })

  test('honors anchored, negated, and directory .gitignore rules across scopes', async () => {
    touch(
      '.gitignore',
      [
        '/root-only.txt',
        '*.tmp',
        '!keep.tmp',
        'ignored-dir/',
        '!ignored-dir/keep.txt',
        '',
      ].join('\n'),
    )
    touch('root-only.txt', 'ignored at root only')
    touch('sub/root-only.txt', 'kept because root anchor does not apply here')
    touch('drop.tmp', 'ignored by wildcard')
    touch('keep.tmp', 're-included by negation')
    touch('ignored-dir/keep.txt', 'not reachable because the dir is ignored')
    touch(
      'scoped/.gitignore',
      ['/local-root.txt', 'child-ignore/', ''].join('\n'),
    )
    touch('scoped/local-root.txt', 'ignored by scoped root anchor')
    touch('scoped/deep/local-root.txt', 'kept below scoped root')
    touch('scoped/child-ignore/file.txt', 'ignored by scoped dir rule')
    touch('scoped/keep.txt', 'kept')

    const r = await collectCheckpointFiles({
      store: storeDir,
      workTree,
      indexFile,
    })
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    expect(r.paths.sort()).toEqual([
      '.gitignore',
      'keep.tmp',
      'scoped/.gitignore',
      'scoped/deep/local-root.txt',
      'scoped/keep.txt',
      'sub/root-only.txt',
    ])
  })

  test('matches fresh-index git add -A for ordinary non-embedded trees with the same ignore inputs', async () => {
    touch(
      '.gitignore',
      [
        '*.tmp',
        '!keep.tmp',
        '/root-only.bin',
        'dist/',
        'logs/*.log',
        '',
      ].join('\n'),
    )
    touch(
      'sub/.gitignore',
      ['/local-only.txt', '!drop.tmp', 'child-ignore/', ''].join('\n'),
    )
    touch('.env', 'kept by checkpoint defaults')
    touch('src/app.ts', 'kept')
    touch('drop.tmp', 'ignored by root wildcard')
    touch('keep.tmp', 'root negation')
    touch('sub/drop.tmp', 'nested negation overrides root wildcard')
    touch('sub/local-only.txt', 'ignored by nested anchor')
    touch('sub/deep/local-only.txt', 'kept below nested anchor')
    touch('sub/child-ignore/file.txt', 'ignored nested directory')
    touch('root-only.bin', 'ignored at root')
    touch('nested/root-only.bin', 'kept below root')
    touch('dist/output.txt', 'ignored directory')
    touch('logs/app.log', 'ignored one level')
    touch('logs/deep/app.log', 'kept below one-level glob')
    touch('node_modules/pkg/index.js', 'ignored by checkpoint default')

    git(workTree, ['init'])
    writeDefaultExclude(workTree)
    const oracle = gitAddOracle(workTree)

    const r = await stageWorktreeSnapshotIndex({
      store: storeDir,
      workTree,
      indexFile,
    })
    expect(r.ok).toBe(true)
    expect(sortedEntries(await stagedTreeObjects())).toEqual(
      sortedEntries(oracle),
    )
  })

  test('does not keep tracked-but-now-ignored files from the user repository index', async () => {
    git(workTree, ['init'])
    writeDefaultExclude(workTree)
    touch('tracked-then-ignored.txt', 'initial')
    git(workTree, ['add', 'tracked-then-ignored.txt'])
    gitCommit(workTree, 'track file before ignore')

    touch('.gitignore', 'tracked-then-ignored.txt\n')
    touch('tracked-then-ignored.txt', 'current disk bytes')
    const userGitAddResult = liveGitAddOracle(workTree)
    expect(userGitAddResult.has('tracked-then-ignored.txt')).toBe(true)

    const r = await stageWorktreeSnapshotIndex({
      store: storeDir,
      workTree,
      indexFile,
    })
    expect(r.ok).toBe(true)
    expect(await stagedTreePaths()).toEqual(['.gitignore'])
  })

  test('matches a composed fresh-index git add -A oracle for embedded repositories', async () => {
    git(workTree, ['init'])
    writeDefaultExclude(workTree)
    touch(
      '.gitignore',
      [
        '*.rootignore',
        '*.tmp',
        '!root-keep.tmp',
        'root-dir/',
        'child-root-blocked.txt',
        '',
      ].join('\n'),
    )
    touch('root.txt', 'root clean')
    touch('root-staged-different.txt', 'root clean')
    touch('root-deleted.txt', 'delete me')
    touch('root-ignored.rootignore', 'ignored by root')
    touch('root-keep.tmp', 'root keep')
    touch('root-drop.tmp', 'root drop')
    touch('root-dir/file.txt', 'ignored root dir')
    git(workTree, [
      'add',
      '.gitignore',
      'root.txt',
      'root-staged-different.txt',
      'root-deleted.txt',
    ])
    gitCommit(workTree, 'root initial')
    touch('root.txt', 'root dirty')
    rmSync(join(workTree, 'root-deleted.txt'))
    touch('root-staged-different.txt', 'root index version')
    git(workTree, ['add', 'root-staged-different.txt'])
    touch('root-staged-different.txt', 'root worktree version')
    touch('root-untracked.txt', 'root untracked')

    const childRel = 'vendor/child'
    const child = join(workTree, childRel)
    mkdirSync(child, { recursive: true })
    git(child, ['init'])
    writeDefaultExclude(child)
    touch(
      `${childRel}/.gitignore`,
      [
        '*.childignore',
        '!child-keep.childignore',
        'child-dir/',
        'grand-parent-blocked.txt',
        '',
      ].join('\n'),
    )
    touch(`${childRel}/child.txt`, 'child clean')
    touch(`${childRel}/child-staged-different.txt`, 'child clean')
    touch(`${childRel}/child-deleted.txt`, 'delete me')
    touch(`${childRel}/child-ignored.childignore`, 'ignored by child')
    touch(`${childRel}/child-keep.childignore`, 'child keep')
    touch(`${childRel}/child-root-blocked.txt`, 'child ignores parent scope')
    touch(`${childRel}/child-kept.tmp`, 'child ignores parent *.tmp')
    touch(`${childRel}/child-dir/file.txt`, 'ignored child dir')
    git(child, [
      'add',
      '.gitignore',
      'child.txt',
      'child-staged-different.txt',
      'child-deleted.txt',
    ])
    gitCommit(child, 'child initial')
    touch(`${childRel}/child.txt`, 'child dirty')
    rmSync(join(workTree, `${childRel}/child-deleted.txt`))
    touch(`${childRel}/child-staged-different.txt`, 'child index version')
    git(child, ['add', 'child-staged-different.txt'])
    touch(`${childRel}/child-staged-different.txt`, 'child worktree version')
    touch(`${childRel}/child-untracked.txt`, 'child untracked')

    const grandRel = `${childRel}/grand`
    const grand = join(workTree, grandRel)
    mkdirSync(grand, { recursive: true })
    git(grand, ['init'])
    writeDefaultExclude(grand)
    touch(
      `${grandRel}/.gitignore`,
      ['*.grandignore', '!grand-keep.grandignore', 'grand-dir/', ''].join('\n'),
    )
    touch(`${grandRel}/grand.txt`, 'grand clean')
    touch(`${grandRel}/grand-deleted.txt`, 'delete me')
    touch(`${grandRel}/grand-ignored.grandignore`, 'ignored by grand')
    touch(`${grandRel}/grand-keep.grandignore`, 'grand keep')
    touch(`${grandRel}/grand-parent-blocked.txt`, 'grand ignores child scope')
    touch(`${grandRel}/grand-kept.tmp`, 'grand ignores root *.tmp')
    touch(`${grandRel}/grand-dir/file.txt`, 'ignored grand dir')
    git(grand, ['add', '.gitignore', 'grand.txt', 'grand-deleted.txt'])
    gitCommit(grand, 'grand initial')
    touch(`${grandRel}/grand.txt`, 'grand dirty')
    rmSync(join(workTree, `${grandRel}/grand-deleted.txt`))
    touch(`${grandRel}/grand-untracked.txt`, 'grand untracked')

    // Root Git sees `vendor/child` as an embedded repository. Child Git sees
    // `grand` the same way. The checkpoint oracle is therefore the union of
    // each repository's own fresh-index `git add -A` file tree, with gitlinks removed and
    // nested results prefixed back into the outer filesystem snapshot.
    const oracle = mergeOracles(
      gitAddOracle(workTree),
      prefixedOracle(childRel, gitAddOracle(child)),
      prefixedOracle(grandRel, gitAddOracle(grand)),
    )

    const r = await stageWorktreeSnapshotIndex({
      store: storeDir,
      workTree,
      indexFile,
    })
    expect(r.ok).toBe(true)
    expect(sortedEntries(await stagedTreeObjects())).toEqual(
      sortedEntries(oracle),
    )
  })

  test('skips VCS metadata but traverses ordinary files inside embedded repos', async () => {
    touch('root.txt', 'root')
    mkdirSync(join(workTree, 'nested/.git'), { recursive: true })
    touch('nested/.git/HEAD', 'ref: refs/heads/main\n')
    touch('nested/.gitignore', 'ignored.txt\n')
    touch('nested/dirty.txt', 'dirty')
    touch('nested/ignored.txt', 'ignored')

    const r = await stageWorktreeSnapshotIndex({
      store: storeDir,
      workTree,
      indexFile,
    })
    expect(r.ok).toBe(true)
    expect(await stagedTreePaths()).toEqual([
      'nested/.gitignore',
      'nested/dirty.txt',
      'root.txt',
    ])
    expect(await showIndexPath('nested/dirty.txt')).toBe('dirty')
  })

  test('does not inherit parent .gitignore rules inside embedded repos without their own .gitignore', async () => {
    touch('.gitignore', '*.tmp\nparent-blocked.txt\n')
    touch('root.tmp', 'ignored by parent')
    touch('parent-blocked.txt', 'ignored by parent')
    mkdirSync(join(workTree, 'nested/.git'), { recursive: true })
    touch('nested/.git/HEAD', 'ref: refs/heads/main\n')
    touch('nested/kept.tmp', 'parent wildcard must not apply here')
    touch('nested/parent-blocked.txt', 'parent literal must not apply here')

    const r = await stageWorktreeSnapshotIndex({
      store: storeDir,
      workTree,
      indexFile,
    })
    expect(r.ok).toBe(true)
    expect(await stagedTreePaths()).toEqual([
      '.gitignore',
      'nested/kept.tmp',
      'nested/parent-blocked.txt',
    ])
  })

  test('does not let parent file-level ignores hide .git-directory embedded repos', async () => {
    touch('.gitignore', 'nested/*\n')
    touch('root.txt', 'root')
    mkdirSync(join(workTree, 'nested/.git'), { recursive: true })
    touch('nested/.git/HEAD', 'ref: refs/heads/main\n')
    touch('nested/.gitignore', 'ignored.txt\n')
    touch('nested/ignored.txt', 'ignored by child')
    touch('nested/kept.txt', 'kept by child scope')

    const r = await stageWorktreeSnapshotIndex({
      store: storeDir,
      workTree,
      indexFile,
    })
    expect(r.ok).toBe(true)
    expect(await stagedTreePaths()).toEqual([
      '.gitignore',
      'nested/.gitignore',
      'nested/kept.txt',
      'root.txt',
    ])
    expect(await showIndexPath('nested/kept.txt')).toBe('kept by child scope')
  })

  test('respects parent .gitignore when it ignores the embedded repo directory itself', async () => {
    touch('.gitignore', 'nested/\n')
    mkdirSync(join(workTree, 'nested/.git'), { recursive: true })
    touch('nested/.git/HEAD', 'ref: refs/heads/main\n')
    touch('nested/kept-by-child.txt', 'not reached')
    touch('root.txt', 'root')

    const r = await stageWorktreeSnapshotIndex({
      store: storeDir,
      workTree,
      indexFile,
    })
    expect(r.ok).toBe(true)
    expect(await stagedTreePaths()).toEqual(['.gitignore', 'root.txt'])
  })

  test('respects parent file-level ignores that block deeper embedded repo boundaries', async () => {
    touch('.gitignore', 'vendor/*\n')
    touch('root.txt', 'root')
    mkdirSync(join(workTree, 'vendor/child/.git'), { recursive: true })
    touch('vendor/child/.git/HEAD', 'ref: refs/heads/main\n')
    touch('vendor/child/kept.txt', 'not reached')

    const r = await stageWorktreeSnapshotIndex({
      store: storeDir,
      workTree,
      indexFile,
    })
    expect(r.ok).toBe(true)
    expect(await stagedTreePaths()).toEqual(['.gitignore', 'root.txt'])
  })

  test('skips .git files used by submodules/worktrees but keeps ordinary files below them', async () => {
    touch('module/.git', 'gitdir: ../.git/modules/module\n')
    touch('module/.gitignore', 'ignored.txt\n')
    touch('module/ignored.txt', 'ignored')
    touch('module/kept.txt', 'kept')
    touch('sibling/ignored.txt', 'not ignored by module rule')

    const r = await stageWorktreeSnapshotIndex({
      store: storeDir,
      workTree,
      indexFile,
    })
    expect(r.ok).toBe(true)
    expect(await stagedTreePaths()).toEqual([
      'module/.gitignore',
      'module/kept.txt',
      'sibling/ignored.txt',
    ])
    expect(await showIndexPath('module/kept.txt')).toBe('kept')
  })

  test('does not let parent file-level ignores leak into .git-file embedded repos', async () => {
    touch('.gitignore', 'module/*\n')
    touch('module/.git', 'gitdir: ../.git/modules/module\n')
    touch('module/.gitignore', 'ignored.txt\n')
    touch('module/ignored.txt', 'ignored by child')
    touch('module/kept.txt', 'kept by child scope')
    touch('root.txt', 'root')

    const r = await stageWorktreeSnapshotIndex({
      store: storeDir,
      workTree,
      indexFile,
    })
    expect(r.ok).toBe(true)
    expect(await stagedTreePaths()).toEqual([
      '.gitignore',
      'module/.gitignore',
      'module/kept.txt',
      'root.txt',
    ])
    expect(await showIndexPath('module/kept.txt')).toBe('kept by child scope')
  })

  test('stages Windows-safe paths with spaces, punctuation, and unicode through -z stdin', async () => {
    touch('space dir/file name.txt', 'space')
    touch('symbols/safe (1)+=,@.txt', 'symbols')
    touch('unicode/文件.txt', 'unicode')

    const r = await stageWorktreeSnapshotIndex({
      store: storeDir,
      workTree,
      indexFile,
    })
    expect(r.ok).toBe(true)
    expect(await stagedTreePaths()).toEqual([
      'space dir/file name.txt',
      'symbols/safe (1)+=,@.txt',
      'unicode/文件.txt',
    ])
    expect(await showIndexPath('space dir/file name.txt')).toBe('space')
    expect(await showIndexPath('unicode/文件.txt')).toBe('unicode')
  })

  test('stages current dirty and untracked files inside a committed nested repo, not a gitlink', async () => {
    mkdirSync(join(workTree, 'nested'), { recursive: true })
    const nested = join(workTree, 'nested')
    git(nested, ['init'])
    touch('nested/tracked.txt', 'clean')
    touch('nested/deleted.txt', 'delete me')
    touch('nested/staged-different.txt', 'clean')
    git(nested, ['add', 'tracked.txt', 'deleted.txt', 'staged-different.txt'])
    gitCommit(nested, 'initial')
    touch('nested/tracked.txt', 'dirty')
    rmSync(join(workTree, 'nested/deleted.txt'))
    touch('nested/staged-different.txt', 'index version')
    git(nested, ['add', 'staged-different.txt'])
    touch('nested/staged-different.txt', 'worktree version')
    touch('nested/untracked.txt', 'untracked')

    const r = await stageWorktreeSnapshotIndex({
      store: storeDir,
      workTree,
      indexFile,
    })
    expect(r.ok).toBe(true)
    expect(await stagedTreePaths()).toEqual([
      'nested/staged-different.txt',
      'nested/tracked.txt',
      'nested/untracked.txt',
    ])
    expect(await showIndexPath('nested/staged-different.txt')).toBe(
      'worktree version',
    )
    expect(await showIndexPath('nested/tracked.txt')).toBe('dirty')
    expect(await showIndexPath('nested/untracked.txt')).toBe('untracked')
  })

  test('stages current disk bytes across root, nested, and nested-nested dirty repos', async () => {
    git(workTree, ['init'])
    touch('.gitignore', 'root-ignored.txt\n')
    touch('root.txt', 'root clean')
    touch('root-staged-different.txt', 'root clean')
    touch('root-deleted.txt', 'delete me')
    git(workTree, [
      'add',
      '.gitignore',
      'root.txt',
      'root-staged-different.txt',
      'root-deleted.txt',
    ])
    gitCommit(workTree, 'root initial')
    touch('root.txt', 'root dirty')
    rmSync(join(workTree, 'root-deleted.txt'))
    touch('root-staged-different.txt', 'root index version')
    git(workTree, ['add', 'root-staged-different.txt'])
    touch('root-staged-different.txt', 'root worktree version')
    touch('root-untracked.txt', 'root untracked')
    touch('root-ignored.txt', 'ignored by root .gitignore')

    const child = join(workTree, 'vendor/child')
    mkdirSync(child, { recursive: true })
    git(child, ['init'])
    touch('vendor/child/.gitignore', 'child-ignored.txt\n')
    touch('vendor/child/child.txt', 'child clean')
    touch('vendor/child/child-staged-different.txt', 'child clean')
    touch('vendor/child/child-deleted.txt', 'delete me')
    git(child, [
      'add',
      '.gitignore',
      'child.txt',
      'child-staged-different.txt',
      'child-deleted.txt',
    ])
    gitCommit(child, 'child initial')
    touch('vendor/child/child.txt', 'child dirty')
    rmSync(join(workTree, 'vendor/child/child-deleted.txt'))
    touch('vendor/child/child-staged-different.txt', 'child index version')
    git(child, ['add', 'child-staged-different.txt'])
    touch('vendor/child/child-staged-different.txt', 'child worktree version')
    touch('vendor/child/child-untracked.txt', 'child untracked')
    touch('vendor/child/child-ignored.txt', 'ignored by child .gitignore')

    const grandchild = join(workTree, 'vendor/child/grand')
    mkdirSync(grandchild, { recursive: true })
    git(grandchild, ['init'])
    touch('vendor/child/grand/.gitignore', 'grand-ignored.txt\n')
    touch('vendor/child/grand/grand.txt', 'grand clean')
    touch('vendor/child/grand/grand-deleted.txt', 'delete me')
    git(grandchild, ['add', '.gitignore', 'grand.txt', 'grand-deleted.txt'])
    gitCommit(grandchild, 'grand initial')
    touch('vendor/child/grand/grand.txt', 'grand dirty')
    rmSync(join(workTree, 'vendor/child/grand/grand-deleted.txt'))
    touch('vendor/child/grand/grand-untracked.txt', 'grand untracked')
    touch('vendor/child/grand/grand-ignored.txt', 'ignored by grand .gitignore')

    const r = await stageWorktreeSnapshotIndex({
      store: storeDir,
      workTree,
      indexFile,
    })
    expect(r.ok).toBe(true)
    expect(await stagedTreePaths()).toEqual([
      '.gitignore',
      'root-staged-different.txt',
      'root-untracked.txt',
      'root.txt',
      'vendor/child/.gitignore',
      'vendor/child/child-staged-different.txt',
      'vendor/child/child-untracked.txt',
      'vendor/child/child.txt',
      'vendor/child/grand/.gitignore',
      'vendor/child/grand/grand-untracked.txt',
      'vendor/child/grand/grand.txt',
    ])
    expect(await showIndexPath('root-staged-different.txt')).toBe(
      'root worktree version',
    )
    expect(await showIndexPath('vendor/child/child-staged-different.txt')).toBe(
      'child worktree version',
    )
    expect(await showIndexPath('vendor/child/grand/grand.txt')).toBe(
      'grand dirty',
    )
  })

  test('ignores the root repo index/status and snapshots the root worktree bytes', async () => {
    git(workTree, ['init'])
    touch('.gitignore', 'ignored.txt\n')
    touch('dirty.txt', 'clean')
    touch('deleted.txt', 'delete me')
    touch('staged-different.txt', 'clean')
    git(workTree, ['add', '.gitignore', 'dirty.txt', 'deleted.txt', 'staged-different.txt'])
    gitCommit(workTree, 'initial')

    touch('dirty.txt', 'dirty')
    rmSync(join(workTree, 'deleted.txt'))
    touch('staged-different.txt', 'index version')
    git(workTree, ['add', 'staged-different.txt'])
    touch('staged-different.txt', 'worktree version')
    touch('untracked.txt', 'untracked')
    touch('ignored.txt', 'ignored')

    const r = await stageWorktreeSnapshotIndex({
      store: storeDir,
      workTree,
      indexFile,
    })
    expect(r.ok).toBe(true)
    expect(await stagedTreePaths()).toEqual([
      '.gitignore',
      'dirty.txt',
      'staged-different.txt',
      'untracked.txt',
    ])
    expect(await showIndexPath('dirty.txt')).toBe('dirty')
    expect(await showIndexPath('staged-different.txt')).toBe(
      'worktree version',
    )
  })

  test('snapshots files inside a parent-staged embedded repo instead of a gitlink', async () => {
    const nested = join(workTree, 'nested')
    mkdirSync(nested, { recursive: true })
    git(nested, ['init'])
    touch('nested/tracked.txt', 'clean')
    git(nested, ['add', 'tracked.txt'])
    gitCommit(nested, 'nested initial')

    git(workTree, ['init'])
    git(workTree, ['add', 'nested'])
    gitCommit(workTree, 'parent records embedded repo')

    touch('nested/tracked.txt', 'dirty')
    touch('nested/untracked.txt', 'untracked')

    const r = await stageWorktreeSnapshotIndex({
      store: storeDir,
      workTree,
      indexFile,
    })
    expect(r.ok).toBe(true)
    expect(await stagedTreePaths()).toEqual([
      'nested/tracked.txt',
      'nested/untracked.txt',
    ])
    expect(await showIndexPath('nested/tracked.txt')).toBe('dirty')

    const tree = await runCheckpointGit(['write-tree'], {
      store: storeDir,
      workTree,
      indexFile,
    })
    if (tree.ok === false) throw new Error(tree.message)
    const entries = await runCheckpointGit(['ls-tree', '-r', tree.stdout.trim()], {
      store: storeDir,
      workTree,
      indexFile,
    })
    if (entries.ok === false) throw new Error(entries.message)
    expect(entries.stdout).not.toContain('160000')
  })

  test('rebuilding from empty index naturally records deletes', async () => {
    touch('a.txt', 'a')
    touch('b.txt', 'b')
    const first = await stageWorktreeSnapshotIndex({
      store: storeDir,
      workTree,
      indexFile,
    })
    expect(first.ok).toBe(true)
    const firstTree = await runCheckpointGit(['write-tree'], {
      store: storeDir,
      workTree,
      indexFile,
    })
    if (firstTree.ok === false) throw new Error(firstTree.message)

    rmSync(join(workTree, 'b.txt'))
    touch('a.txt', 'a2')
    const second = await stageWorktreeSnapshotIndex({
      store: storeDir,
      workTree,
      indexFile,
    })
    expect(second.ok).toBe(true)
    expect(await stagedTreePaths()).toEqual(['a.txt'])
    const diff = await runCheckpointGit(
      ['diff-index', '--cached', '--name-status', firstTree.stdout.trim()],
      { store: storeDir, workTree, indexFile, allowedExitCodes: new Set([1]) },
    )
    if (diff.ok === false) throw new Error(diff.message)
    expect(diff.stdout.split('\n').filter(Boolean).sort()).toEqual([
      'D\tb.txt',
      'M\ta.txt',
    ])
  })
})
