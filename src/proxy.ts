#!/usr/bin/env node

/**
 * MCP Proxy with OAuth support
 * A bidirectional proxy between a local STDIO MCP server and a remote SSE server with OAuth authentication.
 *
 * Run with: npx tsx proxy.ts https://example.remote/server [callback-port]
 *
 * If callback-port is not specified, an available port will be automatically selected.
 */

import { EventEmitter } from 'events'
import type { Server } from 'http'
import net from 'net'
import { pathToFileURL } from 'url'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import {
  connectToRemoteServer,
  log,
  debugLog,
  mcpProxy,
  parseCommandLineArgs,
  setupSignalHandlers,
  TransportStrategy,
  discoverOAuthServerInfo,
  MCP_REMOTE_VERSION,
  setupOAuthCallbackServerWithLongPoll,
} from './lib/utils'
import { StaticOAuthClientInformationFull, StaticOAuthClientMetadata } from './lib/types'
import { NodeOAuthClientProvider } from './lib/node-oauth-client-provider'
import { FlexibleStdioServerTransport } from './lib/flexible-stdio-server-transport'
import { waitForTokens } from './lib/proxy-auth'
import { claimAuthLock, deleteAuthLockIfStateMatches, markAuthLockStatusIfStateMatches, readAuthLock } from './lib/mcp-auth-config'

const AUTH_LOCK_TTL_MS = 10 * 60 * 1000

type ProxyAuthModeOptions = {
  splitCallbackMode: boolean
  callbackPort: number
  authTimeoutMs: number
  authProvider: NodeOAuthClientProvider
  serverUrlHash: string
  serverUrl: string
  authorizeResource: string
  listenerReachable?: (callbackPort: number) => Promise<void>
  setupCallbackServer?: typeof setupOAuthCallbackServerWithLongPoll
}

type ProxyAuthMode = {
  cleanupServer: Server | null
  authInitializer: () => Promise<{
    waitForAuthCode?: () => Promise<string>
    waitForTokens?: () => Promise<void>
    skipBrowserAuth: boolean
  }>
}

function getClientName(authorizeResource: string): string {
  if (!authorizeResource) {
    return 'MCP CLI Proxy'
  }

  try {
    const resourceUrl = new URL(authorizeResource)
    return `MCP CLI Proxy (${resourceUrl.host})`
  } catch {
    const cleaned = authorizeResource.replace(/^https?:\/\//, '').replace(/\/+$/, '')
    return cleaned ? `MCP CLI Proxy (${cleaned})` : 'MCP CLI Proxy'
  }
}

function isAuthLockStale(timestamp: number): boolean {
  return Date.now() - timestamp > AUTH_LOCK_TTL_MS
}

async function createAuthProvider(
  serverUrl: string,
  callbackPort: number,
  headers: Record<string, string>,
  host: string,
  staticOAuthClientMetadata: StaticOAuthClientMetadata,
  staticOAuthClientInfo: StaticOAuthClientInformationFull,
  authorizeResource: string,
  sendResource: boolean,
  serverUrlHash: string,
) {
  log('Discovering OAuth server configuration...')
  const discoveryResult = await discoverOAuthServerInfo(serverUrl, headers)

  if (discoveryResult.protectedResourceMetadata) {
    log(`Discovered authorization server: ${discoveryResult.authorizationServerUrl}`)
  } else {
    debugLog('No Protected Resource Metadata found, using server URL as authorization server')
  }

  return new NodeOAuthClientProvider({
    serverUrl: discoveryResult.authorizationServerUrl,
    callbackPort,
    host,
    clientName: getClientName(authorizeResource),
    staticOAuthClientMetadata,
    staticOAuthClientInfo,
    authorizeResource,
    sendResource,
    serverUrlHash,
    authorizationServerMetadata: discoveryResult.authorizationServerMetadata,
    protectedResourceMetadata: discoveryResult.protectedResourceMetadata,
    wwwAuthenticateScope: discoveryResult.wwwAuthenticateScope,
  })
}

function createTransport(
  serverUrl: string,
  headers: Record<string, string>,
  authProvider: NodeOAuthClientProvider,
  transportStrategy: TransportStrategy,
) {
  const url = new URL(serverUrl)
  const sseTransport = transportStrategy === 'sse-only' || transportStrategy === 'sse-first'
  if (sseTransport) {
    return new SSEClientTransport(url, {
      authProvider,
      requestInit: { headers },
    })
  }
  return new StreamableHTTPClientTransport(url, {
    authProvider,
    requestInit: { headers },
  })
}

async function waitForServerListening(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
  })
}

async function waitForCallbackListener(callbackPort: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${callbackPort}/oauth/callback`, {
    method: 'GET',
    redirect: 'manual',
  }).catch(() => undefined)

  if (response && response.status < 500) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: callbackPort })
    socket.once('connect', () => {
      socket.destroy()
      resolve()
    })
    socket.once('error', (error) => {
      socket.destroy()
      reject(error)
    })
  })
}

export async function prepareProxyAuthMode({
  splitCallbackMode,
  callbackPort,
  authTimeoutMs,
  authProvider,
  serverUrlHash,
  serverUrl,
  authorizeResource,
  listenerReachable = waitForCallbackListener,
  setupCallbackServer = setupOAuthCallbackServerWithLongPoll,
}: ProxyAuthModeOptions): Promise<ProxyAuthMode> {
  let cleanupServer: Server | null = null
  let waitForAuthCode: (() => Promise<string>) | undefined

  if (splitCallbackMode) {
    try {
      await listenerReachable(callbackPort)
    } catch (error) {
      log(`Fatal error: no callback listener is reachable on 127.0.0.1:${callbackPort}`)
      log(`Start one with --listen-only before starting browser authorization.`)
      throw error
    }
  } else {
    const events = new EventEmitter()
    const callbackServer = setupCallbackServer({
      port: callbackPort,
      path: '/oauth/callback',
      events,
      authTimeoutMs,
    })
    cleanupServer = callbackServer.server
    waitForAuthCode = callbackServer.waitForAuthCode
    try {
      await waitForServerListening(callbackServer.server)
    } catch (error) {
      log(`Fatal error: cannot bind callback port ${callbackPort}`)
      throw error
    }
  }

  return {
    cleanupServer,
    authInitializer: async () => {
      if (!splitCallbackMode) {
        if (!waitForAuthCode) {
          throw new Error('OAuth callback listener was not initialized')
        }
        return {
          waitForAuthCode,
          skipBrowserAuth: false,
        }
      }

      const state = authProvider.state()
      const claimResult = await claimAuthLock(serverUrlHash, {
        state,
        serverUrlHash,
        serverUrl,
        resource: authorizeResource || serverUrl,
        timestamp: Date.now(),
        status: 'pending',
        pid: process.pid,
        port: callbackPort,
      })

      if (claimResult.role === 'waiter') {
        log(`Authentication already in progress for resource ${claimResult.lock.resource}`)
        return {
          waitForTokens: () => waitForTokens(authProvider, serverUrlHash, claimResult.lock.timestamp, claimResult.lock.state),
          skipBrowserAuth: true,
        }
      }

      if (claimResult.replacedStaleLock) {
        log(`Warning: stale auth lock detected for resource ${claimResult.replacedStaleLock.resource}. Replacing it.`)
      }

      log(`Split callback mode is enabled. Using listener on 127.0.0.1:${callbackPort} for browser consent.`)

      return {
        waitForTokens: () => waitForTokens(authProvider, serverUrlHash, claimResult.lock.timestamp, claimResult.lock.state),
        skipBrowserAuth: false,
      }
    },
  }
}

async function runListenerOnly(
  serverUrl: string,
  callbackPort: number,
  headers: Record<string, string>,
  transportStrategy: TransportStrategy,
  host: string,
  staticOAuthClientMetadata: StaticOAuthClientMetadata,
  staticOAuthClientInfo: StaticOAuthClientInformationFull,
  authTimeoutMs: number,
) {
  log(`Starting mcp-remote proxy ${MCP_REMOTE_VERSION}`)

  const events = new EventEmitter()
  const { server } = setupOAuthCallbackServerWithLongPoll({
    port: callbackPort,
    path: '/oauth/callback',
    events,
    authTimeoutMs,
    listenOnly: true,
  })

  try {
    await waitForServerListening(server)
  } catch (error) {
    log(`Fatal error: cannot bind callback port ${callbackPort}`)
    log(String(error))
    process.exit(1)
  }

  log(`Listener-only mode active on http://127.0.0.1:${callbackPort}/oauth/callback`)

  events.on('auth-code-received', async ({ code, state }: { code: string; state: string }) => {
    let serverUrlHash = ''
    try {
      const stateParts = state.split(':')
      if (stateParts.length !== 2 || !stateParts[0] || !stateParts[1]) {
        throw new Error(`Invalid OAuth state format: ${state}`)
      }
      serverUrlHash = stateParts[1]
      global.currentServerUrlHash = serverUrlHash

      const authLock = await readAuthLock(serverUrlHash)
      if (!authLock) {
        throw new Error(`No auth lock found for ${serverUrlHash}`)
      }
      if (authLock.serverUrlHash !== serverUrlHash) {
        throw new Error(`Auth lock hash mismatch for ${serverUrlHash}`)
      }
      if (authLock.state !== state) {
        throw new Error(`Auth lock state mismatch for ${serverUrlHash}`)
      }
      if (!authLock.codeVerifier) {
        throw new Error(`Auth lock missing code verifier for ${serverUrlHash}`)
      }
      if (isAuthLockStale(authLock.timestamp)) {
        throw new Error(`Auth lock is stale for ${serverUrlHash}`)
      }

      const callbackServerUrl = authLock.serverUrl || serverUrl
      const callbackResource = authLock.resource || callbackServerUrl
      const authProvider = await createAuthProvider(
        callbackServerUrl,
        callbackPort,
        headers,
        host,
        staticOAuthClientMetadata,
        staticOAuthClientInfo,
        callbackResource,
        false,
        serverUrlHash,
      )
      authProvider.setAuthLockState(authLock.state)
      const transport = createTransport(callbackServerUrl, headers, authProvider, transportStrategy)
      log(`Processing OAuth callback for resource ${callbackResource}`)
      await transport.finishAuth(code)
      await transport.close()
      await deleteAuthLockIfStateMatches(serverUrlHash, state)
      log(`OAuth callback completed for resource ${callbackResource}`)
    } catch (error) {
      log(`Error processing OAuth callback: ${error}`)
      if (serverUrlHash) {
        await markAuthLockStatusIfStateMatches(serverUrlHash, state, 'failed')
      }
    }
  })

  setupSignalHandlers(
    async () => {
      server.close()
    },
    {
      shutdownOnStdinEnd: false,
    },
  )
}

async function runProxy(
  serverUrl: string,
  callbackPort: number,
  callbackPortSpecified: boolean,
  listenOnly: boolean,
  headers: Record<string, string>,
  transportStrategy: TransportStrategy = 'http-first',
  host: string,
  staticOAuthClientMetadata: StaticOAuthClientMetadata,
  staticOAuthClientInfo: StaticOAuthClientInformationFull,
  authorizeResource: string,
  sendResource: boolean,
  ignoredTools: string[],
  authTimeoutMs: number,
  serverUrlHash: string,
) {
  if (listenOnly) {
    await runListenerOnly(
      serverUrl,
      callbackPort,
      headers,
      transportStrategy,
      host,
      staticOAuthClientMetadata,
      staticOAuthClientInfo,
      authTimeoutMs,
    )
    return
  }

  log(`Starting mcp-remote proxy ${MCP_REMOTE_VERSION}`)

  const authProvider = await createAuthProvider(
    serverUrl,
    callbackPort,
    headers,
    host,
    staticOAuthClientMetadata,
    staticOAuthClientInfo,
    authorizeResource,
    sendResource,
    serverUrlHash,
  )

  const localTransport = new FlexibleStdioServerTransport()
  let cleanupServer: Server | null = null

  try {
    const authMode = await prepareProxyAuthMode({
      splitCallbackMode: callbackPortSpecified,
      callbackPort,
      authTimeoutMs,
      authProvider,
      serverUrlHash,
      serverUrl,
      authorizeResource,
    })
    cleanupServer = authMode.cleanupServer
    const remoteTransport = await connectToRemoteServer(null, serverUrl, authProvider, headers, authMode.authInitializer, transportStrategy)

    mcpProxy({
      transportToClient: localTransport,
      transportToServer: remoteTransport,
      ignoredTools,
    })

    await localTransport.start()
    log('Local STDIO server running')
    log(`Proxy established successfully between local STDIO and remote ${remoteTransport.constructor.name}`)
    log('Press Ctrl+C to exit')

    setupSignalHandlers(async () => {
      await remoteTransport.close()
      await localTransport.close()
      if (cleanupServer) {
        cleanupServer.close()
      }
    })
  } catch (error) {
    log('Fatal error:', error)
    if (cleanupServer) {
      cleanupServer.close()
    }
    process.exit(1)
  }
}

async function main() {
  const {
    serverUrl,
    callbackPort,
    callbackPortSpecified,
    listenOnly,
    headers,
    transportStrategy,
    host,
    staticOAuthClientMetadata,
    staticOAuthClientInfo,
    authorizeResource,
    sendResource,
    ignoredTools,
    authTimeoutMs,
    serverUrlHash,
  } = await parseCommandLineArgs(process.argv.slice(2), 'Usage: npx tsx proxy.ts <https://server-url> [callback-port] [--debug]')

  await runProxy(
    serverUrl,
    callbackPort,
    callbackPortSpecified,
    listenOnly,
    headers,
    transportStrategy,
    host,
    staticOAuthClientMetadata,
    staticOAuthClientInfo,
    authorizeResource,
    sendResource,
    ignoredTools,
    authTimeoutMs,
    serverUrlHash,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    log('Fatal error:', error)
    process.exit(1)
  })
}
