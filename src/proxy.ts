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
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
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
import { deleteAuthLock, readAuthLock, writeAuthLock } from './lib/mcp-auth-config'

const AUTH_LOCK_TTL_MS = 10 * 60 * 1000
const TOKEN_WAIT_TIMEOUT_MS = 10 * 60 * 1000
const TOKEN_WAIT_POLL_MS = 3000

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

async function waitForTokens(authProvider: NodeOAuthClientProvider): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < TOKEN_WAIT_TIMEOUT_MS) {
    const tokens = await authProvider.tokens()
    if (tokens?.access_token) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, TOKEN_WAIT_POLL_MS))
  }
  throw new Error('Timed out waiting for shared token exchange to complete')
}

async function createAuthProvider(
  serverUrl: string,
  callbackPort: number,
  headers: Record<string, string>,
  host: string,
  staticOAuthClientMetadata: StaticOAuthClientMetadata,
  staticOAuthClientInfo: StaticOAuthClientInformationFull,
  authorizeResource: string,
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
  log(`Starting mcp-remote proxy ${MCP_REMOTE_VERSION} (local patched build)`)

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
      if (!authLock.resource) {
        throw new Error(`Auth lock missing resource for ${serverUrlHash}`)
      }
      if (isAuthLockStale(authLock.timestamp)) {
        throw new Error(`Auth lock is stale for ${serverUrlHash}`)
      }

      const authProvider = await createAuthProvider(
        serverUrl,
        callbackPort,
        headers,
        host,
        staticOAuthClientMetadata,
        staticOAuthClientInfo,
        authLock.resource,
        serverUrlHash,
      )
      const transport = createTransport(serverUrl, headers, authProvider, transportStrategy)
      log(`Processing OAuth callback for resource ${authLock.resource}`)
      await transport.finishAuth(code)
      await transport.close()
      await deleteAuthLock(serverUrlHash)
      log(`OAuth callback completed for resource ${authLock.resource}`)
    } catch (error) {
      log(`Error processing OAuth callback: ${error}`)
      if (serverUrlHash) {
        await deleteAuthLock(serverUrlHash)
      }
    }
  })

  setupSignalHandlers(async () => {
    server.close()
  })
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

  log(`Starting mcp-remote proxy ${MCP_REMOTE_VERSION} (local patched build)`)

  const authProvider = await createAuthProvider(
    serverUrl,
    callbackPort,
    headers,
    host,
    staticOAuthClientMetadata,
    staticOAuthClientInfo,
    authorizeResource,
    serverUrlHash,
  )

  const localTransport = new StdioServerTransport()
  let cleanupServer: any = null

  const authInitializer = async () => {
    if (!callbackPortSpecified) {
      const events = new EventEmitter()
      const { server, waitForAuthCode } = setupOAuthCallbackServerWithLongPoll({
        port: callbackPort,
        path: '/oauth/callback',
        events,
        authTimeoutMs,
      })
      cleanupServer = server
      return {
        waitForAuthCode,
        skipBrowserAuth: false,
      }
    }

    const existingLock = await readAuthLock(serverUrlHash)
    if (existingLock && !isAuthLockStale(existingLock.timestamp)) {
      log(`Authentication already in progress for resource ${existingLock.resource}`)
      return {
        waitForTokens: () => waitForTokens(authProvider),
        skipBrowserAuth: true,
      }
    }

    if (existingLock && isAuthLockStale(existingLock.timestamp)) {
      log(`Warning: stale auth lock detected for resource ${existingLock.resource}. Replacing it.`)
      await deleteAuthLock(serverUrlHash)
    }

    const state = authProvider.state()
    await writeAuthLock(serverUrlHash, {
      state,
      serverUrlHash,
      resource: authorizeResource || '',
      timestamp: Date.now(),
      status: 'pending',
      pid: process.pid,
      port: callbackPort,
    })

    log(
      `Warning: fixed callback mode is enabled. Start a listener with --listen-only on 127.0.0.1:${callbackPort} before completing browser consent.`,
    )

    return {
      waitForTokens: () => waitForTokens(authProvider),
      skipBrowserAuth: false,
    }
  }

  try {
    const remoteTransport = await connectToRemoteServer(null, serverUrl, authProvider, headers, authInitializer, transportStrategy)

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

parseCommandLineArgs(process.argv.slice(2), 'Usage: npx tsx proxy.ts <https://server-url> [callback-port] [--debug]')
  .then(
    ({
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
      ignoredTools,
      authTimeoutMs,
      serverUrlHash,
    }) => {
      return runProxy(
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
        ignoredTools,
        authTimeoutMs,
        serverUrlHash,
      )
    },
  )
  .catch((error) => {
    log('Fatal error:', error)
    process.exit(1)
  })
