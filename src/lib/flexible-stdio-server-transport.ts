import process from 'process'
import type { Readable, Writable } from 'stream'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js'
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js'

type StdioFraming = 'newline' | 'content-length'

/**
 * Accepts both MCP newline-delimited stdio and LSP-style Content-Length framed
 * JSON-RPC. Responses use the framing observed from the client.
 */
export class FlexibleStdioServerTransport implements Transport {
  private buffer = Buffer.alloc(0)
  private started = false
  private outputFraming: StdioFraming = 'newline'

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: <T extends JSONRPCMessage>(message: T) => void

  constructor(
    private readonly stdin: Readable = process.stdin,
    private readonly stdout: Writable = process.stdout,
  ) {}

  async start(): Promise<void> {
    if (this.started) {
      throw new Error('FlexibleStdioServerTransport already started')
    }
    this.started = true
    this.stdin.on('data', this.onData)
    this.stdin.on('error', this.onInputError)
  }

  async close(): Promise<void> {
    this.stdin.off('data', this.onData)
    this.stdin.off('error', this.onInputError)
    if (this.stdin.listenerCount('data') === 0) {
      this.stdin.pause()
    }
    this.buffer = Buffer.alloc(0)
    this.onclose?.()
  }

  send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    return new Promise((resolve) => {
      const json = JSON.stringify(message)
      const payload =
        this.outputFraming === 'content-length' ? `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}` : `${json}\n`

      if (this.stdout.write(payload)) {
        resolve()
      } else {
        this.stdout.once('drain', resolve)
      }
    })
  }

  private readonly onData = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.processBuffer()
  }

  private readonly onInputError = (error: Error) => {
    this.onerror?.(error)
  }

  private processBuffer(): void {
    while (this.buffer.length > 0) {
      const message = this.readNextMessage()
      if (message === null) {
        return
      }

      try {
        this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(message)))
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  private readNextMessage(): string | null {
    const buffered = this.buffer.toString('utf8')

    if (/^content-length:/i.test(buffered)) {
      return this.readContentLengthMessage(buffered)
    }

    const newlineIndex = this.buffer.indexOf('\n')
    if (newlineIndex === -1) {
      return null
    }

    this.outputFraming = 'newline'
    const line = this.buffer.toString('utf8', 0, newlineIndex).replace(/\r$/, '')
    this.buffer = this.buffer.subarray(newlineIndex + 1)

    if (!line.trim()) {
      return this.readNextMessage()
    }

    return line
  }

  private readContentLengthMessage(buffered: string): string | null {
    const headerEnd = buffered.indexOf('\r\n\r\n')
    if (headerEnd === -1) {
      return null
    }

    const header = buffered.slice(0, headerEnd)
    const match = /^Content-Length:\s*(\d+)$/im.exec(header)
    if (!match) {
      this.onerror?.(new Error('Invalid Content-Length stdio frame'))
      this.buffer = Buffer.alloc(0)
      return null
    }

    const bodyStart = Buffer.byteLength(buffered.slice(0, headerEnd + 4), 'utf8')
    const contentLength = Number(match[1])
    const bodyEnd = bodyStart + contentLength
    if (this.buffer.length < bodyEnd) {
      return null
    }

    this.outputFraming = 'content-length'
    const body = this.buffer.toString('utf8', bodyStart, bodyEnd)
    this.buffer = this.buffer.subarray(bodyEnd)
    return body
  }
}
