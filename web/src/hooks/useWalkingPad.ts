import { useCallback, useEffect, useRef, useState } from 'react'
import { WalkingPadController } from '../lib/walkingPadController'
import type { WalkingPadProtocolType } from '../lib/walkingPadProtocol'
import {
  KM_TO_MI,
  KMH_TO_MPH,
  MAX_SPEED_KMH,
  MIN_SPEED_KMH,
  SLOW_WALK_SPEED_KMH,
  SPEED_STEP_KMH,
  estimateCalories,
} from '../lib/walkingPadProtocol'
import { normalizeErrorPayload, reportClientError } from '../lib/errorReporter'
import type { WalkingPadStateSnapshot } from '../lib/walkingPadState'

type ConnectionState = 'disconnected' | 'connecting' | 'connected'
type SessionState = 'idle' | 'active' | 'paused'
type BusyAction =
  | 'connect'
  | 'disconnect'
  | 'start'
  | 'pause'
  | 'resume'
  | 'speed'
  | null

interface MetricsState {
  speedKmh: number
  distanceKm: number
  steps: number
  calories: number
  activeSeconds: number
}

interface RuntimeState {
  sessionActive: boolean
  beltRunning: boolean
  currentSpeedKmh: number
  resumeSpeedKmh: number
  autoPauseGraceUntil: number
  lastDeviceDistanceKm: number
  lastDeviceSteps: number
  speedHistory: number[]
}

const HISTORY_LIMIT = 15
const AUTO_PAUSE_GRACE_MS = 7000

function initialMetrics(): MetricsState {
  return {
    speedKmh: 0,
    distanceKm: 0,
    steps: 0,
    calories: 0,
    activeSeconds: 0,
  }
}

function initialRuntime(): RuntimeState {
  return {
    sessionActive: false,
    beltRunning: false,
    currentSpeedKmh: 0,
    resumeSpeedKmh: 2,
    autoPauseGraceUntil: 0,
    lastDeviceDistanceKm: 0,
    lastDeviceSteps: 0,
    speedHistory: [],
  }
}

export function useWalkingPad() {
  const controllerRef = useRef(new WalkingPadController())
  const runtimeRef = useRef<RuntimeState>(initialRuntime())

  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting')
  const [sessionState, setSessionState] = useState<SessionState>('idle')
  const [protocol, setProtocol] = useState<WalkingPadProtocolType | null>(null)
  const [serviceAvailable, setServiceAvailable] = useState(true)
  const [deviceName, setDeviceName] = useState('WalkingPad')
  const [busyAction, setBusyAction] = useState<BusyAction>(null)
  const [error, setError] = useState<string | null>(null)
  const [metrics, setMetrics] = useState<MetricsState>(initialMetrics)
  const [logs, setLogs] = useState<string[]>([
    'Node-side BLE transport initialized from shared WalkingPad packet definitions.',
  ])

  const appendLog = useCallback((message: string) => {
    const timestamp = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date())

    setLogs((previous) => [`${timestamp}  ${message}`, ...previous].slice(0, 8))
  }, [])

  const handleError = useCallback((errorValue: unknown) => {
    const nextMessage =
      errorValue instanceof Error ? errorValue.message : 'Unexpected WalkingPad error.'

    setError(nextMessage)
    appendLog(nextMessage)
    reportClientError(
      normalizeErrorPayload(errorValue, 'useWalkingPad.handleError', {
        connectionState,
        sessionState,
        deviceName,
      }),
    )
  }, [appendLog, connectionState, deviceName, sessionState])

  const handlePacket = useCallback(
    (status: {
      steps: number
      speedKmh: number
      distanceKm: number
      elapsedSeconds: number | null
    }) => {
      const runtime = runtimeRef.current
      const nextSpeedKmh = status.speedKmh

      if (runtime.beltRunning && nextSpeedKmh > MIN_SPEED_KMH) {
        runtime.speedHistory = [...runtime.speedHistory, nextSpeedKmh].slice(-HISTORY_LIMIT)
      }

      if (runtime.sessionActive && !runtime.beltRunning && nextSpeedKmh > MIN_SPEED_KMH) {
        runtime.beltRunning = true
        setSessionState('active')
        appendLog('Belt resumed outside the app. Session switched back to active.')
      }

      if (
        Date.now() > runtime.autoPauseGraceUntil &&
        runtime.beltRunning &&
        nextSpeedKmh === 0 &&
        runtime.currentSpeedKmh > 0
      ) {
        runtime.resumeSpeedKmh = runtime.speedHistory[0] ?? MIN_SPEED_KMH
        runtime.beltRunning = false
        setSessionState('paused')
        appendLog('Belt stopped unexpectedly. Session auto-paused.')
      }

      runtime.currentSpeedKmh = nextSpeedKmh

      setMetrics((previous) => {
        let distanceKm = previous.distanceKm
        let steps = previous.steps

        if (runtime.sessionActive) {
          let lastDeviceDistanceKm = runtime.lastDeviceDistanceKm
          if (status.distanceKm < lastDeviceDistanceKm) {
            lastDeviceDistanceKm = 0
          }

          distanceKm += Math.max(0, status.distanceKm - lastDeviceDistanceKm)
          runtime.lastDeviceDistanceKm = status.distanceKm

          let lastDeviceSteps = runtime.lastDeviceSteps
          if (status.steps < lastDeviceSteps) {
            lastDeviceSteps = 0
          }

          steps += Math.max(0, status.steps - lastDeviceSteps)
          runtime.lastDeviceSteps = status.steps
        }

        const calories = estimateCalories(distanceKm * KM_TO_MI)

        return {
          ...previous,
          speedKmh: nextSpeedKmh,
          distanceKm,
          steps,
          calories,
          activeSeconds:
            status.elapsedSeconds !== null && status.elapsedSeconds > previous.activeSeconds
              ? status.elapsedSeconds
              : previous.activeSeconds,
        }
      })
    },
    [appendLog],
  )

  useEffect(() => {
    const controller = controllerRef.current

    const unsubscribe = controller.subscribe((event) => {
      if (event.type === 'connected') {
        setConnectionState('connected')
        setDeviceName(event.deviceName)
        setProtocol(event.protocol)
        setError(null)
        appendLog(`Connected to ${event.deviceName} using ${event.protocol.toUpperCase()}.`)
        return
      }

      if (event.type === 'disconnected') {
        const runtime = runtimeRef.current
        runtime.beltRunning = false
        runtime.autoPauseGraceUntil = 0
        setConnectionState('disconnected')
        setProtocol(null)
        setSessionState(runtime.sessionActive ? 'paused' : 'idle')
        appendLog('WalkingPad BLE server closed the device connection.')
        return
      }

      if (event.type === 'current-status') {
        handlePacket(event.status)
        return
      }

      if (event.type === 'last-status') {
        appendLog(
          `Pad record received: ${(event.status.dist / 100).toFixed(2)} km, ${event.status.steps} steps.`,
        )
        return
      }

      if (event.type === 'error') {
        handleError(event.error)
        return
      }

      if (event.type === 'machine-status') {
        appendLog(event.message)
      }
    })

    return () => {
      unsubscribe()
    }
  }, [appendLog, handleError, handlePacket])

  useEffect(() => {
    let cancelled = false

    appendLog('Checking the local WalkingPad BLE service…')

    void controllerRef.current
      .initialize()
      .then((state) => {
        if (cancelled) {
          return
        }

        setServiceAvailable(true)
        setConnectionState(state.connectionState)
        setDeviceName(state.deviceName)
        setProtocol(state.protocol)

        if (state.connectionState === 'connected' && state.protocol) {
          appendLog(`BLE service already connected to ${state.deviceName} via ${state.protocol.toUpperCase()}.`)
          return
        }

        appendLog('BLE service is reachable. Connect when the pad is powered on.')
      })
      .catch((errorValue) => {
        if (cancelled) {
          return
        }

        setServiceAvailable(false)
        setConnectionState('disconnected')
        appendLog(`BLE service unavailable: ${errorValue instanceof Error ? errorValue.message : 'Unknown error.'}`)
      })

    return () => {
      cancelled = true
    }
  }, [appendLog])

  useEffect(() => {
    if (sessionState !== 'active') {
      return
    }

    const timerId = window.setInterval(() => {
      setMetrics((previous) => ({ ...previous, activeSeconds: previous.activeSeconds + 1 }))
    }, 1000)

    return () => window.clearInterval(timerId)
  }, [sessionState])

  useEffect(() => {
    if (connectionState !== 'connected' || sessionState !== 'active') {
      return
    }

    const controller = controllerRef.current
    const timerId = window.setInterval(() => {
      void controller.askStats().catch(handleError)
    }, 1000)

    return () => window.clearInterval(timerId)
  }, [connectionState, sessionState, handleError])

  const connect = async () => {
    setBusyAction('connect')
    setConnectionState('connecting')
    setError(null)

    try {
      await controllerRef.current.connect()
    } catch (errorValue) {
      setConnectionState('disconnected')
      handleError(errorValue)
    } finally {
      setBusyAction(null)
    }
  }

  const disconnect = async () => {
    setBusyAction('disconnect')

    try {
      await controllerRef.current.disconnect()
    } catch (errorValue) {
      handleError(errorValue)
    } finally {
      setBusyAction(null)
    }
  }

  const startSession = async () => {
    const runtime = runtimeRef.current

    setBusyAction('start')
    setError(null)
    runtimeRef.current = {
      ...initialRuntime(),
      sessionActive: true,
      beltRunning: true,
    }
    setMetrics(initialMetrics())
    setSessionState('active')
    appendLog('Starting a new session.')

    try {
      await controllerRef.current.startBelt()
      await controllerRef.current.askStats()
    } catch (errorValue) {
      runtime.sessionActive = false
      runtime.beltRunning = false
      setSessionState('idle')
      handleError(errorValue)
    } finally {
      setBusyAction(null)
    }
  }

  const pauseSession = async () => {
    const runtime = runtimeRef.current

    setBusyAction('pause')
    setError(null)

    if (runtime.speedHistory.length > 0) {
      runtime.resumeSpeedKmh = runtime.speedHistory[runtime.speedHistory.length - 1]
    }

    runtime.beltRunning = false
    runtime.autoPauseGraceUntil = 0
    setSessionState('paused')
    appendLog(`Pause requested. Resume speed saved at ${runtime.resumeSpeedKmh.toFixed(1)} km/h.`)

    try {
      await controllerRef.current.stopBelt()
      await controllerRef.current.askStats()
    } catch (errorValue) {
      handleError(errorValue)
    } finally {
      setBusyAction(null)
    }
  }

  const resumeSession = async () => {
    const runtime = runtimeRef.current
    const speedTenths = Math.round(runtime.resumeSpeedKmh * 10)

    setBusyAction('resume')
    setError(null)
    runtime.beltRunning = true
    runtime.autoPauseGraceUntil = Date.now() + AUTO_PAUSE_GRACE_MS
    setSessionState('active')
    appendLog(`Resume requested at ${runtime.resumeSpeedKmh.toFixed(1)} km/h.`)

    try {
      await controllerRef.current.resumeAt(speedTenths)
      await controllerRef.current.askStats()
    } catch (errorValue) {
      runtime.beltRunning = false
      setSessionState('paused')
      handleError(errorValue)
    } finally {
      setBusyAction(null)
    }
  }

  const setSpeed = async (nextSpeedKmh: number, description: string) => {
    setBusyAction('speed')
    setError(null)

    try {
      await controllerRef.current.changeSpeed(Math.round(nextSpeedKmh * 10))
      appendLog(description)
    } catch (errorValue) {
      handleError(errorValue)
    } finally {
      setBusyAction(null)
    }
  }

  const increaseSpeed = async () => {
    const nextSpeed = Math.min(MAX_SPEED_KMH, metrics.speedKmh + SPEED_STEP_KMH)
    await setSpeed(nextSpeed, `Speed up requested to ${nextSpeed.toFixed(1)} km/h.`)
  }

  const decreaseSpeed = async () => {
    const nextSpeed = Math.max(MIN_SPEED_KMH, metrics.speedKmh - SPEED_STEP_KMH)
    await setSpeed(nextSpeed, `Slow down requested to ${nextSpeed.toFixed(1)} km/h.`)
  }

  const setSlowWalk = async () => {
    await setSpeed(SLOW_WALK_SPEED_KMH, `Slow walk preset set to ${SLOW_WALK_SPEED_KMH.toFixed(1)} km/h.`)
  }

  const setMaxSpeed = async () => {
    await setSpeed(MAX_SPEED_KMH, `Max pace preset set to ${MAX_SPEED_KMH.toFixed(1)} km/h.`)
  }

  const restoreSnapshot = useCallback(
    (snapshot: WalkingPadStateSnapshot) => {
      runtimeRef.current = {
        ...initialRuntime(),
        sessionActive: snapshot.sessionState !== 'idle',
        beltRunning: false,
        currentSpeedKmh: snapshot.metrics.speedKmh,
        resumeSpeedKmh: snapshot.resumeSpeedKmh,
        speedHistory:
          snapshot.metrics.speedKmh > MIN_SPEED_KMH ? [snapshot.metrics.speedKmh] : [],
      }

      setDeviceName(snapshot.deviceName || 'WalkingPad')
      setMetrics(snapshot.metrics)
      setSessionState(snapshot.sessionState === 'idle' ? 'idle' : 'paused')
      setError(null)
      appendLog(`Restored snapshot from ${new Date(snapshot.updatedAt).toLocaleString()}.`)
    },
    [appendLog],
  )

  return {
    connectionState,
    sessionState,
    protocol,
    serviceAvailable,
    busyAction,
    deviceName,
    error,
    logs,
    metrics: {
      ...metrics,
      speedMph: metrics.speedKmh * KMH_TO_MPH,
      distanceMiles: metrics.distanceKm * KM_TO_MI,
    },
    snapshot: {
      version: 1 as const,
      updatedAt: new Date().toISOString(),
      deviceName,
      sessionState,
      resumeSpeedKmh: runtimeRef.current.resumeSpeedKmh,
      metrics,
    },
    canConnect: serviceAvailable && connectionState === 'disconnected' && busyAction === null,
    canStart: connectionState === 'connected' && sessionState === 'idle' && busyAction === null,
    canPause: sessionState === 'active' && busyAction === null,
    canResume: sessionState === 'paused' && connectionState === 'connected' && busyAction === null,
    canChangeSpeed: sessionState === 'active' && connectionState === 'connected' && busyAction === null,
    connect,
    disconnect,
    startSession,
    pauseSession,
    resumeSession,
    increaseSpeed,
    decreaseSpeed,
    setSlowWalk,
    setMaxSpeed,
    restoreSnapshot,
  }
}
