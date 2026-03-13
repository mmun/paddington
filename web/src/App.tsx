import './App.css'
import {
  MAX_SPEED_KMH,
  MIN_SPEED_KMH,
  SLOW_WALK_SPEED_KMH,
  SPEED_STEP_KMH,
} from './lib/walkingPadProtocol'
import { useWalkingPad } from './hooks/useWalkingPad'
import { useGoogleDriveAppData } from './hooks/useGoogleDriveAppData'

interface StatCardProps {
  label: string
  value: string
  accent?: boolean
}

function StatCard({ label, value, accent = false }: StatCardProps) {
  return (
    <article className={`stat-card${accent ? ' stat-card-accent' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}

function formatDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

function App() {
  const {
    busyAction,
    canChangeSpeed,
    canConnect,
    canPause,
    canResume,
    canStart,
    connect,
    connectionState,
    deviceName,
    disconnect,
    error,
    increaseSpeed,
    logs,
    metrics,
    pauseSession,
    protocol,
    resumeSession,
    restoreSnapshot,
    serviceAvailable,
    sessionState,
    setMaxSpeed,
    setSlowWalk,
    snapshot,
    startSession,
    decreaseSpeed,
  } = useWalkingPad()
  const {
    configured: googleConfigured,
    lastSyncedAt,
    loadRemoteState,
    saveRemoteState,
    signIn,
    signOut,
    signedIn,
    syncMessage,
    syncState,
  } = useGoogleDriveAppData(snapshot, restoreSnapshot)

  const connectionLabel = (() => {
    if (connectionState === 'connecting') {
      return 'Connecting'
    }

    if (connectionState === 'connected') {
      return 'Connected'
    }

    return 'Disconnected'
  })()

  const sessionLabel = (() => {
    if (sessionState === 'active') {
      return 'Active session'
    }

    if (sessionState === 'paused') {
      return 'Paused session'
    }

    return 'Ready to start'
  })()

  const protocolLabel = (() => {
    if (protocol === 'legacy') {
      return 'FE00 service / FE01 notify / FE02 write'
    }

    if (protocol === 'ftms') {
      return 'FTMS 1826 / 2ACD treadmill data / 2AD9 control point'
    }

    return 'Waiting for connection'
  })()

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Node BLE + Vite</p>
          <h1>WalkingPad control without the phone app.</h1>
          <p className="hero-text">
            The UI now talks to a local Node Bluetooth service instead of using browser BLE
            directly. That keeps the pad connected across page refreshes while reusing the same
            TypeScript packet parsing for legacy WalkingPad and FTMS devices.
          </p>
          <div className="hero-actions">
            <button
              className="primary-button"
              disabled={!canConnect}
              onClick={() => void connect()}
            >
              {busyAction === 'connect' ? 'Connecting…' : 'Connect WalkingPad'}
            </button>
            <button
              className="ghost-button"
              disabled={connectionState !== 'connected' || busyAction !== null}
              onClick={() => void disconnect()}
            >
              {busyAction === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
        </div>

        <aside className="signal-panel">
          <div className={`status-pill status-${connectionState}`}>{connectionLabel}</div>
          <h2>{deviceName}</h2>
          <p>{sessionLabel}</p>
          <dl className="signal-meta">
            <div>
              <dt>Protocol</dt>
              <dd>{protocolLabel}</dd>
            </div>
            <div>
              <dt>Range</dt>
              <dd>
                {MIN_SPEED_KMH.toFixed(1)} to {MAX_SPEED_KMH.toFixed(1)} km/h
              </dd>
            </div>
            <div>
              <dt>Presets</dt>
              <dd>
                Slow {SLOW_WALK_SPEED_KMH.toFixed(1)} km/h, Max {MAX_SPEED_KMH.toFixed(1)} km/h
              </dd>
            </div>
          </dl>
        </aside>
      </section>

      {!serviceAvailable ? (
        <section className="notice-panel error-panel">
          <h2>Local BLE service is not reachable.</h2>
          <p>Run <code>npm run dev</code> or <code>npm run dev:server</code> to start the Node Bluetooth backend.</p>
        </section>
      ) : null}

      {error ? (
        <section className="notice-panel error-panel">
          <h2>Device error</h2>
          <p>{error}</p>
        </section>
      ) : null}

      <section className="stats-grid">
        <StatCard label="Speed" value={`${metrics.speedMph.toFixed(1)} mph`} accent />
        <StatCard label="Distance" value={`${metrics.distanceMiles.toFixed(2)} mi`} />
        <StatCard label="Steps" value={metrics.steps.toLocaleString()} />
        <StatCard label="Calories" value={Math.round(metrics.calories).toLocaleString()} />
        <StatCard label="Active Time" value={formatDuration(metrics.activeSeconds)} />
      </section>

      <section className="control-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Session</p>
            <h2>Control rail</h2>
          </div>
          <p className="panel-note">The BLE session lives in the local Node service, so refreshes no longer drop the device.</p>
        </div>

        <div className="session-actions">
          <button className="primary-button" disabled={!canStart} onClick={() => void startSession()}>
            {busyAction === 'start' ? 'Starting…' : 'Start New Session'}
          </button>
          <button className="warning-button" disabled={!canPause} onClick={() => void pauseSession()}>
            {busyAction === 'pause' ? 'Pausing…' : 'Pause'}
          </button>
          <button className="primary-button" disabled={!canResume} onClick={() => void resumeSession()}>
            {busyAction === 'resume' ? 'Resuming…' : 'Resume'}
          </button>
        </div>

        <div className="speed-grid">
          <button className="speed-button" disabled={!canChangeSpeed} onClick={() => void setSlowWalk()}>
            Slow
            <span>{SLOW_WALK_SPEED_KMH.toFixed(1)} km/h</span>
          </button>
          <button className="speed-button" disabled={!canChangeSpeed} onClick={() => void decreaseSpeed()}>
            Decrease
            <span>-{SPEED_STEP_KMH.toFixed(1)} km/h</span>
          </button>
          <button className="speed-button" disabled={!canChangeSpeed} onClick={() => void increaseSpeed()}>
            Increase
            <span>+{SPEED_STEP_KMH.toFixed(1)} km/h</span>
          </button>
          <button className="speed-button" disabled={!canChangeSpeed} onClick={() => void setMaxSpeed()}>
            Max
            <span>{MAX_SPEED_KMH.toFixed(1)} km/h</span>
          </button>
        </div>
      </section>

      <section className="control-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Cloud Sync</p>
            <h2>Google Drive appDataFolder</h2>
          </div>
          <p className="panel-note">
            Hidden app storage for WalkingPad state snapshots, not visible in normal Drive folders.
          </p>
        </div>

        <div className="session-actions">
          <button
            className="primary-button"
            disabled={!googleConfigured || syncState === 'authorizing' || syncState === 'syncing'}
            onClick={() => void signIn()}
          >
            {syncState === 'authorizing' ? 'Authorizing…' : 'Connect Google'}
          </button>
          <button
            className="ghost-button"
            disabled={!signedIn || syncState === 'syncing'}
            onClick={() => void loadRemoteState()}
          >
            {syncState === 'syncing' ? 'Syncing…' : 'Load Drive State'}
          </button>
          <button
            className="ghost-button"
            disabled={!signedIn || syncState === 'syncing'}
            onClick={() => void saveRemoteState()}
          >
            {syncState === 'syncing' ? 'Syncing…' : 'Save Drive State'}
          </button>
          <button
            className="warning-button"
            disabled={!signedIn || syncState === 'syncing'}
            onClick={() => void signOut()}
          >
            Disconnect Google
          </button>
        </div>

        <div className="sync-summary">
          <p>{syncMessage}</p>
          <p>{lastSyncedAt ? `Last synced: ${new Date(lastSyncedAt).toLocaleString()}` : 'No cloud sync yet.'}</p>
          {!googleConfigured ? <p>Add <code>VITE_GOOGLE_CLIENT_ID</code> to enable OAuth.</p> : null}
        </div>
      </section>

      <section className="log-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Telemetry</p>
            <h2>Recent events</h2>
          </div>
          <p className="panel-note">Useful for connection issues, auto-pause, and command timing.</p>
        </div>

        <ol className="log-list">
          {logs.map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
        </ol>
      </section>
    </main>
  )
}

export default App
