import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { TelemetryStore } from './telemetryStore'
import { wakeWalkingPad } from './wakeAdvertiser'
import { WalkingPadBleService } from './walkingPadBleService'
import type {
  WalkingPadAnalyticsRange,
  WalkingPadCommandRequest,
  WalkingPadLiveSnapshot,
  WalkingPadServerEvent,
  WalkingPadServerState,
} from '../src/lib/walkingPadApi'

const service = new WalkingPadBleService()
const telemetry = new TelemetryStore()
const sseClients = new Set<ServerResponse<IncomingMessage>>()
const socketClients = new Set<WebSocket>()
const port = Number(process.env.WALKINGPAD_SERVER_PORT ?? 8788)
const redirectPort = Number(process.env.WALKINGPAD_REDIRECT_PORT ?? 8787)
const host = process.env.WALKINGPAD_SERVER_HOST ?? '127.0.0.1'
const distPath = path.resolve(process.cwd(), 'dist')
const autoConnect = process.env.WALKINGPAD_AUTO_CONNECT !== '0'
const autoScanMs = positiveNumber(process.env.WALKINGPAD_AUTO_SCAN_MS, 10_000)
const autoRetryMs = nonNegativeNumber(process.env.WALKINGPAD_AUTO_RETRY_MS, 0)
const staleLinkMs = positiveNumber(process.env.WALKINGPAD_STALE_LINK_MS, 45_000)
const maxClientBufferBytes = positiveNumber(process.env.WALKINGPAD_MAX_CLIENT_BUFFER_BYTES, 64 * 1024)
let wakeInProgress = false

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
  return writeSseChunk(response, `data: ${JSON.stringify(event)}\n\n`)
}

function writeSseChunk(response: ServerResponse, chunk: string) {
  if (response.destroyed || response.writableEnded || response.writableLength > maxClientBufferBytes) {
    closeSseClient(response)
    return false
  }

  const accepted = response.write(chunk)
  if (!accepted && response.writableLength > maxClientBufferBytes) {
    closeSseClient(response)
    return false
  }

  return true
}

function closeSseClient(response: ServerResponse) {
  sseClients.delete(response)
  response.destroy()
}

function publishEvent(event: WalkingPadServerEvent) {
  for (const client of sseClients) {
    writeSse(client, event)
  }

  if (
    event.type === 'current-status' ||
    event.type === 'connected' ||
    event.type === 'disconnected' ||
    event.type === 'session-status' ||
    event.type === 'machine-status' ||
    event.type === 'scanning' ||
    event.type === 'devices'
  ) {
    broadcastLive()
  }
}

function liveSnapshot(): WalkingPadLiveSnapshot {
  const state = service.getState()
  return telemetry.getLiveSnapshot({
    connectionState: state.connectionState,
    deviceName: state.deviceName,
  })
}

function stateWithLive(): WalkingPadServerState {
  return {
    ...service.getState(),
    live: liveSnapshot(),
  }
}

function broadcastLive() {
  const message = JSON.stringify(liveSnapshot())

  for (const client of socketClients) {
    if (client.readyState !== WebSocket.OPEN) {
      socketClients.delete(client)
      continue
    }

    if (client.bufferedAmount > maxClientBufferBytes) {
      socketClients.delete(client)
      client.terminate()
      continue
    }

    client.send(message, (error) => {
      if (error) {
        socketClients.delete(client)
        client.terminate()
      }
    })
  }
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

function analyticsRange(value: string | null): WalkingPadAnalyticsRange {
  if (
    value === 'today' ||
    value === '7d' ||
    value === '30d' ||
    value === '90d' ||
    value === 'year' ||
    value === 'all'
  ) {
    return value
  }

  return 'today'
}

service.subscribe((event) => {
  if (event.type === 'current-status') {
    const state = service.getState()
    telemetry.recordStatus(event.status, {
      connectionState: state.connectionState,
      deviceName: state.deviceName,
    })
  }

  if (event.type === 'session-status') {
    const state = service.getState()
    telemetry.recordVendorSession(event.session, {
      connectionState: state.connectionState,
      deviceName: state.deviceName,
    })
  }

  publishEvent(event)
})

const keepAliveInterval = setInterval(() => {
  for (const client of sseClients) {
    writeSseChunk(client, ': keepalive\n\n')
  }
  broadcastLive()
}, 15000)
keepAliveInterval.unref()

const server = createServer(async (request, response) => {
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
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url)
      return
    }

    if (request.method === 'GET') {
      await serveStatic(response, url.pathname)
      return
    }

    json(response, 404, { error: 'Not found' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected server error.'
    const event: WalkingPadServerEvent = { type: 'error', message }
    publishEvent(event)
    json(response, 500, { error: message })
  }
})

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (socket) => {
  socketClients.add(socket)
  socket.send(JSON.stringify(liveSnapshot()), (error) => {
    if (error) {
      socketClients.delete(socket)
      socket.terminate()
    }
  })
  socket.on('close', () => socketClients.delete(socket))
  socket.on('error', () => socketClients.delete(socket))
})

server.listen(port, host, () => {
  console.log(`WalkingPad server listening on http://${host}:${port}`)
  console.log(`WalkingPad live WebSocket listening on ws://${host}:${port}/ws`)

  if (autoConnect) {
    stopTrackingLoop = startTrackingLoop()
  }
})

if (redirectPort > 0 && redirectPort !== port) {
  createServer((request, response) => {
    const requestHost = request.headers.host?.replace(/:\d+$/, '') || '127.0.0.1'
    const location = `http://${requestHost}:${port}${request.url ?? '/'}`
    response.writeHead(307, { Location: location })
    response.end(`WalkingPad moved to ${location}\n`)
  }).listen(redirectPort, host, () => {
    console.log(`WalkingPad redirect listening on http://${host}:${redirectPort}`)
  })
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    json(response, 200, { ok: true })
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/state') {
    json(response, 200, stateWithLive())
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/live') {
    json(response, 200, liveSnapshot())
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/analytics') {
    const range = analyticsRange(url.searchParams.get('range'))
    const state = service.getState()
    json(response, 200, telemetry.getAnalytics(range, {
      connectionState: state.connectionState,
      deviceName: state.deviceName,
    }))
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
    sseClients.add(response)
    writeSseChunk(response, ': connected\n\n')
    request.on('close', () => {
      sseClients.delete(response)
    })
    response.on('error', () => {
      closeSseClient(response)
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
    broadcastLive()
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/disconnect') {
    json(response, 200, await service.disconnect())
    broadcastLive()
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/command') {
    const body = (await readJson(request)) as WalkingPadCommandRequest

    if (body.type === 'wake') {
      if (wakeInProgress) {
        json(response, 409, { ok: false, message: 'Wake replay is already running.' })
        return
      }

      wakeInProgress = true
      try {
        publishEvent({ type: 'machine-status', code: 0, message: 'Preparing BLE adapter for wake replay.' })
        await service.disconnect()
        const result = await wakeWalkingPad()
        publishEvent({
          type: 'machine-status',
          code: result.ok ? 1 : 0,
          message: result.message,
        })
        json(response, result.ok ? 200 : 409, result)
      } finally {
        wakeInProgress = false
      }
      return
    }

    json(response, 200, await service.runCommand(body))
    broadcastLive()
    return
  }

  json(response, 404, { error: 'Not found' })
}

async function serveStatic(response: ServerResponse, pathname: string) {
  const filePath = await resolveStaticPath(pathname)
  const extension = path.extname(filePath)
  const contentType = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  }[extension] ?? 'application/octet-stream'

  response.writeHead(200, { 'Content-Type': contentType })
  createReadStream(filePath).pipe(response)
}

async function resolveStaticPath(pathname: string) {
  const normalized = decodeURIComponent(pathname).replace(/^\/+/, '')
  const candidate = path.resolve(distPath, normalized || 'index.html')

  if (!candidate.startsWith(distPath)) {
    return path.resolve(distPath, 'index.html')
  }

  try {
    const candidateStat = await stat(candidate)
    if (candidateStat.isFile()) {
      return candidate
    }
  } catch {
    return path.resolve(distPath, 'index.html')
  }

  return path.resolve(distPath, 'index.html')
}

function startTrackingLoop() {
  let stopped = false

  const loop = async () => {
    console.log(`WalkingPad auto-connect loop active: scan=${autoScanMs}ms retry=${autoRetryMs}ms stale=${staleLinkMs}ms`)

    while (!stopped) {
      if (wakeInProgress) {
        await delay(1000)
        continue
      }

      const state = service.getState()

      if (state.connectionState === 'connected') {
        if (service.isStaleConnectedLink(staleLinkMs)) {
          await service.recoverStaleConnectedLink()
          continue
        }

        await delay(1000)
        continue
      }

      if (state.connectionState === 'connecting') {
        await delay(1000)
        continue
      }

      try {
        await service.connect(undefined, autoScanMs)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Auto-connect failed.'
        publishEvent({ type: 'machine-status', code: 0, message })
        if (autoRetryMs > 0) {
          await delay(autoRetryMs)
        }
      }
    }
  }

  void loop()
  return () => {
    stopped = true
  }
}

let shuttingDown = false

async function shutdown() {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  stopTrackingLoop?.()
  clearInterval(keepAliveInterval)

  try {
    await withTimeout(service.disconnect(), 12_000, 'BLE shutdown disconnect')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`BLE shutdown disconnect did not complete: ${message}`)
  }

  for (const client of socketClients) {
    client.close()
  }

  for (const client of sseClients) {
    client.end()
  }

  telemetry.close()
  server.close(() => {
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 1500).unref()
}

let stopTrackingLoop: (() => void) | null = null

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  })
}

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

process.once('SIGINT', () => {
  void shutdown()
})
process.once('SIGTERM', () => {
  void shutdown()
})
