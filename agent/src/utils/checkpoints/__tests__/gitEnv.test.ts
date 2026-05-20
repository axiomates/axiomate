import { describe, expect, test } from 'vitest'
import { checkpointGitEnv, checkpointInitEnv } from '../gitEnv.js'

const fixtureStore = process.platform === 'win32' ? 'C:\\store' : '/store'
const fixtureWorktree = process.platform === 'win32' ? 'C:\\proj' : '/proj'
const fixtureIndex = process.platform === 'win32' ? 'C:\\store\\indexes\\abc' : '/store/indexes/abc'
const expectedNullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'

describe('checkpointGitEnv', () => {
  test('points GIT_DIR at the shadow store and binds GIT_WORK_TREE', () => {
    const env = checkpointGitEnv({
      store: fixtureStore,
      workTree: fixtureWorktree,
      indexFile: fixtureIndex,
    })
    expect(env.GIT_DIR).toBe(fixtureStore)
    expect(env.GIT_WORK_TREE).toBe(fixtureWorktree)
    expect(env.GIT_INDEX_FILE).toBe(fixtureIndex)
  })

  test('mutes user gitconfig (avoids GPG pinentry / credential helpers)', () => {
    const env = checkpointGitEnv({
      store: fixtureStore,
      workTree: fixtureWorktree,
    })
    expect(env.GIT_CONFIG_GLOBAL).toBe(expectedNullDevice)
    expect(env.GIT_CONFIG_SYSTEM).toBe(expectedNullDevice)
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
  })

  test('omits GIT_INDEX_FILE when no indexFile passed', () => {
    const env = checkpointGitEnv({
      store: fixtureStore,
      workTree: fixtureWorktree,
    })
    expect(env.GIT_INDEX_FILE).toBeUndefined()
  })

  test('strips inherited GIT_NAMESPACE / GIT_ALTERNATE_OBJECT_DIRECTORIES', () => {
    const original = process.env
    try {
      process.env = {
        ...original,
        GIT_NAMESPACE: 'leaked',
        GIT_ALTERNATE_OBJECT_DIRECTORIES: '/some/leaked/path',
      }
      const env = checkpointGitEnv({
        store: fixtureStore,
        workTree: fixtureWorktree,
      })
      expect(env.GIT_NAMESPACE).toBeUndefined()
      expect(env.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined()
    } finally {
      process.env = original
    }
  })

  test('preserves PATH and other parent environment', () => {
    const env = checkpointGitEnv({
      store: fixtureStore,
      workTree: fixtureWorktree,
    })
    // PATH must survive — git needs it to find its own helpers (git-remote-https etc).
    expect(env.PATH ?? env.Path ?? env.path).toBeDefined()
  })

  test('clears stale GIT_INDEX_FILE from parent env when not passed', () => {
    const original = process.env
    try {
      process.env = { ...original, GIT_INDEX_FILE: '/leaked/index' }
      const env = checkpointGitEnv({
        store: fixtureStore,
        workTree: fixtureWorktree,
      })
      expect(env.GIT_INDEX_FILE).toBeUndefined()
    } finally {
      process.env = original
    }
  })
})

describe('checkpointInitEnv', () => {
  test('omits GIT_WORK_TREE (git init --bare rejects it)', () => {
    const env = checkpointInitEnv({ store: fixtureStore })
    expect(env.GIT_DIR).toBe(fixtureStore)
    expect(env.GIT_WORK_TREE).toBeUndefined()
    expect(env.GIT_INDEX_FILE).toBeUndefined()
  })

  test('still mutes user gitconfig (init must not trigger credential prompts)', () => {
    const env = checkpointInitEnv({ store: fixtureStore })
    expect(env.GIT_CONFIG_GLOBAL).toBe(expectedNullDevice)
    expect(env.GIT_CONFIG_SYSTEM).toBe(expectedNullDevice)
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
  })

  test('strips inherited GIT_WORK_TREE from parent env', () => {
    const original = process.env
    try {
      process.env = {
        ...original,
        GIT_WORK_TREE: '/somewhere/leaked',
      }
      const env = checkpointInitEnv({ store: fixtureStore })
      expect(env.GIT_WORK_TREE).toBeUndefined()
    } finally {
      process.env = original
    }
  })
})
