import path from 'path'
import os from 'os'
import fs from 'fs/promises'
import { log, MCP_REMOTE_VERSION } from './utils'

/**
 * MCP Remote Authentication Configuration
 *
 * This module handles the storage and retrieval of authentication-related data for MCP Remote.
 *
 * Configuration directory structure:
 * - The config directory is determined by MCP_REMOTE_CONFIG_DIR env var or defaults to ~/.mcp-auth
 * - Each file is prefixed with a hash of the server URL to separate configurations for different servers
 *
 * Files stored in the config directory:
 * - {server_hash}_client_info.json: Contains OAuth client registration information
 *   - Format: OAuthClientInformation object with client_id and other registration details
 * - {server_hash}_tokens.json: Contains OAuth access and refresh tokens
 *   - Format: OAuthTokens object with access_token, refresh_token, and expiration information
 * - {server_hash}_lock.json: Contains the active auth lock, including PKCE verifier and callback coordination state
 *   - Format: JSON object with state, resource, codeVerifier, timestamps, and callback metadata
 *
 * All JSON files are stored with 2-space indentation for readability.
 */

/**
 * Auth lock data structure
 */
export interface AuthLockData {
  state: string
  serverUrlHash: string
  serverUrl?: string
  resource: string
  codeVerifier?: string
  timestamp: number
  status: 'pending' | 'complete' | 'failed'
  pid?: number
  authorizationUrl?: string
  port?: number
}

export type AuthLockClaimResult =
  | {
      role: 'owner'
      lock: AuthLockData
      created: boolean
      replacedStaleLock?: AuthLockData
    }
  | {
      role: 'waiter'
      lock: AuthLockData
    }

const DEFAULT_AUTH_LOCK_TTL_MS = 10 * 60 * 1000
const AUTH_LOCK_MUTEX_STALE_MS = 30 * 1000
const AUTH_LOCK_MUTEX_POLL_MS = 25

function isFreshPendingAuthLock(lock: AuthLockData | null, staleAfterMs: number): lock is AuthLockData {
  return !!lock && lock.status === 'pending' && Date.now() - lock.timestamp <= staleAfterMs
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isExistingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST'
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function getAuthLockMutexFilePath(serverUrlHash: string): string {
  return `${getConfigFilePath(serverUrlHash, 'lock.json')}.mutex`
}

async function withAuthLockMutex<T>(serverUrlHash: string, action: () => Promise<T>): Promise<T> {
  await ensureConfigDir()
  const mutexPath = getAuthLockMutexFilePath(serverUrlHash)
  let ownsMutex = false

  while (!ownsMutex) {
    try {
      const handle = await fs.open(mutexPath, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, timestamp: Date.now() }, null, 2), 'utf-8')
      } finally {
        await handle.close()
      }
      ownsMutex = true
    } catch (error) {
      if (!isExistingFileError(error)) {
        throw error
      }

      try {
        const stats = await fs.stat(mutexPath)
        if (Date.now() - stats.mtimeMs > AUTH_LOCK_MUTEX_STALE_MS) {
          try {
            await fs.unlink(mutexPath)
          } catch (unlinkError) {
            if (!isMissingFileError(unlinkError)) {
              throw unlinkError
            }
          }
          continue
        }
      } catch (statError) {
        if (!isMissingFileError(statError)) {
          throw statError
        }
      }

      await sleep(AUTH_LOCK_MUTEX_POLL_MS)
    }
  }

  try {
    return await action()
  } finally {
    try {
      await fs.unlink(mutexPath)
    } catch (error) {
      if (!isMissingFileError(error)) {
        log(`Error deleting auth lock mutex:`, error)
      }
    }
  }
}

/**
 * Creates or updates an auth lock for the given server
 * @param serverUrlHash The hash of the server URL
 * @param lockData The auth lock contents
 */
export async function writeAuthLock(serverUrlHash: string, lockData: AuthLockData): Promise<void> {
  await writeJsonFile(serverUrlHash, 'lock.json', lockData)
}

/**
 * Reads the auth lock for the given server
 * @param serverUrlHash The hash of the server URL
 * @returns The auth lock data or null if it doesn't exist
 */
export async function readAuthLock(serverUrlHash: string): Promise<AuthLockData | null> {
  try {
    const lockfile = await readJsonFile<AuthLockData>(serverUrlHash, 'lock.json', {
      async parseAsync(data: any) {
        if (typeof data !== 'object' || data === null) return null
        if (
          typeof data.state !== 'string' ||
          typeof data.serverUrlHash !== 'string' ||
          typeof data.resource !== 'string' ||
          typeof data.timestamp !== 'number' ||
          typeof data.status !== 'string'
        ) {
          return null
        }
        return data as AuthLockData
      },
    })
    return lockfile || null
  } catch {
    return null
  }
}

/**
 * Deletes the auth lock for the given server
 * @param serverUrlHash The hash of the server URL
 */
export async function deleteAuthLock(serverUrlHash: string): Promise<void> {
  await deleteConfigFile(serverUrlHash, 'lock.json')
}

/**
 * Atomically claims the auth lock for one server hash. The first process creates
 * the lock with `wx`; later processes observe the existing fresh lock and wait.
 * Claim, metadata updates, deletes, and stale replacement share a sidecar mutex
 * so the active lock is never hidden while another process can claim ownership.
 */
export async function claimAuthLock(
  serverUrlHash: string,
  lockData: AuthLockData,
  staleAfterMs = DEFAULT_AUTH_LOCK_TTL_MS,
): Promise<AuthLockClaimResult> {
  return withAuthLockMutex(serverUrlHash, async () => {
    await ensureConfigDir()
    const filePath = getConfigFilePath(serverUrlHash, 'lock.json')
    const desiredLock = {
      ...lockData,
      serverUrlHash,
      status: 'pending' as const,
    }

    let replacedStaleLock: AuthLockData | undefined

    while (true) {
      try {
        const handle = await fs.open(filePath, 'wx', 0o600)
        try {
          await handle.writeFile(JSON.stringify(desiredLock, null, 2), 'utf-8')
        } finally {
          await handle.close()
        }
        return { role: 'owner', lock: desiredLock, created: true, replacedStaleLock }
      } catch (error) {
        if (!isExistingFileError(error)) {
          throw error
        }
      }

      const existingLock = await readAuthLock(serverUrlHash)
      if (isFreshPendingAuthLock(existingLock, staleAfterMs)) {
        if (existingLock.state === desiredLock.state) {
          return { role: 'owner', lock: existingLock, created: false, replacedStaleLock }
        }
        return { role: 'waiter', lock: existingLock }
      }

      replacedStaleLock = existingLock || undefined
      try {
        await fs.unlink(filePath)
      } catch (unlinkError) {
        if (!isMissingFileError(unlinkError)) {
          throw unlinkError
        }
      }
    }
  })
}

export async function updateAuthLockIfStateMatches(serverUrlHash: string, state: string, updates: Partial<AuthLockData>): Promise<boolean> {
  return withAuthLockMutex(serverUrlHash, async () => {
    const lock = await readAuthLock(serverUrlHash)
    if (!lock || lock.state !== state || lock.serverUrlHash !== serverUrlHash) {
      return false
    }

    const nextLock = {
      ...lock,
      ...updates,
      state: lock.state,
      serverUrlHash: lock.serverUrlHash,
    }

    const filePath = getConfigFilePath(serverUrlHash, 'lock.json')
    const nextPath = `${filePath}.${process.pid}.${Date.now()}.next`
    await fs.writeFile(nextPath, JSON.stringify(nextLock, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    })
    await fs.rename(nextPath, filePath)
    return true
  })
}

export async function markAuthLockStatusIfStateMatches(
  serverUrlHash: string,
  state: string,
  status: AuthLockData['status'],
): Promise<boolean> {
  return updateAuthLockIfStateMatches(serverUrlHash, state, { status })
}

export async function deleteAuthLockIfStateMatches(serverUrlHash: string, state: string): Promise<boolean> {
  return withAuthLockMutex(serverUrlHash, async () => {
    const lock = await readAuthLock(serverUrlHash)
    if (!lock || lock.state !== state || lock.serverUrlHash !== serverUrlHash) {
      return false
    }

    try {
      await fs.unlink(getConfigFilePath(serverUrlHash, 'lock.json'))
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error
      }
    }
    return true
  })
}

/**
 * Gets the configuration directory path
 * @returns The path to the configuration directory
 */
export function getConfigDir(): string {
  return process.env.MCP_REMOTE_CONFIG_DIR || path.join(os.homedir(), '.mcp-auth')
}

function getLegacyConfigDir(): string {
  return path.join(getConfigDir(), `mcp-remote-${MCP_REMOTE_VERSION}`)
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function getReadableConfigFilePath(serverUrlHash: string, filename: string): Promise<string> {
  const currentPath = getConfigFilePath(serverUrlHash, filename)
  if (await fileExists(currentPath)) {
    return currentPath
  }

  const legacyPath = path.join(getLegacyConfigDir(), `${serverUrlHash}_${filename}`)
  if (await fileExists(legacyPath)) {
    try {
      await ensureConfigDir()
      const legacyStat = await fs.stat(legacyPath)
      const content = await fs.readFile(legacyPath)
      const handle = await fs.open(currentPath, 'wx', 0o600)
      try {
        await handle.writeFile(content)
      } finally {
        await handle.close()
      }
      await fs.utimes(currentPath, legacyStat.atime, legacyStat.mtime)
    } catch (error) {
      if (!isExistingFileError(error)) {
        log(`Error migrating legacy ${filename}:`, error)
        return legacyPath
      }
    }
    return currentPath
  }

  return currentPath
}

/**
 * Ensures the configuration directory exists
 */
export async function ensureConfigDir(): Promise<void> {
  try {
    const configDir = getConfigDir()
    await fs.mkdir(configDir, { recursive: true })
  } catch (error) {
    log('Error creating config directory:', error)
    throw error
  }
}

/**
 * Gets the file path for a config file
 * @param serverUrlHash The hash of the server URL
 * @param filename The name of the file
 * @returns The absolute file path
 */
export function getConfigFilePath(serverUrlHash: string, filename: string): string {
  const configDir = getConfigDir()
  return path.join(configDir, `${serverUrlHash}_${filename}`)
}

export async function getConfigFileMtimeMs(serverUrlHash: string, filename: string): Promise<number | undefined> {
  try {
    const filePath = getConfigFilePath(serverUrlHash, filename)
    const stats = await fs.stat(filePath)
    return stats.mtimeMs
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined
    }
    throw error
  }
}

/**
 * Deletes a config file if it exists
 * @param serverUrlHash The hash of the server URL
 * @param filename The name of the file to delete
 */
export async function deleteConfigFile(serverUrlHash: string, filename: string): Promise<void> {
  const filePaths = [getConfigFilePath(serverUrlHash, filename), path.join(getLegacyConfigDir(), `${serverUrlHash}_${filename}`)]

  for (const filePath of filePaths) {
    try {
      await fs.unlink(filePath)
    } catch (error) {
      // Ignore if file doesn't exist
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log(`Error deleting ${filename}:`, error)
      }
    }
  }
}

/**
 * Reads a JSON file and parses it with the provided schema
 * @param serverUrlHash The hash of the server URL
 * @param filename The name of the file to read
 * @param schema The schema to validate against
 * @returns The parsed file content or undefined if the file doesn't exist
 */
export async function readJsonFile<T>(serverUrlHash: string, filename: string, schema: any): Promise<T | undefined> {
  try {
    await ensureConfigDir()

    const filePath = await getReadableConfigFilePath(serverUrlHash, filename)
    const content = await fs.readFile(filePath, 'utf-8')
    const result = await schema.parseAsync(JSON.parse(content))
    // console.log({ filename: result })
    return result
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // console.log(`File ${filename} does not exist`)
      return undefined
    }
    log(`Error reading ${filename}:`, error)
    return undefined
  }
}

/**
 * Writes a JSON object to a file
 * @param serverUrlHash The hash of the server URL
 * @param filename The name of the file to write
 * @param data The data to write
 */
export async function writeJsonFile(serverUrlHash: string, filename: string, data: any): Promise<void> {
  try {
    await ensureConfigDir()
    const filePath = getConfigFilePath(serverUrlHash, filename)
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 })
  } catch (error) {
    log(`Error writing ${filename}:`, error)
    throw error
  }
}

/**
 * Reads a text file
 * @param serverUrlHash The hash of the server URL
 * @param filename The name of the file to read
 * @param errorMessage Optional custom error message
 * @returns The file content as a string
 */
export async function readTextFile(serverUrlHash: string, filename: string, errorMessage?: string): Promise<string> {
  try {
    await ensureConfigDir()
    const filePath = await getReadableConfigFilePath(serverUrlHash, filename)
    return await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    throw new Error(errorMessage || `Error reading ${filename}`)
  }
}

/**
 * Writes a text string to a file
 * @param serverUrlHash The hash of the server URL
 * @param filename The name of the file to write
 * @param text The text to write
 */
export async function writeTextFile(serverUrlHash: string, filename: string, text: string): Promise<void> {
  try {
    await ensureConfigDir()
    const filePath = getConfigFilePath(serverUrlHash, filename)
    await fs.writeFile(filePath, text, { encoding: 'utf-8', mode: 0o600 })
  } catch (error) {
    log(`Error writing ${filename}:`, error)
    throw error
  }
}
