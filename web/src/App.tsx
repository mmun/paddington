import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import './App.css'
import {
  MAX_SPEED_KMH,
  MIN_SPEED_KMH,
  SLOW_WALK_SPEED_KMH,
  SPEED_STEP_KMH,
} from './lib/walkingPadProtocol'
import { WalkingPadController } from './lib/walkingPadController'
import type {
  WalkingPadAnalyticsBucket,
  WalkingPadAnalyticsRange,
  WalkingPadAnalyticsSummary,
  WalkingPadLiveSeriesPoint,
  WalkingPadLiveSnapshot,
  WalkingPadServerState,
  WalkingPadVendorSettingCommand,
} from './lib/walkingPadApi'

const analyticsRanges: { value: WalkingPadAnalyticsRange; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'year', label: 'Year' },
  { value: 'all', label: 'All' },
]

type BusyAction =
  | 'wake'
  | 'connect'
  | 'disconnect'
  | 'start'
  | 'pause'
  | 'end'
  | 'speed'
  | 'setting'
  | 'query'
  | null

type DashboardTab = 'live' | 'analytics' | 'settings' | 'logging'

const dashboardTabs: { value: DashboardTab; label: string }[] = [
  { value: 'live', label: 'Live' },
  { value: 'analytics', label: 'Analytics' },
  { value: 'settings', label: 'Settings' },
  { value: 'logging', label: 'Logging' },
]

interface MetricTileProps {
  label: string
  value: string
  detail?: string
  tone?: 'default' | 'good' | 'warn'
}

function MetricTile({ label, value, detail, tone = 'default' }: MetricTileProps) {
  return (
    <article className={`metric-tile metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </article>
  )
}

function App() {
  const controllerRef = useRef(new WalkingPadController())
  const rangeRef = useRef<WalkingPadAnalyticsRange>('today')
  const speedDraftTouchedRef = useRef(false)
  const [serverState, setServerState] = useState<WalkingPadServerState | null>(null)
  const [live, setLive] = useState<WalkingPadLiveSnapshot | null>(null)
  const [analytics, setAnalytics] = useState<WalkingPadAnalyticsSummary | null>(null)
  const [range, setRange] = useState<WalkingPadAnalyticsRange>('today')
  const [activeTab, setActiveTab] = useState<DashboardTab>('live')
  const [busyAction, setBusyAction] = useState<BusyAction>(null)
  const [targetSpeedKmh, setTargetSpeedKmh] = useState(SLOW_WALK_SPEED_KMH)
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[]>(['Dashboard loaded. Waiting for the WalkingPad service.'])

  const appendLog = useCallback((message: string) => {
    const timestamp = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date())
    setLogs((previous) => [`${timestamp}  ${message}`, ...previous].slice(0, 40))
  }, [])

  const refreshLive = useCallback(async () => {
    const controller = controllerRef.current
    const [state, nextLive] = await Promise.all([
      controller.getState(),
      controller.getLive(),
    ])
    setServerState(state)
    setLive(nextLive)
    if (state.connectionState === 'connected' || nextLive.connectionState === 'connected') {
      setError(null)
    }
    if (!speedDraftTouchedRef.current && nextLive.speedKmh > 0) {
      setTargetSpeedKmh(clampSpeed(nextLive.speedKmh))
    }
  }, [])

  const refreshAnalytics = useCallback(async (nextRange = rangeRef.current) => {
    const nextAnalytics = await controllerRef.current.getAnalytics(nextRange)
    setAnalytics(nextAnalytics)
    setLive(nextAnalytics.live)
  }, [])

  useEffect(() => {
    rangeRef.current = range
  }, [range])

  useEffect(() => {
    let cancelled = false
    const controller = controllerRef.current

    const load = async () => {
      try {
        const [state, nextAnalytics] = await Promise.all([
          controller.getState(),
          controller.getAnalytics(rangeRef.current),
        ])
        if (cancelled) {
          return
        }
        setServerState(state)
        setAnalytics(nextAnalytics)
        setLive(nextAnalytics.live)
        setError(null)
        appendLog('Connected to the local WalkingPad service.')
      } catch (errorValue) {
        if (cancelled) {
          return
        }
        const message = errorMessage(errorValue)
        setError(message)
        appendLog(message)
      }
    }

    void load()

    const unsubscribe = controller.subscribe((event) => {
      if (event.type === 'connected') {
        setError(null)
        appendLog(`Connected to ${event.deviceName} using ${event.protocol.toUpperCase()}.`)
        void refreshLive()
        void refreshAnalytics()
        return
      }

      if (event.type === 'disconnected') {
        setError(null)
        appendLog('WalkingPad disconnected.')
        void refreshLive()
        return
      }

      if (event.type === 'current-status') {
        setError(null)
        void refreshLive()
        return
      }

      if (event.type === 'machine-status') {
        appendLog(event.message)
        return
      }

      if (event.type === 'scanning') {
        setServerState((previous) => previous ? { ...previous, scanning: event.active } : previous)
        appendLog(event.active ? 'BLE scanner started.' : 'BLE scanner stopped.')
        return
      }

      if (event.type === 'devices') {
        setServerState((previous) => previous ? { ...previous, devices: event.devices } : previous)
        if (event.devices.length > 0) {
          appendLog(`Scan update: ${event.devices.length} candidate device${event.devices.length === 1 ? '' : 's'}.`)
        }
        return
      }

      if (event.type === 'last-status') {
        appendLog(`Last pad stats: ${event.status.steps.toLocaleString()} steps.`)
        return
      }

      if (event.type === 'session-status') {
        const sessionTime = formatTime(event.session.startedAt)
        appendLog(event.session.endedAt ? `Session ended at ${formatTime(event.session.endedAt)}.` : `Session started at ${sessionTime}.`)
        void refreshLive()
        void refreshAnalytics()
        return
      }

      if (event.type === 'error') {
        const message = event.error.message
        setError(message)
        appendLog(message)
      }
    })

    const liveTimer = window.setInterval(() => {
      void refreshLive().catch((errorValue) => setError(errorMessage(errorValue)))
    }, 5000)
    const analyticsTimer = window.setInterval(() => {
      void refreshAnalytics().catch((errorValue) => setError(errorMessage(errorValue)))
    }, 15000)

    return () => {
      cancelled = true
      unsubscribe()
      window.clearInterval(liveTimer)
      window.clearInterval(analyticsTimer)
    }
  }, [appendLog, refreshAnalytics, refreshLive])

  useEffect(() => {
    void refreshAnalytics(range).catch((errorValue) => {
      const message = errorMessage(errorValue)
      setError(message)
      appendLog(message)
    })
  }, [appendLog, range, refreshAnalytics])

  const run = useCallback(async (action: BusyAction, label: string, command: () => Promise<void>) => {
    setBusyAction(action)
    setError(null)
    appendLog(label)

    try {
      await command()
      await refreshLive()
      await refreshAnalytics()
    } catch (errorValue) {
      const message = errorMessage(errorValue)
      setError(message)
      appendLog(message)
    } finally {
      setBusyAction(null)
    }
  }, [appendLog, refreshAnalytics, refreshLive])

  const sendSetting = (command: WalkingPadVendorSettingCommand, label: string) => {
    void run('setting', label, () => controllerRef.current.setVendorSetting(command))
  }

  const updateTargetSpeed = (speedKmh: number) => {
    speedDraftTouchedRef.current = true
    setTargetSpeedKmh(clampSpeed(speedKmh))
  }

  const connectionState = serverState?.connectionState ?? 'disconnected'
  const canControl = connectionState === 'connected' && busyAction === null
  const liveStatus = live ?? emptyLive()
  const currentSession = liveStatus.currentSession
  const distanceMiles = liveStatus.distanceKmToday * 0.621371
  const activeMinutes = liveStatus.activeSecondsToday / 60
  const analyticsTotals = analytics?.totals
  const analyticsAverages = analytics?.averages
  const visibleLogs = activeTab === 'logging' ? logs : logs.slice(0, 8)

  const chartDomain = useMemo(() => {
    const buckets = analytics?.buckets ?? []
    return {
      maxSteps: Math.max(1, ...buckets.map((bucket) => bucket.steps)),
      maxActive: Math.max(1, ...buckets.map((bucket) => bucket.activeSeconds / 60)),
    }
  }, [analytics?.buckets])

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <h1>WalkingPad</h1>
        <div className="topbar-status">
          <span className={`status-dot status-${connectionState}`} />
          <strong>{connectionLabel(connectionState)}</strong>
          <span>{serverState?.targetName ?? 'KS-AP-RF3'}</span>
          <span>{serverState?.targetAddress ?? '54:50:A0:10:4E:84'}</span>
        </div>
      </header>

      {error ? (
        <section className="notice-panel">
          <strong>Needs attention</strong>
          <p>{error}</p>
        </section>
      ) : null}

      <section className="workspace">
        <aside className="panel command-panel" aria-label="WalkingPad controls">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Controls</p>
              <h2>Main controls</h2>
            </div>
            <span className="last-updated">{liveStatus.updatedAt ? formatTime(liveStatus.updatedAt) : 'No telemetry'}</span>
          </div>

          <section className="state-summary" aria-label="Current state">
            <MetricTile
              label="Daily steps"
              value={liveStatus.dailySteps.toLocaleString()}
              detail={liveStatus.isWalking ? 'walking now' : 'stored today'}
              tone="good"
            />
            <MetricTile
              label="Session"
              value={(currentSession?.steps ?? liveStatus.sessionSteps).toLocaleString()}
              detail={currentSession ? `${formatDuration(currentSession.activeSeconds)} active` : 'no open session'}
              tone={currentSession ? 'good' : 'default'}
            />
            <MetricTile label="Speed" value={`${liveStatus.speedMph.toFixed(1)} mph`} detail={`${liveStatus.speedKmh.toFixed(1)} km/h`} />
            <MetricTile label="Step rate" value={`${liveStatus.stepsPerMinute.toFixed(0)}/min`} detail={`${liveStatus.averageSpeedKmh.toFixed(1)} km/h avg`} />
            <MetricTile label="Distance" value={`${distanceMiles.toFixed(2)} mi`} detail={`${liveStatus.distanceKmToday.toFixed(2)} km`} />
            <MetricTile label="Active" value={formatDuration(liveStatus.activeSecondsToday)} detail={`${activeMinutes.toFixed(0)} min today`} />
          </section>

          <div className="control-stack">
            <div className="button-grid three">
              <button disabled={busyAction !== null} onClick={() => void run('wake', 'Sending wake advertisement.', () => controllerRef.current.wake())}>
                Wake
              </button>
              <button disabled={connectionState !== 'disconnected' || busyAction !== null} onClick={() => void run('connect', 'Connecting to WalkingPad.', () => controllerRef.current.connect())}>
                Connect
              </button>
              <button disabled={connectionState !== 'connected' || busyAction !== null} onClick={() => void run('disconnect', 'Disconnecting BLE.', () => controllerRef.current.disconnect())}>
                Disconnect
              </button>
            </div>

            <div className="button-grid three">
              <button className="primary-action" disabled={!canControl} onClick={() => void run('start', `Starting belt at ${targetSpeedKmh.toFixed(1)} km/h.`, () => controllerRef.current.resumeAt(Math.round(targetSpeedKmh * 10)))}>
                Start
              </button>
              <button disabled={!canControl} onClick={() => void run('pause', 'Pausing belt.', () => controllerRef.current.stopBelt())}>
                Pause
              </button>
              <button className="danger-action" disabled={!canControl} onClick={() => void run('end', 'Ending treadmill session.', () => controllerRef.current.endSession())}>
                Stop
              </button>
            </div>

            <div className="speed-control">
              <label htmlFor="speedTarget">Target speed</label>
              <div className="speed-readout">
                <strong>{targetSpeedKmh.toFixed(1)} km/h</strong>
                <span>{(targetSpeedKmh * 0.621371).toFixed(1)} mph</span>
              </div>
              <input
                id="speedTarget"
                min={MIN_SPEED_KMH}
                max={MAX_SPEED_KMH}
                step={0.1}
                type="range"
                value={targetSpeedKmh}
                onChange={(event) => updateTargetSpeed(Number(event.currentTarget.value))}
              />
            </div>

            <div className="button-grid four">
              <button disabled={!canControl} onClick={() => updateTargetSpeed(targetSpeedKmh - SPEED_STEP_KMH)}>
                Slower
              </button>
              <button disabled={!canControl} onClick={() => updateTargetSpeed(SLOW_WALK_SPEED_KMH)}>
                Walk
              </button>
              <button disabled={!canControl} onClick={() => updateTargetSpeed(MAX_SPEED_KMH)}>
                Max
              </button>
              <button className="primary-action" disabled={!canControl} onClick={() => void run('speed', `Setting speed to ${targetSpeedKmh.toFixed(1)} km/h.`, () => controllerRef.current.changeSpeed(Math.round(targetSpeedKmh * 10)))}>
                Set
              </button>
            </div>
          </div>
        </aside>

        <section className="tab-shell" aria-label="WalkingPad detail views">
          <nav className="primary-tabs" role="tablist" aria-label="Dashboard sections">
            {dashboardTabs.map((tab) => (
              <button
                aria-controls={`${tab.value}-panel`}
                aria-selected={activeTab === tab.value}
                className={activeTab === tab.value ? 'active' : ''}
                key={tab.value}
                onClick={() => setActiveTab(tab.value)}
                role="tab"
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <div className="tab-body">
            {activeTab === 'live' ? (
              <section className="tab-panel live-tab" id="live-panel" role="tabpanel">
                <section className="panel live-panel">
                  <div className="panel-header">
                    <div>
                      <p className="eyebrow">Live effort</p>
                      <h2>Step rate and speed</h2>
                    </div>
                    <span className="last-updated">{liveStatus.updatedAt ? `Updated ${formatTime(liveStatus.updatedAt)}` : 'No telemetry yet'}</span>
                  </div>
                  <LiveGraphPanel points={liveStatus.liveSeries} />
                </section>

                <section className="panel detail-panel">
                  <div className="panel-header">
                    <div>
                      <p className="eyebrow">State</p>
                      <h2>Current snapshot</h2>
                    </div>
                    {busyAction ? <span className="busy-pill">Running {busyAction}</span> : null}
                  </div>
                  <div className="summary-list">
                    <SummaryRow label="Connection" value={connectionLabel(connectionState)} />
                    <SummaryRow label="Protocol" value={serverState?.protocol?.toUpperCase() ?? 'None'} />
                    <SummaryRow label="Scanner" value={serverState?.scanning ? 'Active' : 'Idle'} />
                    <SummaryRow label="Target" value={serverState?.targetName ?? 'KS-AP-RF3'} />
                    <SummaryRow label="Session start" value={currentSession ? formatTime(currentSession.startedAt) : 'None'} />
                    <SummaryRow label="Session source" value={currentSession ? sessionSourceLabel(currentSession.source) : 'None'} />
                  </div>
                </section>
              </section>
            ) : null}

            {activeTab === 'analytics' ? (
              <section className="tab-panel analytics-tab" id="analytics-panel" role="tabpanel">
                <section className="panel analytics-panel">
                  <div className="panel-header">
                    <div>
                      <p className="eyebrow">Analytics</p>
                      <h2>Training history</h2>
                    </div>
                    <div className="range-tabs" role="tablist" aria-label="Analytics range">
                      {analyticsRanges.map((item) => (
                        <button
                          aria-selected={item.value === range}
                          className={item.value === range ? 'active' : ''}
                          key={item.value}
                          onClick={() => setRange(item.value)}
                          role="tab"
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="analytics-layout">
                    <div className="summary-list compact">
                      <SummaryRow label={rangeLabel(range)} value={(analyticsTotals?.steps ?? 0).toLocaleString()} />
                      <SummaryRow label="Distance" value={`${((analyticsTotals?.distanceKm ?? 0) * 0.621371).toFixed(2)} mi`} />
                      <SummaryRow label="Active" value={formatDuration(analyticsTotals?.activeSeconds ?? 0)} />
                      <SummaryRow label="Avg speed" value={`${(analyticsAverages?.speedKmh ?? 0).toFixed(1)} km/h`} />
                      <SummaryRow label="Steps/min" value={(analyticsAverages?.stepsPerActiveMinute ?? 0).toFixed(0)} />
                      <SummaryRow label="Breaks" value={`${analytics?.breaks.count ?? 0}`} />
                    </div>
                    <div className="chart-grid">
                      <ChartPanel title="Steps" buckets={analytics?.buckets ?? []} maxValue={chartDomain.maxSteps} value={(bucket) => bucket.steps} suffix="steps" />
                      <ChartPanel title="Active minutes" buckets={analytics?.buckets ?? []} maxValue={chartDomain.maxActive} value={(bucket) => bucket.activeSeconds / 60} suffix="min" />
                    </div>
                  </div>
                </section>
              </section>
            ) : null}

            {activeTab === 'settings' ? (
              <section className="tab-panel settings-tab" id="settings-panel" role="tabpanel">
                <section className="panel settings-panel">
                  <div className="panel-header">
                    <div>
                      <p className="eyebrow">Settings</p>
                      <h2>WalkingPad options</h2>
                    </div>
                  </div>

                  <div className="settings-grid">
                    <SettingGroup title="Units">
                      <button disabled={!canControl} onClick={() => sendSetting({ setting: 'units', value: 'metric' }, 'Setting units to metric.')}>Metric</button>
                      <button disabled={!canControl} onClick={() => sendSetting({ setting: 'units', value: 'imperial' }, 'Setting units to imperial.')}>Imperial</button>
                    </SettingGroup>

                    <SettingGroup title="No-load stop">
                      {[0, 5, 15, 30, 45, 60].map((seconds) => (
                        <button
                          disabled={!canControl}
                          key={seconds}
                          onClick={() => sendSetting({ setting: 'no-load-stop', seconds: seconds as 0 | 5 | 15 | 30 | 45 | 60 }, `Setting no-load stop to ${seconds}s.`)}
                        >
                          {seconds === 0 ? 'Off' : `${seconds}s`}
                        </button>
                      ))}
                    </SettingGroup>

                    <SettingGroup title="Device behavior">
                      <button disabled={!canControl} onClick={() => sendSetting({ setting: 'buzzer', enabled: true }, 'Turning buzzer on.')}>Buzzer on</button>
                      <button disabled={!canControl} onClick={() => sendSetting({ setting: 'buzzer', enabled: false }, 'Turning buzzer off.')}>Buzzer off</button>
                      <button disabled={!canControl} onClick={() => sendSetting({ setting: 'marquee', enabled: true }, 'Turning marquee on.')}>Marquee on</button>
                      <button disabled={!canControl} onClick={() => sendSetting({ setting: 'marquee', enabled: false }, 'Turning marquee off.')}>Marquee off</button>
                      <button disabled={!canControl} onClick={() => sendSetting({ setting: 'child-lock', enabled: true }, 'Turning child lock on.')}>Lock on</button>
                      <button disabled={!canControl} onClick={() => sendSetting({ setting: 'child-lock', enabled: false }, 'Turning child lock off.')}>Lock off</button>
                    </SettingGroup>

                    <SettingGroup title="Mode">
                      <button disabled={!canControl} onClick={() => sendSetting({ setting: 'mode', mode: 'manual' }, 'Switching to manual mode.')}>Manual</button>
                      <button disabled={!canControl} onClick={() => sendSetting({ setting: 'mode', mode: 'automatic' }, 'Switching to automatic mode.')}>Auto</button>
                      <button disabled={!canControl} onClick={() => sendSetting({ setting: 'mode', mode: 'sleep' }, 'Sending sleep mode.')}>Sleep</button>
                    </SettingGroup>
                  </div>

                  <div className="button-grid two settings-actions">
                    <button disabled={!canControl} onClick={() => void run('query', 'Querying settings snapshot.', () => controllerRef.current.querySettings())}>Query settings</button>
                    <button disabled={!canControl} onClick={() => void run('query', 'Querying session block.', () => controllerRef.current.querySession())}>Query session</button>
                  </div>
                </section>
              </section>
            ) : null}

            {activeTab === 'logging' ? (
              <section className="tab-panel logging-tab" id="logging-panel" role="tabpanel">
                <section className="panel log-panel">
                  <div className="panel-header">
                    <div>
                      <p className="eyebrow">Low level</p>
                      <h2>Event stream</h2>
                    </div>
                    {busyAction ? <span className="busy-pill">Running {busyAction}</span> : null}
                  </div>

                  <div className="logging-layout">
                    <ol className="log-list full">
                      {visibleLogs.map((entry) => (
                        <li key={entry}>{entry}</li>
                      ))}
                    </ol>
                    <div className="debug-panel">
                      <SummaryRow label="HTTP target" value={window.location.host} />
                      <SummaryRow label="BLE target" value={serverState?.targetAddress ?? '54:50:A0:10:4E:84'} />
                      <SummaryRow label="Wake address" value={serverState?.wakeAddress ?? 'C1:00:00:00:30:3F'} />
                      <SummaryRow label="Scanned devices" value={`${serverState?.devices.length ?? 0}`} />
                      <div className="device-list">
                        {(serverState?.devices ?? []).map((device) => (
                          <div className="device-row" key={device.id}>
                            <strong>{device.name || 'Unnamed'}</strong>
                            <span>{device.address ?? device.id}</span>
                            <small>{device.rssi === null ? 'RSSI unknown' : `${device.rssi} dBm`}</small>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </section>
              </section>
            ) : null}
          </div>
        </section>
      </section>
    </main>
  )
}

interface SummaryRowProps {
  label: string
  value: string
}

function SummaryRow({ label, value }: SummaryRowProps) {
  return (
    <div className="summary-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

interface SettingGroupProps {
  children: ReactNode
  title: string
}

function SettingGroup({ children, title }: SettingGroupProps) {
  return (
    <div className="setting-group">
      <h3>{title}</h3>
      <div className="setting-buttons">{children}</div>
    </div>
  )
}

interface LiveGraphPanelProps {
  points: WalkingPadLiveSeriesPoint[]
}

function LiveGraphPanel({ points }: LiveGraphPanelProps) {
  const width = 760
  const height = 240
  const padding = 28
  const usableWidth = width - padding * 2
  const usableHeight = height - padding * 2
  const maxStepRate = Math.max(20, ...points.map((point) => point.stepsPerMinute))
  const maxSpeed = Math.max(MAX_SPEED_KMH, ...points.map((point) => point.speedKmh))
  const latest = points[points.length - 1]
  const stepPoints = points.map((point, index) => ({
    x: points.length <= 1 ? padding : padding + (index / (points.length - 1)) * usableWidth,
    y: padding + usableHeight - (point.stepsPerMinute / maxStepRate) * usableHeight,
  }))
  const speedPoints = points.map((point, index) => ({
    x: points.length <= 1 ? padding : padding + (index / (points.length - 1)) * usableWidth,
    y: padding + usableHeight - (point.speedKmh / maxSpeed) * usableHeight,
  }))

  return (
    <div className="live-graph-wrap">
      <div className="live-graph-stats">
        <strong>{latest ? latest.stepsPerMinute.toFixed(0) : '0'} steps/min</strong>
        <span>{latest ? `${latest.speedKmh.toFixed(1)} km/h` : '0.0 km/h'}</span>
      </div>
      <svg className="live-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Live step rate and speed chart">
        <line x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} />
        <line x1={padding} x2={padding} y1={padding} y2={height - padding} />
        <path className="step-rate-line" d={linePath(stepPoints)} />
        <path className="speed-line" d={linePath(speedPoints)} />
        {latest ? (
          <>
            <circle className="step-rate-dot" cx={stepPoints[stepPoints.length - 1]?.x ?? padding} cy={stepPoints[stepPoints.length - 1]?.y ?? height - padding} r="5" />
            <circle className="speed-dot" cx={speedPoints[speedPoints.length - 1]?.x ?? padding} cy={speedPoints[speedPoints.length - 1]?.y ?? height - padding} r="5" />
          </>
        ) : null}
      </svg>
      <div className="chart-legend">
        <span className="legend-step">Step derivative</span>
        <span className="legend-speed">Speed</span>
      </div>
    </div>
  )
}

interface ChartPanelProps {
  buckets: WalkingPadAnalyticsBucket[]
  maxValue: number
  suffix: string
  title: string
  value: (bucket: WalkingPadAnalyticsBucket) => number
}

function ChartPanel({ buckets, maxValue, suffix, title, value }: ChartPanelProps) {
  const width = 720
  const height = 220
  const padding = 28
  const usableWidth = width - padding * 2
  const usableHeight = height - padding * 2
  const points = buckets.map((bucket, index) => {
    const x = buckets.length <= 1 ? padding : padding + (index / (buckets.length - 1)) * usableWidth
    const y = padding + usableHeight - (value(bucket) / maxValue) * usableHeight
    return { bucket, x, y }
  })
  const pathData = linePath(points)
  const latest = buckets[buckets.length - 1]

  return (
    <article className="chart-panel">
      <div className="chart-title">
        <h3>{title}</h3>
        <span>{latest ? `${formatCompact(value(latest))} ${suffix} latest` : 'No data yet'}</span>
      </div>
      <svg className="line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} chart`}>
        <line x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} />
        <line x1={padding} x2={padding} y1={padding} y2={height - padding} />
        {pathData ? <path d={pathData} /> : null}
        {points.map((point) => (
          <circle key={`${point.bucket.start}-${point.x}`} cx={point.x} cy={point.y} r="4">
            <title>{`${point.bucket.label}: ${formatCompact(value(point.bucket))} ${suffix}`}</title>
          </circle>
        ))}
      </svg>
    </article>
  )
}

function linePath(points: { x: number; y: number }[]) {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ')
}

function emptyLive(): WalkingPadLiveSnapshot {
  return {
    type: 'live_status',
    connectionState: 'disconnected',
    deviceName: 'WalkingPad',
    dailySteps: 0,
    sessionSteps: 0,
    currentSession: null,
    speedKmh: 0,
    speedMph: 0,
    averageSpeedKmh: 0,
    stepsPerMinute: 0,
    distanceKmToday: 0,
    activeSecondsToday: 0,
    isWalking: false,
    updatedAt: null,
    liveSeries: [],
  }
}

function clampSpeed(value: number) {
  return Math.max(MIN_SPEED_KMH, Math.min(MAX_SPEED_KMH, Number(value.toFixed(1))))
}

function errorMessage(errorValue: unknown) {
  return errorValue instanceof Error ? errorValue.message : String(errorValue)
}

function connectionLabel(state: string) {
  if (state === 'connected') {
    return 'Connected'
  }
  if (state === 'connecting') {
    return 'Connecting'
  }
  return 'Disconnected'
}

function rangeLabel(range: WalkingPadAnalyticsRange) {
  return analyticsRanges.find((item) => item.value === range)?.label ?? 'Today'
}

function sessionSourceLabel(source: string) {
  return source === 'vendor_73' ? 'vendor' : 'inferred'
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.round(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, '0')}m`
  }

  return `${minutes}m`
}

function formatCompact(value: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value >= 100 ? 0 : 1,
    notation: value >= 10000 ? 'compact' : 'standard',
  }).format(value)
}

export default App
