import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import {
  claimAuthLock,
  deleteAuthLockIfStateMatches,
  getConfigFilePath,
  markAuthLockStatusIfStateMatches,
  readAuthLock,
  readJsonFile,
  updateAuthLockIfStateMatches,
  writeAuthLock,
} from './mcp-auth-config'
import { MCP_REMOTE_VERSION } from './utils'

const schema = {
  parseAsync: async (data: unknown) => data,
}

describe('mcp auth config coordination', () => {
  let previousConfigDir: string | undefined
  let tempConfigDir: string

  beforeEach(async () => {
    previousConfigDir = process.env.MCP_REMOTE_CONFIG_DIR
    tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-auth-config-test-'))
    process.env.MCP_REMOTE_CONFIG_DIR = tempConfigDir
  })

  afterEach(async () => {
    if (previousConfigDir === undefined) {
      delete process.env.MCP_REMOTE_CONFIG_DIR
    } else {
      process.env.MCP_REMOTE_CONFIG_DIR = previousConfigDir
    }
    await fs.rm(tempConfigDir, { recursive: true, force: true })
  })

  it('atomically gives one owner and one waiter for the same resource', async () => {
    const timestamp = Date.now()
    const [first, second] = await Promise.all([
      claimAuthLock('same-hash', {
        state: 'first:same-hash',
        serverUrlHash: 'same-hash',
        resource: 'resource-a',
        timestamp,
        status: 'pending',
      }),
      claimAuthLock('same-hash', {
        state: 'second:same-hash',
        serverUrlHash: 'same-hash',
        resource: 'resource-a',
        timestamp,
        status: 'pending',
      }),
    ])

    expect([first.role, second.role].sort()).toEqual(['owner', 'waiter'])
    const currentLock = await readAuthLock('same-hash')
    expect(currentLock?.state).toBe(first.role === 'owner' ? first.lock.state : second.lock.state)
  })

  it('keeps separate resources isolated by hash', async () => {
    const timestamp = Date.now()
    const [first, second] = await Promise.all([
      claimAuthLock('hash-a', {
        state: 'first:hash-a',
        serverUrlHash: 'hash-a',
        resource: 'resource-a',
        timestamp,
        status: 'pending',
      }),
      claimAuthLock('hash-b', {
        state: 'second:hash-b',
        serverUrlHash: 'hash-b',
        resource: 'resource-b',
        timestamp,
        status: 'pending',
      }),
    ])

    expect(first.role).toBe('owner')
    expect(second.role).toBe('owner')
    expect((await readAuthLock('hash-a'))?.resource).toBe('resource-a')
    expect((await readAuthLock('hash-b'))?.resource).toBe('resource-b')
  })

  it('replaces a stale lock safely under concurrent claims', async () => {
    await writeAuthLock('stale-hash', {
      state: 'stale:stale-hash',
      serverUrlHash: 'stale-hash',
      resource: 'resource-a',
      timestamp: Date.now() - 11 * 60 * 1000,
      status: 'pending',
    })

    const [first, second] = await Promise.all([
      claimAuthLock('stale-hash', {
        state: 'fresh-one:stale-hash',
        serverUrlHash: 'stale-hash',
        resource: 'resource-a',
        timestamp: Date.now(),
        status: 'pending',
      }),
      claimAuthLock('stale-hash', {
        state: 'fresh-two:stale-hash',
        serverUrlHash: 'stale-hash',
        resource: 'resource-a',
        timestamp: Date.now(),
        status: 'pending',
      }),
    ])

    expect([first.role, second.role].sort()).toEqual(['owner', 'waiter'])
    expect((await readAuthLock('stale-hash'))?.state).not.toBe('stale:stale-hash')
  })

  it('clears or marks only the lock with the matching state', async () => {
    await writeAuthLock('state-hash', {
      state: 'current:state-hash',
      serverUrlHash: 'state-hash',
      resource: 'resource-a',
      timestamp: Date.now(),
      status: 'pending',
    })

    expect(await deleteAuthLockIfStateMatches('state-hash', 'old:state-hash')).toBe(false)
    expect((await readAuthLock('state-hash'))?.state).toBe('current:state-hash')

    expect(await markAuthLockStatusIfStateMatches('state-hash', 'old:state-hash', 'failed')).toBe(false)
    expect((await readAuthLock('state-hash'))?.status).toBe('pending')

    expect(await markAuthLockStatusIfStateMatches('state-hash', 'current:state-hash', 'failed')).toBe(true)
    expect((await readAuthLock('state-hash'))?.status).toBe('failed')

    expect(await deleteAuthLockIfStateMatches('state-hash', 'current:state-hash')).toBe(true)
    expect(await readAuthLock('state-hash')).toBeNull()
  })

  it('serializes claim while lock metadata update owns the sidecar mutex', async () => {
    await writeAuthLock('mutex-hash', {
      state: 'current:mutex-hash',
      serverUrlHash: 'mutex-hash',
      resource: 'resource-a',
      timestamp: Date.now(),
      status: 'pending',
    })

    const mutexPath = `${getConfigFilePath('mutex-hash', 'lock.json')}.mutex`
    await fs.writeFile(mutexPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), { mode: 0o600 })

    let claimSettled = false
    const claimPromise = claimAuthLock('mutex-hash', {
      state: 'new:mutex-hash',
      serverUrlHash: 'mutex-hash',
      resource: 'resource-a',
      timestamp: Date.now(),
      status: 'pending',
    }).then((result) => {
      claimSettled = true
      return result
    })

    await new Promise((resolve) => setTimeout(resolve, 75))
    expect(claimSettled).toBe(false)
    expect((await readAuthLock('mutex-hash'))?.state).toBe('current:mutex-hash')

    await fs.unlink(mutexPath)
    const claimResult = await claimPromise

    expect(claimResult.role).toBe('waiter')
    expect(claimResult.lock.state).toBe('current:mutex-hash')
  })

  it('replaces a stale sidecar mutex and proceeds with the claim', async () => {
    const mutexPath = `${getConfigFilePath('stale-mutex-hash', 'lock.json')}.mutex`
    await fs.mkdir(path.dirname(mutexPath), { recursive: true })
    await fs.writeFile(mutexPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() - 60_000 }), { mode: 0o600 })
    const staleMtime = new Date(Date.now() - 60_000)
    await fs.utimes(mutexPath, staleMtime, staleMtime)

    const claimResult = await claimAuthLock('stale-mutex-hash', {
      state: 'current:stale-mutex-hash',
      serverUrlHash: 'stale-mutex-hash',
      resource: 'resource-a',
      timestamp: Date.now(),
      status: 'pending',
    })

    expect(claimResult.role).toBe('owner')
    expect((await readAuthLock('stale-mutex-hash'))?.state).toBe('current:stale-mutex-hash')
  })

  it('serializes state matched update while another holder owns the sidecar mutex', async () => {
    await writeAuthLock('update-mutex-hash', {
      state: 'current:update-mutex-hash',
      serverUrlHash: 'update-mutex-hash',
      resource: 'resource-a',
      timestamp: Date.now(),
      status: 'pending',
    })

    const mutexPath = `${getConfigFilePath('update-mutex-hash', 'lock.json')}.mutex`
    await fs.writeFile(mutexPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), { mode: 0o600 })

    let updateSettled = false
    const updatePromise = updateAuthLockIfStateMatches('update-mutex-hash', 'current:update-mutex-hash', {
      authorizationUrl: 'https://auth.example.com/authorize',
    }).then((result) => {
      updateSettled = true
      return result
    })

    await new Promise((resolve) => setTimeout(resolve, 75))
    expect(updateSettled).toBe(false)
    expect((await readAuthLock('update-mutex-hash'))?.authorizationUrl).toBeUndefined()

    await fs.unlink(mutexPath)
    await expect(updatePromise).resolves.toBe(true)
    expect((await readAuthLock('update-mutex-hash'))?.authorizationUrl).toBe('https://auth.example.com/authorize')
  })

  it('migrates legacy versioned files into the stable cache root once', async () => {
    const legacyDir = path.join(tempConfigDir, `mcp-remote-${MCP_REMOTE_VERSION}`)
    await fs.mkdir(legacyDir, { recursive: true })
    const legacyPath = path.join(legacyDir, 'legacy-hash_tokens.json')
    const stablePath = getConfigFilePath('legacy-hash', 'tokens.json')
    await fs.writeFile(legacyPath, JSON.stringify({ access_token: 'legacy-token' }), 'utf-8')
    const legacyMtime = new Date(Date.now() - 60_000)
    await fs.utimes(legacyPath, legacyMtime, legacyMtime)

    const tokens = (await readJsonFile('legacy-hash', 'tokens.json', schema)) as { access_token: string }

    expect(tokens.access_token).toBe('legacy-token')
    expect(JSON.parse(await fs.readFile(stablePath, 'utf-8'))).toEqual({ access_token: 'legacy-token' })
    expect((await fs.stat(stablePath)).mtimeMs).toBeLessThan(Date.now() - 30_000)
  })
})
