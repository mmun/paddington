import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { WalkingPadBleService } from './walkingPadBleService'
import type { WalkingPadCommandRequest, WalkingPadServerEvent } from '../src/lib/walkingPadApi'

const service = new WalkingPadBleService()
const clients = new Set<ServerResponse<IncomingMessage>>()
const port = Number(process.env.WALKINGPAD_SERVER_PORT ?? 8788)

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(body))
}

function writeSse(response: ServerResponse, event: WalkingPadServerEvent) {
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (chunks.length === 0) {
    return {}
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

service.subscribe((event) => {
  for (const client of clients) {
    writeSse(client, event)
  }
})

setInterval(() => {
  for (const client of clients) {
    client.write(': keepalive\n\n')
  }
}, 15000).unref()

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    })
    response.end()
    return
  }

  try {
    if (request.method === 'GET' && url.pathname === '/api/health') {
      json(response, 200, { ok: true })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/state') {
      json(response, 200, service.getState())
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/devices') {
      json(response, 200, service.getState().devices)
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/events') {
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(': connected\n\n')
      clients.add(response)
      request.on('close', () => {
        clients.delete(response)
      })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/scan') {
      json(response, 200, await service.scanDevices())
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/connect') {
      const body = await readJson(request)
      const deviceId = typeof body.deviceId === 'string' ? body.deviceId : undefined
      json(response, 200, await service.connect(deviceId))
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/disconnect') {
      json(response, 200, await service.disconnect())
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/command') {
      const body = (await readJson(request)) as WalkingPadCommandRequest
      json(response, 200, await service.runCommand(body))
      return
    }

    json(response, 404, { error: 'Not found' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected server error.'
    const event: WalkingPadServerEvent = { type: 'error', message }
    for (const client of clients) {
      writeSse(client, event)
    }
    json(response, 500, { error: message })
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`WalkingPad BLE server listening on http://127.0.0.1:${port}`)
})
