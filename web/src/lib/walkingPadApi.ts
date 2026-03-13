import type {
  WalkingPadLastStatus,
  WalkingPadLiveStatus,
  WalkingPadProtocolType,
} from './walkingPadProtocol'

export type WalkingPadConnectionState = 'disconnected' | 'connecting' | 'connected'

export interface WalkingPadDeviceSummary {
  id: string
  name: string
  address: string | null
  rssi: number | null
  advertisedServices: string[]
}

export interface WalkingPadServerState {
  connectionState: WalkingPadConnectionState
  deviceName: string
  protocol: WalkingPadProtocolType | null
  scanning: boolean
  devices: WalkingPadDeviceSummary[]
}

export type WalkingPadServerEvent =
  | { type: 'connected'; deviceName: string; protocol: WalkingPadProtocolType }
  | { type: 'disconnected' }
  | { type: 'current-status'; status: WalkingPadLiveStatus }
  | { type: 'last-status'; status: WalkingPadLastStatus }
  | { type: 'machine-status'; code: number; message: string }
  | { type: 'devices'; devices: WalkingPadDeviceSummary[] }
  | { type: 'scanning'; active: boolean }
  | { type: 'error'; message: string }

export type WalkingPadCommandRequest =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'ask-stats' }
  | { type: 'resume'; speedTenthsKmh: number }
  | { type: 'switch-mode'; mode: number }
  | { type: 'set-speed'; speedTenthsKmh: number }
