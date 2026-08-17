import { getConfigFileMtimeMs, readAuthLock } from './mcp-auth-config'
import type { NodeOAuthClientProvider } from './node-oauth-client-provider'

const TOKEN_WAIT_TIMEOUT_MS = 10 * 60 * 1000
const TOKEN_WAIT_POLL_MS = 3000

export async function waitForTokens(
  authProvider: NodeOAuthClientProvider,
  serverUrlHash: string,
  tokenNotBeforeMs: number,
  authState?: string,
  {
    timeoutMs = TOKEN_WAIT_TIMEOUT_MS,
    pollMs = TOKEN_WAIT_POLL_MS,
  }: {
    timeoutMs?: number
    pollMs?: number
  } = {},
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const tokenMtimeMs = await getConfigFileMtimeMs(serverUrlHash, 'tokens.json')
    const tokens = tokenMtimeMs === undefined || tokenMtimeMs < tokenNotBeforeMs ? undefined : await authProvider.tokens()
    // A waiter only accepts a token file written at or after the auth attempt it is waiting on.
    // That prevents a stale cache file from satisfying a wait after this process already saw Unauthorized.
    if (tokens?.access_token && tokenMtimeMs !== undefined && tokenMtimeMs >= tokenNotBeforeMs) {
      return
    }
    if (authState) {
      const lock = await readAuthLock(serverUrlHash)
      if (lock?.state === authState && lock.status === 'failed') {
        throw new Error('Shared token exchange failed')
      }
      if (lock && lock.state !== authState && lock.timestamp >= tokenNotBeforeMs) {
        throw new Error('Shared token exchange was replaced by another auth attempt')
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  throw new Error('Timed out waiting for shared token exchange to complete')
}
