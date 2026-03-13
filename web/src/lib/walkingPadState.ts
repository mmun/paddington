export type PersistedSessionState = 'idle' | 'active' | 'paused'

export interface WalkingPadStateSnapshot {
  version: 1
  updatedAt: string
  deviceName: string
  sessionState: PersistedSessionState
  resumeSpeedKmh: number
  metrics: {
    speedKmh: number
    distanceKm: number
    steps: number
    calories: number
    activeSeconds: number
  }
}

function isMetrics(value: unknown): value is WalkingPadStateSnapshot['metrics'] {
  if (!value || typeof value !== 'object') {
    return false
  }

  const metrics = value as Record<string, unknown>

  return (
    typeof metrics.speedKmh === 'number' &&
    typeof metrics.distanceKm === 'number' &&
    typeof metrics.steps === 'number' &&
    typeof metrics.calories === 'number' &&
    typeof metrics.activeSeconds === 'number'
  )
}

export function isWalkingPadStateSnapshot(value: unknown): value is WalkingPadStateSnapshot {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Record<string, unknown>

  return (
    candidate.version === 1 &&
    typeof candidate.updatedAt === 'string' &&
    typeof candidate.deviceName === 'string' &&
    (candidate.sessionState === 'idle' ||
      candidate.sessionState === 'active' ||
      candidate.sessionState === 'paused') &&
    typeof candidate.resumeSpeedKmh === 'number' &&
    isMetrics(candidate.metrics)
  )
}
