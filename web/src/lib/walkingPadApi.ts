import type {
  WalkingPadLastStatus,
  WalkingPadLiveStatus,
  WalkingPadProtocolType,
  WalkingPadVendorSessionStatus,
} from './walkingPadProtocol'

export type WalkingPadConnectionState = 'disconnected' | 'connecting' | 'connected'
export type WalkingPadSessionSource = 'vendor_73' | 'inferred'

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
  targetAddress: string
  targetName: string
  wakeAddress: string
  live: WalkingPadLiveSnapshot | null
}

export type WalkingPadServerEvent =
  | { type: 'connected'; deviceName: string; protocol: WalkingPadProtocolType }
  | { type: 'disconnected' }
  | { type: 'current-status'; status: WalkingPadLiveStatus }
  | { type: 'last-status'; status: WalkingPadLastStatus }
  | { type: 'session-status'; session: WalkingPadVendorSessionStatus }
  | { type: 'machine-status'; code: number; message: string }
  | { type: 'devices'; devices: WalkingPadDeviceSummary[] }
  | { type: 'scanning'; active: boolean }
  | { type: 'error'; message: string }

export type WalkingPadVendorSettingCommand =
  | { setting: 'units'; value: 'metric' | 'imperial' }
  | { setting: 'no-load-stop'; seconds: 0 | 5 | 15 | 30 | 45 | 60 }
  | { setting: 'buzzer'; enabled: boolean }
  | { setting: 'marquee'; enabled: boolean }
  | { setting: 'child-lock'; enabled: boolean }
  | { setting: 'mode'; mode: 'manual' | 'automatic' | 'sleep' }

export type WalkingPadCommandRequest =
  | { type: 'start' }
  | { type: 'request-control' }
  | { type: 'pause' }
  | { type: 'stop' }
  | { type: 'wake' }
  | { type: 'ask-stats' }
  | { type: 'resume'; speedTenthsKmh: number }
  | { type: 'switch-mode'; mode: number }
  | { type: 'set-speed'; speedTenthsKmh: number }
  | { type: 'query-settings' }
  | { type: 'query-session' }
  | { type: 'vendor-setting'; command: WalkingPadVendorSettingCommand }

export type WalkingPadAnalyticsRange = 'today' | '7d' | '30d' | '90d' | 'year' | 'all'

export interface WalkingPadCurrentSessionSnapshot {
  id: number
  startedAt: string
  source: WalkingPadSessionSource
  steps: number
  distanceKm: number
  activeSeconds: number
}

export interface WalkingPadLiveSeriesPoint {
  observedAt: string
  observedAtMs: number
  speedKmh: number
  stepsPerMinute: number
  deltaSteps: number
}

export interface WalkingPadLiveSnapshot {
  type: 'live_status'
  connectionState: WalkingPadConnectionState
  deviceName: string
  dailySteps: number
  sessionSteps: number
  currentSession: WalkingPadCurrentSessionSnapshot | null
  speedKmh: number
  speedMph: number
  averageSpeedKmh: number
  stepsPerMinute: number
  distanceKmToday: number
  activeSecondsToday: number
  isWalking: boolean
  updatedAt: string | null
  liveSeries: WalkingPadLiveSeriesPoint[]
}

export interface WalkingPadAnalyticsBucket {
  label: string
  start: string
  steps: number
  distanceKm: number
  activeSeconds: number
  averageSpeedKmh: number
}

export interface WalkingPadBreakSummary {
  count: number
  totalSeconds: number
  averageSeconds: number
  longestSeconds: number
}

export interface WalkingPadAnalyticsSummary {
  range: WalkingPadAnalyticsRange
  generatedAt: string
  totals: {
    steps: number
    distanceKm: number
    activeSeconds: number
    walkingEvents: number
    calories: number
  }
  averages: {
    stepsPerActiveMinute: number
    speedKmh: number
    stepsPerDay: number
    activeMinutesPerDay: number
  }
  breaks: WalkingPadBreakSummary
  buckets: WalkingPadAnalyticsBucket[]
  live: WalkingPadLiveSnapshot
}
