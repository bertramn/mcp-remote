import { PassThrough } from 'stream'
import { describe, expect, it } from 'vitest'
import { FlexibleStdioServerTransport } from './flexible-stdio-server-transport'

function waitForMessage(transport: FlexibleStdioServerTransport): Promise<any> {
  return new Promise((resolve) => {
    transport.onmessage = resolve
  })
}

describe('FlexibleStdioServerTransport', () => {
  it('reads newline-delimited JSON-RPC and responds with newline framing', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const transport = new FlexibleStdioServerTransport(stdin, stdout)
    await transport.start()

    const messagePromise = waitForMessage(transport)
    stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n')

    await expect(messagePromise).resolves.toMatchObject({ id: 1, method: 'initialize' })

    const outputPromise = new Promise<string>((resolve) => stdout.once('data', (chunk) => resolve(chunk.toString('utf8'))))
    await transport.send({ jsonrpc: '2.0', id: 1, result: {} })

    await expect(outputPromise).resolves.toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n')
  })

  it('reads Content-Length framed JSON-RPC and responds with Content-Length framing', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const transport = new FlexibleStdioServerTransport(stdin, stdout)
    await transport.start()

    const input = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
    const messagePromise = waitForMessage(transport)
    stdin.write(`Content-Length: ${Buffer.byteLength(input, 'utf8')}\r\n\r\n${input}`)

    await expect(messagePromise).resolves.toMatchObject({ id: 1, method: 'initialize' })

    const outputPromise = new Promise<string>((resolve) => stdout.once('data', (chunk) => resolve(chunk.toString('utf8'))))
    await transport.send({ jsonrpc: '2.0', id: 1, result: {} })

    const expectedBody = '{"jsonrpc":"2.0","id":1,"result":{}}'
    await expect(outputPromise).resolves.toBe(`Content-Length: ${Buffer.byteLength(expectedBody, 'utf8')}\r\n\r\n${expectedBody}`)
  })

  it('reads fragmented Content-Length frames case-insensitively', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const transport = new FlexibleStdioServerTransport(stdin, stdout)
    await transport.start()

    const input = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
    const messagePromise = waitForMessage(transport)
    const frame = `content-length: ${Buffer.byteLength(input, 'utf8')}\r\n\r\n${input}`
    stdin.write(frame.slice(0, 20))
    stdin.write(frame.slice(20))

    await expect(messagePromise).resolves.toMatchObject({ id: 2, method: 'tools/list' })
  })

  it('reads multiple newline messages from one chunk', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const transport = new FlexibleStdioServerTransport(stdin, stdout)
    await transport.start()

    const messages: any[] = []
    transport.onmessage = (message) => messages.push(message)

    stdin.write(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n',
    )

    await new Promise((resolve) => setImmediate(resolve))
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ id: 1, method: 'initialize' })
    expect(messages[1]).toMatchObject({ method: 'notifications/initialized' })
  })
})
