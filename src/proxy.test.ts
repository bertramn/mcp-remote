import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { waitForTokens } from './lib/proxy-auth'
import { getConfigFilePath, writeAuthLock } from './lib/mcp-auth-config'
import type { NodeOAuthClientProvider } from './lib/node-oauth-client-provider'
import { prepareProxyAuthMode } from './proxy'
import type { OAuthCallbackServerOptions } from './lib/types'

function createListeningServerMock() {
  const server = new EventEmitter() as EventEmitter & { close: () => void }
  server.close = vi.fn()
  setImmediate(() => server.emit('listening'))
  return server
}

describe('proxy auth token waiting', () => {
  let previousConfigDir: string | undefined
  let tempConfigDir: string

  beforeEach(async () => {
    previousConfigDir = process.env.MCP_REMOTE_CONFIG_DIR
    tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-proxy-test-'))
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

  it('rejects an old token file that predates the waited auth attempt', async () => {
    const tokenPath = getConfigFilePath('token-hash', 'tokens.json')
    await fs.mkdir(path.dirname(tokenPath), { recursive: true })
    await fs.writeFile(tokenPath, JSON.stringify({ access_token: 'old-token' }), 'utf-8')
    const oldMtime = new Date(Date.now() - 60_000)
    await fs.utimes(tokenPath, oldMtime, oldMtime)

    const authProvider = {
      tokens: vi.fn().mockResolvedValue({ access_token: 'old-token' }),
    } as unknown as NodeOAuthClientProvider

    await expect(waitForTokens(authProvider, 'token-hash', Date.now(), undefined, { timeoutMs: 10, pollMs: 1 })).rejects.toThrow(
      'Timed out waiting for shared token exchange to complete',
    )
    expect(authProvider.tokens).not.toHaveBeenCalled()
  })

  it('accepts a token file written after the waited auth attempt starts', async () => {
    const tokenPath = getConfigFilePath('token-hash', 'tokens.json')
    await fs.mkdir(path.dirname(tokenPath), { recursive: true })
    const attemptStartedAt = Date.now()
    await fs.writeFile(tokenPath, JSON.stringify({ access_token: 'new-token' }), 'utf-8')
    const newMtime = new Date(attemptStartedAt + 1_000)
    await fs.utimes(tokenPath, newMtime, newMtime)

    const authProvider = {
      tokens: vi.fn().mockResolvedValue({ access_token: 'new-token' }),
    } as unknown as NodeOAuthClientProvider

    await expect(
      waitForTokens(authProvider, 'token-hash', attemptStartedAt, undefined, { timeoutMs: 10, pollMs: 1 }),
    ).resolves.toBeUndefined()
    expect(authProvider.tokens).toHaveBeenCalledOnce()
  })

  it('fails fast when the shared auth lock is marked failed', async () => {
    const attemptStartedAt = Date.now()
    await writeAuthLock('token-hash', {
      state: 'auth-state:token-hash',
      serverUrlHash: 'token-hash',
      resource: 'resource-a',
      timestamp: attemptStartedAt,
      status: 'failed',
    })

    const authProvider = {
      tokens: vi.fn().mockResolvedValue(undefined),
    } as unknown as NodeOAuthClientProvider

    await expect(
      waitForTokens(authProvider, 'token-hash', attemptStartedAt, 'auth-state:token-hash', { timeoutMs: 100, pollMs: 1 }),
    ).rejects.toThrow('Shared token exchange failed')
  })

  it('fails fast when the waited auth lock is replaced by a newer attempt', async () => {
    const attemptStartedAt = Date.now()
    await writeAuthLock('token-hash', {
      state: 'new-state:token-hash',
      serverUrlHash: 'token-hash',
      resource: 'resource-a',
      timestamp: attemptStartedAt + 1,
      status: 'pending',
    })

    const authProvider = {
      tokens: vi.fn().mockResolvedValue(undefined),
    } as unknown as NodeOAuthClientProvider

    await expect(
      waitForTokens(authProvider, 'token-hash', attemptStartedAt, 'old-state:token-hash', { timeoutMs: 100, pollMs: 1 }),
    ).rejects.toThrow('Shared token exchange was replaced by another auth attempt')
  })
})

describe('proxy callback listener mode selection', () => {
  let previousConfigDir: string | undefined
  let tempConfigDir: string

  beforeEach(async () => {
    previousConfigDir = process.env.MCP_REMOTE_CONFIG_DIR
    tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-proxy-mode-test-'))
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

  it('starts a local callback server when no callback port is specified', async () => {
    const setupCallbackServer = vi.fn((options: OAuthCallbackServerOptions) => ({
      server: createListeningServerMock() as any,
      waitForAuthCode: vi.fn().mockResolvedValue('auth-code'),
      authCode: null,
      authState: null,
      authCompletedPromise: Promise.resolve('auth-code'),
    }))
    const authProvider = {
      state: vi.fn().mockReturnValue('state:mode-hash'),
    } as unknown as NodeOAuthClientProvider

    const mode = await prepareProxyAuthMode({
      splitCallbackMode: false,
      callbackPort: 4444,
      authTimeoutMs: 30000,
      authProvider,
      serverUrlHash: 'mode-hash',
      serverUrl: 'https://example.com/mcp',
      authorizeResource: '',
      setupCallbackServer,
    })
    const authState = await mode.authInitializer()

    expect(setupCallbackServer).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 4444,
        path: '/oauth/callback',
      }),
    )
    expect(authState.waitForAuthCode).toEqual(expect.any(Function))
    expect(authState.waitForTokens).toBeUndefined()
    expect(authState.skipBrowserAuth).toBe(false)
    mode.cleanupServer?.close()
  })

  it('does not bind a local callback server in split callback mode and waits for token file', async () => {
    const setupCallbackServer = vi.fn()
    const listenerReachable = vi.fn().mockResolvedValue(undefined)
    const authProvider = {
      state: vi.fn().mockReturnValue('state:mode-hash'),
      tokens: vi.fn(),
    } as unknown as NodeOAuthClientProvider

    const mode = await prepareProxyAuthMode({
      splitCallbackMode: true,
      callbackPort: 3736,
      authTimeoutMs: 30000,
      authProvider,
      serverUrlHash: 'mode-hash',
      serverUrl: 'https://example.com/mcp',
      authorizeResource: '',
      listenerReachable,
      setupCallbackServer,
    })
    const authState = await mode.authInitializer()

    expect(listenerReachable).toHaveBeenCalledWith(3736)
    expect(setupCallbackServer).not.toHaveBeenCalled()
    expect(authState.waitForAuthCode).toBeUndefined()
    expect(authState.waitForTokens).toEqual(expect.any(Function))
    expect(authState.skipBrowserAuth).toBe(false)
  })

  it('fails before auth starts when split callback mode has no reachable listener', async () => {
    const setupCallbackServer = vi.fn()
    const listenerReachable = vi.fn().mockRejectedValue(new Error('connection refused'))
    const authProvider = {
      state: vi.fn().mockReturnValue('state:mode-hash'),
    } as unknown as NodeOAuthClientProvider

    await expect(
      prepareProxyAuthMode({
        splitCallbackMode: true,
        callbackPort: 3736,
        authTimeoutMs: 30000,
        authProvider,
        serverUrlHash: 'mode-hash',
        serverUrl: 'https://example.com/mcp',
        authorizeResource: '',
        listenerReachable,
        setupCallbackServer,
      }),
    ).rejects.toThrow('connection refused')

    expect(setupCallbackServer).not.toHaveBeenCalled()
    expect(authProvider.state).not.toHaveBeenCalled()
  })

  it('keeps legacy single-process callback behavior on automatically selected callback ports', async () => {
    const setupCallbackServer = vi.fn((options: OAuthCallbackServerOptions) => ({
      server: createListeningServerMock() as any,
      waitForAuthCode: vi.fn().mockResolvedValue('auth-code'),
      authCode: null,
      authState: null,
      authCompletedPromise: Promise.resolve('auth-code'),
    }))
    const authProvider = {
      state: vi.fn().mockReturnValue('state:mode-hash'),
    } as unknown as NodeOAuthClientProvider

    const mode = await prepareProxyAuthMode({
      splitCallbackMode: false,
      callbackPort: 4444,
      authTimeoutMs: 30000,
      authProvider,
      serverUrlHash: 'mode-hash',
      serverUrl: 'https://example.com/mcp',
      authorizeResource: '',
      setupCallbackServer,
    })
    const authState = await mode.authInitializer()

    expect(setupCallbackServer).toHaveBeenCalledWith(expect.objectContaining({ port: 4444 }))
    expect(authState.waitForAuthCode).toEqual(expect.any(Function))
    expect(authState.waitForTokens).toBeUndefined()
    mode.cleanupServer?.close()
  })
})
