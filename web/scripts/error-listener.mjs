import { appendFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'

const HOST = process.env.ERROR_LISTENER_HOST ?? '127.0.0.1'
const PORT = Number(process.env.ERROR_LISTENER_PORT ?? '8787')
const LOG_PATH = resolve(process.cwd(), 'tmp/client-errors.ndjson')

mkdirSync(dirname(LOG_PATH), { recursive: true })

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

const server = createServer((request, response) => {
  if (request.method === 'OPTIONS') {
    writeJson(response, 204, {})
    return
  }

  if (request.method === 'GET' && request.url === '/health') {
    writeJson(response, 200, { ok: true, host: HOST, port: PORT, logPath: LOG_PATH })
    return
  }

  if (request.method !== 'POST' || request.url !== '/client-error') {
    writeJson(response, 404, { ok: false, error: 'Not found' })
    return
  }

  const chunks = []

  request.on('data', (chunk) => {
    chunks.push(chunk)
  })

  request.on('end', () => {
    try {
      const body = Buffer.concat(chunks).toString('utf8')
      const payload = JSON.parse(body)
      const entry = {
        receivedAt: new Date().toISOString(),
        ...payload,
      }

      appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8')
      console.log(`\n[client-error] ${entry.receivedAt}`)
      console.log(JSON.stringify(entry, null, 2))

      writeJson(response, 200, { ok: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid payload'
      writeJson(response, 400, { ok: false, error: message })
    }
  })
})

server.listen(PORT, HOST, () => {
  console.log(`Listening for client errors on http://${HOST}:${PORT}/client-error`)
  console.log(`Writing reports to ${LOG_PATH}`)
})
