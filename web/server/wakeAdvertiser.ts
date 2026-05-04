import { exec } from 'node:child_process'
import { spawn } from 'node:child_process'
import { promisify } from 'node:util'
import {
  DEFAULT_REMOTE_WAKE_ADDRESS,
  DEFAULT_REMOTE_WAKE_NAME,
} from '../src/lib/walkingPadProtocol'

const execAsync = promisify(exec)
const DEFAULT_WAKE_DURATION_MS = 8000

export interface WakeResult {
  ok: boolean
  message: string
}

export async function wakeWalkingPad(): Promise<WakeResult> {
  const customCommand = process.env.WALKINGPAD_WAKE_COMMAND
  const durationMs = Number(process.env.WALKINGPAD_WAKE_DURATION_MS || DEFAULT_WAKE_DURATION_MS)

  if (customCommand) {
    const { stdout, stderr } = await execAsync(customCommand, {
      timeout: Math.max(durationMs + 5000, 10_000),
    })
    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
    return {
      ok: true,
      message: output || 'Custom wake command completed.',
    }
  }

  if (process.platform !== 'linux') {
    return {
      ok: false,
      message:
        'Wake replay needs Linux/BlueZ on the Pi, or set WALKINGPAD_WAKE_COMMAND to a custom wake script.',
    }
  }

  const wakeAddress = process.env.WALKINGPAD_WAKE_ADDRESS || DEFAULT_REMOTE_WAKE_ADDRESS
  try {
    await runBluetoothctl([
      'menu advertise',
      'clear',
      `name ${DEFAULT_REMOTE_WAKE_NAME}`,
      'uuids 0000fff0-0000-1000-8000-00805f9b34fb',
      'manufacturer 0x00c1 0x00 0x00 0x30 0x3f',
      'back',
      'advertise on',
    ])
    await delay(durationMs)
  } finally {
    await runBluetoothctl(['advertise off'], 5000).catch(() => undefined)
  }

  return {
    ok: true,
    message:
      `Replayed ${DEFAULT_REMOTE_WAKE_NAME} wake advertisement for ${Math.round(durationMs / 1000)}s. ` +
      `If the treadmill stays asleep, configure the Pi adapter identity as ${wakeAddress} or provide WALKINGPAD_WAKE_COMMAND.`,
  }
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function runBluetoothctl(commands: string[], timeoutMs = 10_000) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('bluetoothctl', [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    let settled = false
    const timeoutId = setTimeout(() => {
      if (settled) {
        return
      }

      settled = true
      child.kill('SIGTERM')
      reject(new Error(`bluetoothctl timed out after ${timeoutMs}ms.`))
    }, timeoutMs)

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeoutId)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeoutId)
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(stderr.trim() || `bluetoothctl exited with status ${code}.`))
      }
    })

    child.stdin.end(`${commands.join('\n')}\nquit\n`)
  })
}
