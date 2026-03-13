import type { WalkingPadLastStatus, WalkingPadLiveStatus, WalkingPadProtocolType } from './walkingPadProtocol'
import type {
  WalkingPadCommandRequest,
  WalkingPadServerEvent,
  WalkingPadServerState,
} from './walkingPadApi'

type WalkingPadEvent =
  | { type: 'connected'; deviceName: string; protocol: WalkingPadProtocolType }
  | { type: 'disconnected' }
  | { type: 'current-status'; status: WalkingPadLiveStatus }
  | { type: 'last-status'; status: WalkingPadLastStatus }
  | { type: 'error'; error: Error }
  | { type: 'machine-status'; code: number; message: string }

type WalkingPadListener = (event: WalkingPadEvent) => void

const API_ORIGIN = (import.meta.env.VITE_WALKINGPAD_API_ORIGIN ?? '').replace(/\/$/, '')
const API_BASE = `${API_ORIGIN}/api`

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

async function parseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T | { error?: string }

  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `WalkingPad API request failed with ${response.status}.`
    throw new Error(message)
  }

  return payload as T
}

export class WalkingPadController {
  private listeners = new Set<WalkingPadListener>()
  private eventSource: EventSource | null = null
  private streamErrorReported = false

  subscribe(listener: WalkingPadListener) {
    this.listeners.add(listener)
    this.ensureEventStream()
    return () => this.listeners.delete(listener)
  }

  async initialize() {
    this.ensureEventStream()
    return this.getState()
  }

  async getState() {
    const response = await fetch(`${API_BASE}/state`)
    return parseJson<WalkingPadServerState>(response)
  }

  async connect(deviceId?: string) {
    await this.post('/connect', deviceId ? { deviceId } : {})
  }

  async disconnect() {
    await this.post('/disconnect', {})
  }

  async switchMode(mode: number) {
    await this.runCommand({ type: 'switch-mode', mode })
  }

  async changeSpeed(speedTenthsKmh: number) {
    await this.runCommand({ type: 'set-speed', speedTenthsKmh })
  }

  async stopBelt() {
    await this.runCommand({ type: 'stop' })
  }

  async startBelt() {
    await this.runCommand({ type: 'start' })
  }

  async askStats() {
    await this.runCommand({ type: 'ask-stats' })
  }

  async resumeAt(speedTenthsKmh: number) {
    await this.runCommand({ type: 'resume', speedTenthsKmh })
  }

  private emit(event: WalkingPadEvent) {
    this.listeners.forEach((listener) => listener(event))
  }

  private async runCommand(command: WalkingPadCommandRequest) {
    await this.post('/command', command)
  }

  private async post(path: string, payload: object) {
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })

      await parseJson(response)
    } catch (error) {
      const nextError = toError(error)
      this.emit({ type: 'error', error: nextError })
      throw nextError
    }
  }

  private ensureEventStream() {
    if (this.eventSource) {
      return
    }

    this.eventSource = new EventSource(`${API_BASE}/events`)
    this.eventSource.onopen = () => {
      this.streamErrorReported = false
    }
    this.eventSource.onerror = () => {
      if (this.streamErrorReported) {
        return
      }

      this.streamErrorReported = true
      this.emit({ type: 'error', error: new Error('Local WalkingPad service is unavailable.') })
    }
    this.eventSource.onmessage = (message) => {
      const event = JSON.parse(message.data) as WalkingPadServerEvent

      if (event.type === 'connected') {
        this.emit(event)
        return
      }

      if (event.type === 'disconnected') {
        this.emit(event)
        return
      }

      if (event.type === 'current-status') {
        this.emit(event)
        return
      }

      if (event.type === 'last-status') {
        this.emit(event)
        return
      }

      if (event.type === 'machine-status') {
        this.emit(event)
        return
      }

      if (event.type === 'error') {
        this.emit({ type: 'error', error: new Error(event.message) })
      }
    }
  }
}
