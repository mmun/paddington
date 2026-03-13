export const WALKINGPAD_SERVICE_UUID = '0000fe00-0000-1000-8000-00805f9b34fb'
export const WALKINGPAD_NOTIFY_UUID = '0000fe01-0000-1000-8000-00805f9b34fb'
export const WALKINGPAD_WRITE_UUID = '0000fe02-0000-1000-8000-00805f9b34fb'
export const FTMS_SERVICE_UUID = '00001826-0000-1000-8000-00805f9b34fb'
export const FTMS_TREADMILL_DATA_UUID = '00002acd-0000-1000-8000-00805f9b34fb'
export const FTMS_CONTROL_POINT_UUID = '00002ad9-0000-1000-8000-00805f9b34fb'
export const FTMS_STATUS_UUID = '00002ada-0000-1000-8000-00805f9b34fb'

export const KM_TO_MI = 0.621371
export const KMH_TO_MPH = 0.621371
export const KCAL_PER_MILE = 95

export const MIN_SPEED_KMH = 1
export const MAX_SPEED_KMH = 6
export const SLOW_WALK_SPEED_KMH = 4.5
export const SPEED_STEP_KMH = 0.6
export const COMMAND_GAP_MS = 690

export const WalkingPadMode = {
  Automatic: 0,
  Manual: 1,
  Standby: 2,
} as const

export type WalkingPadMode = (typeof WalkingPadMode)[keyof typeof WalkingPadMode]

export const FtmsControlOpcode = {
  RequestControl: 0x00,
  Reset: 0x01,
  SetTargetSpeed: 0x02,
  StartOrResume: 0x07,
  StopOrPause: 0x08,
  ResponseCode: 0x80,
} as const

export const FtmsStopPauseCode = {
  Stop: 0x01,
  Pause: 0x02,
} as const

export const FtmsResultCode = {
  Success: 0x01,
  NotSupported: 0x02,
  InvalidParameter: 0x03,
  Failed: 0x04,
  NotPermitted: 0x05,
} as const

export type WalkingPadProtocolType = 'legacy' | 'ftms'

export interface WalkingPadLiveStatus {
  protocol: WalkingPadProtocolType
  raw: Uint8Array
  speedKmh: number
  distanceKm: number
  steps: number
  elapsedSeconds: number | null
}

export interface WalkingPadCurrentStatus {
  raw: Uint8Array
  beltState: number
  speed: number
  manualMode: number
  time: number
  dist: number
  steps: number
  appSpeed: number
  controllerButton: number
}

export interface WalkingPadLastStatus {
  raw: Uint8Array
  time: number
  dist: number
  steps: number
}

export interface FtmsControlResponse {
  requestCode: number
  resultCode: number
}

export type WalkingPadMessage =
  | { kind: 'current-status'; status: WalkingPadCurrentStatus }
  | { kind: 'last-status'; status: WalkingPadLastStatus }
  | { kind: 'unknown'; raw: Uint8Array }

export function estimateCalories(distanceMiles: number): number {
  return distanceMiles * KCAL_PER_MILE
}

function byteSliceToInt(bytes: Uint8Array, offset: number, width = 3): number {
  let total = 0

  for (let index = 0; index < width; index += 1) {
    total += bytes[offset + index] << (8 * (width - 1 - index))
  }

  return total
}

function readUint16LE(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readInt16LE(bytes: Uint8Array, offset: number) {
  const value = readUint16LE(bytes, offset)
  return value & 0x8000 ? value - 0x10000 : value
}

function readUint24LE(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

export function fixCrc(command: number[] | Uint8Array): Uint8Array {
  const packet = Uint8Array.from(command)
  packet[packet.length - 2] = packet.slice(1, -2).reduce((sum, value) => sum + value, 0) % 256
  return packet
}

function createCommand(bytes: number[]): Uint8Array {
  return fixCrc(bytes)
}

export function createSwitchModeCommand(mode: WalkingPadMode): Uint8Array {
  return createCommand([247, 162, 2, mode, 255, 253])
}

export function createChangeSpeedCommand(speedTenthsKmh: number): Uint8Array {
  return createCommand([247, 162, 1, speedTenthsKmh, 255, 253])
}

export function createStartBeltCommand(): Uint8Array {
  return createCommand([247, 162, 4, 1, 255, 253])
}

export function createAskStatsCommand(): Uint8Array {
  return createCommand([247, 162, 0, 0, 255, 253])
}

export function createStopBeltCommand(): Uint8Array {
  return createChangeSpeedCommand(0)
}

export function parseWalkingPadMessage(value: DataView | Uint8Array): WalkingPadMessage {
  const raw =
    value instanceof Uint8Array
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))

  if (raw[0] === 248 && raw[1] === 162) {
    return {
      kind: 'current-status',
      status: {
        raw,
        beltState: raw[2],
        speed: raw[3],
        manualMode: raw[4],
        time: byteSliceToInt(raw, 5),
        dist: byteSliceToInt(raw, 8),
        steps: byteSliceToInt(raw, 11),
        appSpeed: raw[14],
        controllerButton: raw[16],
      },
    }
  }

  if (raw[0] === 248 && raw[1] === 167) {
    return {
      kind: 'last-status',
      status: {
        raw,
        time: byteSliceToInt(raw, 8),
        dist: byteSliceToInt(raw, 11),
        steps: byteSliceToInt(raw, 14),
      },
    }
  }

  return { kind: 'unknown', raw }
}

export function normalizeLegacyCurrentStatus(status: WalkingPadCurrentStatus): WalkingPadLiveStatus {
  return {
    protocol: 'legacy',
    raw: status.raw,
    speedKmh: status.speed / 10,
    distanceKm: status.dist / 100,
    steps: status.steps,
    elapsedSeconds: status.time,
  }
}

export function parseFtmsTreadmillData(value: DataView | Uint8Array): WalkingPadLiveStatus {
  const raw =
    value instanceof Uint8Array
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
  const flags = readUint16LE(raw, 0)
  let offset = 2

  const speedKmh = readUint16LE(raw, offset) / 100
  offset += 2

  if (flags & (1 << 1)) {
    offset += 2
  }

  let distanceKm = 0
  if (flags & (1 << 2)) {
    distanceKm = readUint24LE(raw, offset) / 1000
    offset += 3
  }

  if (flags & (1 << 3)) {
    offset += 4
  }

  if (flags & (1 << 4)) {
    offset += 4
  }

  if (flags & (1 << 5)) {
    offset += 1
  }

  if (flags & (1 << 6)) {
    offset += 1
  }

  if (flags & (1 << 7)) {
    offset += 5
  }

  if (flags & (1 << 8)) {
    offset += 1
  }

  if (flags & (1 << 9)) {
    offset += 1
  }

  let elapsedSeconds: number | null = null
  if (flags & (1 << 10)) {
    elapsedSeconds = readUint16LE(raw, offset)
    offset += 2
  }

  if (flags & (1 << 11)) {
    offset += 2
  }

  if (flags & (1 << 12)) {
    offset += 4
  }

  let steps = 0
  if (flags & (1 << 13)) {
    steps = readUint24LE(raw, offset)
    offset += 3
  }

  return {
    protocol: 'ftms',
    raw,
    speedKmh,
    distanceKm,
    steps,
    elapsedSeconds,
  }
}

export function parseFtmsControlResponse(value: DataView | Uint8Array): FtmsControlResponse | null {
  const raw =
    value instanceof Uint8Array
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))

  if (raw.length < 3 || raw[0] !== FtmsControlOpcode.ResponseCode) {
    return null
  }

  return {
    requestCode: raw[1],
    resultCode: raw[2],
  }
}

export function parseFtmsMachineStatus(value: DataView | Uint8Array) {
  const raw =
    value instanceof Uint8Array
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
  const code = raw[0] ?? 0

  return {
    raw,
    code,
    stopPauseCode: raw[1] ?? null,
    targetSpeedKmh: code === 0x05 && raw.length >= 3 ? readUint16LE(raw, 1) / 100 : null,
    targetInclination: code === 0x06 && raw.length >= 3 ? readInt16LE(raw, 1) / 10 : null,
  }
}

export function createFtmsRequestControlCommand() {
  return Uint8Array.of(FtmsControlOpcode.RequestControl)
}

export function createFtmsStartOrResumeCommand() {
  return Uint8Array.of(FtmsControlOpcode.StartOrResume)
}

export function createFtmsPauseCommand() {
  return Uint8Array.of(FtmsControlOpcode.StopOrPause, FtmsStopPauseCode.Pause)
}

export function createFtmsSetTargetSpeedCommand(speedTenthsKmh: number) {
  const value = speedTenthsKmh * 10
  return Uint8Array.of(FtmsControlOpcode.SetTargetSpeed, value & 0xff, (value >> 8) & 0xff)
}

export function ftmsResultCodeToMessage(resultCode: number) {
  switch (resultCode) {
    case FtmsResultCode.Success:
      return 'Success'
    case FtmsResultCode.NotSupported:
      return 'Operation not supported'
    case FtmsResultCode.InvalidParameter:
      return 'Invalid parameter'
    case FtmsResultCode.Failed:
      return 'Operation failed'
    case FtmsResultCode.NotPermitted:
      return 'Control not permitted'
    default:
      return `Unknown FTMS result (${resultCode})`
  }
}
