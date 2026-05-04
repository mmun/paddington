import Database from 'better-sqlite3'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  KM_TO_MI,
  KCAL_PER_MILE,
  KMH_TO_MPH,
  type WalkingPadLiveStatus,
  type WalkingPadVendorSessionStatus,
} from '../src/lib/walkingPadProtocol'
import type {
  WalkingPadAnalyticsBucket,
  WalkingPadAnalyticsRange,
  WalkingPadAnalyticsSummary,
  WalkingPadConnectionState,
  WalkingPadCurrentSessionSnapshot,
  WalkingPadLiveSeriesPoint,
  WalkingPadLiveSnapshot,
  WalkingPadSessionSource,
} from '../src/lib/walkingPadApi'

interface StatusContext {
  connectionState: WalkingPadConnectionState
  deviceName: string
}

interface TelemetryRow {
  id: number
  session_id: number | null
  observed_at: string
  observed_at_ms: number
  local_day: string
  device_name: string
  protocol: string
  speed_kmh: number
  distance_km: number
  device_steps: number
  elapsed_seconds: number | null
  delta_steps: number
  delta_distance_km: number
  delta_active_seconds: number
  walking: number
}

interface SessionRow {
  id: number
  started_at: string
  started_at_ms: number
  ended_at: string | null
  ended_at_ms: number | null
  source: WalkingPadSessionSource
  device_name: string
  start_device_steps: number | null
  start_distance_km: number | null
  end_device_steps: number | null
  end_distance_km: number | null
  end_reason: string | null
}

interface PreviousStatus {
  observedAtMs: number
  localDay: string
  distanceKm: number
  deviceSteps: number
  elapsedSeconds: number | null
  speedKmh: number
}

const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'data', 'walkingpad.sqlite')
const ACTIVE_GAP_LIMIT_SECONDS = 10
const INSTANT_WINDOW_MS = 30_000
const LIVE_GRAPH_WINDOW_MS = 5 * 60_000
const STEP_DERIVATIVE_WINDOW_MS = 15_000
const SESSION_IDLE_LIMIT_MS = 15 * 60_000
const WALKING_SPEED_KMH = 0.1
const MIN_VENDOR_SESSION_MS = Date.UTC(2020, 0, 1)
const MAX_VENDOR_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000
const SCHEMA_VERSION = 1
const BACKUP_DIR_NAME = 'backups'

export class TelemetryStore {
  private readonly db: Database.Database
  private previousStatus: PreviousStatus | null
  private currentSession: SessionRow | null
  private currentSessionLastWalkingAtMs: number | null

  private readonly insertEvent: Database.Statement
  private readonly latestEvent: Database.Statement<[], TelemetryRow>
  private readonly latestEventForSession: Database.Statement<[number], TelemetryRow>
  private readonly rangeEvents: Database.Statement<[number], TelemetryRow>
  private readonly allEvents: Database.Statement<[], TelemetryRow>
  private readonly todayTotals: Database.Statement<[string], { steps: number | null; distanceKm: number | null; activeSeconds: number | null }>
  private readonly recentEvents: Database.Statement<[number], TelemetryRow>
  private readonly openSession: Database.Statement<[], SessionRow>
  private readonly sessionById: Database.Statement<[number], SessionRow>
  private readonly sessionByStartMs: Database.Statement<[number], SessionRow>
  private readonly sessionTotals: Database.Statement<[number], { steps: number | null; distanceKm: number | null; activeSeconds: number | null }>
  private readonly lastWalkingEventForSession: Database.Statement<[number], { observed_at_ms: number } | undefined>
  private readonly insertInferredSession: Database.Statement
  private readonly upsertVendorSession: Database.Statement
  private readonly closeSessionStatement: Database.Statement
  private readonly reassignSessionEvents: Database.Statement
  private readonly attachUnassignedEvents: Database.Statement

  constructor(dbPath = process.env.WALKINGPAD_DB_PATH || DEFAULT_DB_PATH) {
    const hadExistingDatabase = databaseFileHasContent(dbPath)
    mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.configureStorage()
    this.migrate(dbPath, hadExistingDatabase)
    this.assertIntegrity()

    this.insertEvent = this.db.prepare(`
      INSERT INTO treadmill_status_events (
        session_id,
        observed_at,
        observed_at_ms,
        local_day,
        device_name,
        protocol,
        speed_kmh,
        distance_km,
        device_steps,
        elapsed_seconds,
        delta_steps,
        delta_distance_km,
        delta_active_seconds,
        walking,
        raw_json
      )
      VALUES (
        @sessionId,
        @observedAt,
        @observedAtMs,
        @localDay,
        @deviceName,
        @protocol,
        @speedKmh,
        @distanceKm,
        @deviceSteps,
        @elapsedSeconds,
        @deltaSteps,
        @deltaDistanceKm,
        @deltaActiveSeconds,
        @walking,
        @rawJson
      )
    `)
    this.latestEvent = this.db.prepare(`
      SELECT *
      FROM treadmill_status_events
      ORDER BY observed_at_ms DESC, id DESC
      LIMIT 1
    `) as Database.Statement<[], TelemetryRow>
    this.latestEventForSession = this.db.prepare(`
      SELECT *
      FROM treadmill_status_events
      WHERE session_id = ?
      ORDER BY observed_at_ms DESC, id DESC
      LIMIT 1
    `) as Database.Statement<[number], TelemetryRow>
    this.rangeEvents = this.db.prepare(`
      SELECT *
      FROM treadmill_status_events
      WHERE observed_at_ms >= ?
      ORDER BY observed_at_ms ASC, id ASC
    `) as Database.Statement<[number], TelemetryRow>
    this.allEvents = this.db.prepare(`
      SELECT *
      FROM treadmill_status_events
      ORDER BY observed_at_ms ASC, id ASC
    `) as Database.Statement<[], TelemetryRow>
    this.todayTotals = this.db.prepare(`
      SELECT
        SUM(delta_steps) AS steps,
        SUM(delta_distance_km) AS distanceKm,
        SUM(delta_active_seconds) AS activeSeconds
      FROM treadmill_status_events
      WHERE local_day = ?
    `) as Database.Statement<[string], { steps: number | null; distanceKm: number | null; activeSeconds: number | null }>
    this.recentEvents = this.db.prepare(`
      SELECT *
      FROM treadmill_status_events
      WHERE observed_at_ms >= ?
      ORDER BY observed_at_ms ASC, id ASC
    `) as Database.Statement<[number], TelemetryRow>
    this.openSession = this.db.prepare(`
      SELECT *
      FROM walking_sessions
      WHERE ended_at_ms IS NULL
      ORDER BY started_at_ms DESC, id DESC
      LIMIT 1
    `) as Database.Statement<[], SessionRow>
    this.sessionById = this.db.prepare(`
      SELECT *
      FROM walking_sessions
      WHERE id = ?
    `) as Database.Statement<[number], SessionRow>
    this.sessionByStartMs = this.db.prepare(`
      SELECT *
      FROM walking_sessions
      WHERE started_at_ms = ?
    `) as Database.Statement<[number], SessionRow>
    this.sessionTotals = this.db.prepare(`
      SELECT
        SUM(delta_steps) AS steps,
        SUM(delta_distance_km) AS distanceKm,
        SUM(delta_active_seconds) AS activeSeconds
      FROM treadmill_status_events
      WHERE session_id = ?
    `) as Database.Statement<[number], { steps: number | null; distanceKm: number | null; activeSeconds: number | null }>
    this.lastWalkingEventForSession = this.db.prepare(`
      SELECT observed_at_ms
      FROM treadmill_status_events
      WHERE session_id = ? AND walking = 1
      ORDER BY observed_at_ms DESC, id DESC
      LIMIT 1
    `) as Database.Statement<[number], { observed_at_ms: number } | undefined>
    this.insertInferredSession = this.db.prepare(`
      INSERT OR IGNORE INTO walking_sessions (
        started_at,
        started_at_ms,
        source,
        device_name,
        start_device_steps,
        start_distance_km,
        created_at,
        updated_at
      )
      VALUES (
        @startedAt,
        @startedAtMs,
        'inferred',
        @deviceName,
        0,
        0,
        @now,
        @now
      )
    `)
    this.upsertVendorSession = this.db.prepare(`
      INSERT INTO walking_sessions (
        started_at,
        started_at_ms,
        ended_at,
        ended_at_ms,
        source,
        device_name,
        start_device_steps,
        start_distance_km,
        vendor_stable_value,
        created_at,
        updated_at
      )
      VALUES (
        @startedAt,
        @startedAtMs,
        @endedAt,
        @endedAtMs,
        'vendor_73',
        @deviceName,
        0,
        0,
        @stableValue,
        @now,
        @now
      )
      ON CONFLICT(started_at_ms) DO UPDATE SET
        ended_at = COALESCE(excluded.ended_at, walking_sessions.ended_at),
        ended_at_ms = COALESCE(excluded.ended_at_ms, walking_sessions.ended_at_ms),
        source = 'vendor_73',
        device_name = excluded.device_name,
        vendor_stable_value = excluded.vendor_stable_value,
        updated_at = excluded.updated_at
    `)
    this.closeSessionStatement = this.db.prepare(`
      UPDATE walking_sessions
      SET
        ended_at = COALESCE(ended_at, @endedAt),
        ended_at_ms = COALESCE(ended_at_ms, @endedAtMs),
        end_device_steps = COALESCE(@endDeviceSteps, end_device_steps),
        end_distance_km = COALESCE(@endDistanceKm, end_distance_km),
        end_reason = COALESCE(end_reason, @endReason),
        updated_at = @updatedAt
      WHERE id = @id
    `)
    this.reassignSessionEvents = this.db.prepare(`
      UPDATE treadmill_status_events
      SET session_id = @nextSessionId
      WHERE session_id = @previousSessionId
    `)
    this.attachUnassignedEvents = this.db.prepare(`
      UPDATE treadmill_status_events
      SET session_id = @sessionId
      WHERE session_id IS NULL
        AND observed_at_ms >= @startedAtMs
        AND observed_at_ms <= @endedAtMs
    `)
    this.previousStatus = this.loadPreviousStatus()
    this.currentSession = this.openSession.get() ?? null
    this.currentSessionLastWalkingAtMs = this.currentSession
      ? this.lastWalkingEventForSession.get(this.currentSession.id)?.observed_at_ms ?? null
      : null
    this.closeStaleOpenSession(Date.now(), false)
  }

  recordStatus(status: WalkingPadLiveStatus, context: StatusContext) {
    const now = new Date()
    const observedAtMs = now.getTime()
    const observedAt = now.toISOString()
    const localDay = formatLocalDay(now)
    const previous = this.previousStatus
    const counterReset = previous
      ? status.steps < previous.deviceSteps || status.distanceKm + 0.001 < previous.distanceKm
      : false
    const deltaSteps = counterReset ? 0 : positiveDelta(status.steps, previous?.deviceSteps)
    const deltaDistanceKm = counterReset ? 0 : positiveDelta(status.distanceKm, previous?.distanceKm)
    const gapSeconds = previous && !counterReset ? Math.max(0, (observedAtMs - previous.observedAtMs) / 1000) : 0
    const walking = status.speedKmh > WALKING_SPEED_KMH || deltaSteps > 0
    const previousWalking = previous && !counterReset ? previous.speedKmh > WALKING_SPEED_KMH : false
    const deltaActiveSeconds =
      gapSeconds > 0 && gapSeconds <= ACTIVE_GAP_LIMIT_SECONDS && (walking || previousWalking)
        ? gapSeconds
        : 0

    if (counterReset && this.currentSession && previous) {
      this.closeSession(this.currentSession, previous.observedAtMs, 'counter_reset')
    }

    this.closeStaleOpenSession(observedAtMs, walking)

    let session = this.currentSession
    if (!session && walking) {
      session = this.startInferredSession(status, observedAtMs, context)
    }

    if (session && walking) {
      this.currentSessionLastWalkingAtMs = observedAtMs
    }

    this.insertEvent.run({
      sessionId: session?.id ?? null,
      observedAt,
      observedAtMs,
      localDay,
      deviceName: context.deviceName,
      protocol: status.protocol,
      speedKmh: status.speedKmh,
      distanceKm: status.distanceKm,
      deviceSteps: status.steps,
      elapsedSeconds: status.elapsedSeconds,
      deltaSteps,
      deltaDistanceKm,
      deltaActiveSeconds,
      walking: walking ? 1 : 0,
      rawJson: JSON.stringify({
        ...status,
        rawHex: Array.from(status.raw).map((byte) => byte.toString(16).padStart(2, '0')).join(''),
        raw: undefined,
      }),
    })

    this.previousStatus = {
      observedAtMs,
      localDay,
      distanceKm: status.distanceKm,
      deviceSteps: status.steps,
      elapsedSeconds: status.elapsedSeconds,
      speedKmh: status.speedKmh,
    }
  }

  recordVendorSession(session: WalkingPadVendorSessionStatus, context: StatusContext) {
    if (!isPlausibleVendorSession(session.startedAtMs)) {
      return
    }

    const now = new Date().toISOString()
    const previousCurrent = this.currentSession
    this.upsertVendorSession.run({
      startedAt: session.startedAt,
      startedAtMs: session.startedAtMs,
      endedAt: session.endedAt,
      endedAtMs: session.endedAtMs,
      stableValue: session.stableValue,
      deviceName: context.deviceName,
      now,
    })

    const vendorSession = this.sessionByStartMs.get(session.startedAtMs)
    if (!vendorSession) {
      return
    }

    this.attachUnassignedEvents.run({
      sessionId: vendorSession.id,
      startedAtMs: session.startedAtMs,
      endedAtMs: session.endedAtMs ?? Number.MAX_SAFE_INTEGER,
    })

    if (previousCurrent && previousCurrent.id !== vendorSession.id) {
      if (previousCurrent.source === 'inferred') {
        this.reassignSessionEvents.run({
          nextSessionId: vendorSession.id,
          previousSessionId: previousCurrent.id,
        })
        this.closeSession(previousCurrent, session.startedAtMs, 'vendor_superseded')
      } else if (previousCurrent.ended_at_ms === null) {
        this.closeSession(previousCurrent, session.startedAtMs, 'vendor_new_session')
      }
    }

    const refreshed = this.sessionById.get(vendorSession.id)
    if (!refreshed) {
      return
    }

    if (session.endedAtMs !== null) {
      this.closeSession(refreshed, session.endedAtMs, 'vendor_73')
      if (this.currentSession?.id === refreshed.id) {
        this.currentSession = null
        this.currentSessionLastWalkingAtMs = null
      }
      return
    }

    this.currentSession = refreshed
    this.currentSessionLastWalkingAtMs = this.lastWalkingEventForSession.get(refreshed.id)?.observed_at_ms ?? null
  }

  getLiveSnapshot(context: StatusContext): WalkingPadLiveSnapshot {
    this.closeStaleOpenSession(Date.now(), false)

    const latest = this.latestEvent.get()
    const today = this.todayTotals.get(formatLocalDay(new Date()))
    const recent = this.recentEvents.all(Date.now() - INSTANT_WINDOW_MS)
    const liveRows = this.recentEvents.all(Date.now() - LIVE_GRAPH_WINDOW_MS)
    const recentFirst = recent[0]
    const recentLast = recent[recent.length - 1]
    const recentSpanMinutes =
      recentFirst && recentLast
        ? Math.max((recentLast.observed_at_ms - recentFirst.observed_at_ms) / 60_000, INSTANT_WINDOW_MS / 60_000)
        : INSTANT_WINDOW_MS / 60_000
    const recentSteps = sum(recent, (row) => row.delta_steps)
    const walkingRows = recent.filter((row) => row.walking === 1)
    const latestIsFresh = latest ? Date.now() - latest.observed_at_ms < 120_000 : false
    const speedKmh = latest && latestIsFresh ? latest.speed_kmh : 0
    const currentSession = this.currentSessionSnapshot()

    return {
      type: 'live_status',
      connectionState: context.connectionState,
      deviceName: context.deviceName,
      dailySteps: today?.steps ?? 0,
      sessionSteps: currentSession?.steps ?? 0,
      currentSession,
      speedKmh,
      speedMph: speedKmh * KMH_TO_MPH,
      averageSpeedKmh: walkingRows.length ? sum(walkingRows, (row) => row.speed_kmh) / walkingRows.length : 0,
      stepsPerMinute: recentSteps / recentSpanMinutes,
      distanceKmToday: today?.distanceKm ?? 0,
      activeSecondsToday: today?.activeSeconds ?? 0,
      isWalking: speedKmh > WALKING_SPEED_KMH,
      updatedAt: latest?.observed_at ?? null,
      liveSeries: buildLiveSeries(liveRows),
    }
  }

  getAnalytics(range: WalkingPadAnalyticsRange, context: StatusContext): WalkingPadAnalyticsSummary {
    this.closeStaleOpenSession(Date.now(), false)

    const startMs = rangeStartMs(range)
    const rows = startMs === null ? this.allEvents.all() : this.rangeEvents.all(startMs)
    const generatedAt = new Date().toISOString()
    const activeSeconds = sum(rows, (row) => row.delta_active_seconds)
    const distanceKm = sum(rows, (row) => row.delta_distance_km)
    const steps = sum(rows, (row) => row.delta_steps)
    const walkingEvents = rows.filter((row) => row.walking === 1).length
    const weightedSpeed = sum(rows, (row) => row.speed_kmh * row.delta_active_seconds)
    const dayCount = Math.max(1, distinctDays(rows).size || fallbackDayCount(range, rows))

    return {
      range,
      generatedAt,
      totals: {
        steps,
        distanceKm,
        activeSeconds,
        walkingEvents,
        calories: distanceKm * KM_TO_MI * KCAL_PER_MILE,
      },
      averages: {
        stepsPerActiveMinute: activeSeconds > 0 ? steps / (activeSeconds / 60) : 0,
        speedKmh: activeSeconds > 0 ? weightedSpeed / activeSeconds : 0,
        stepsPerDay: steps / dayCount,
        activeMinutesPerDay: activeSeconds / 60 / dayCount,
      },
      breaks: summarizeBreaks(rows),
      buckets: bucketRows(rows, range),
      live: this.getLiveSnapshot(context),
    }
  }

  close() {
    this.db.close()
  }

  private configureStorage() {
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('wal_autocheckpoint = 1000')
  }

  private migrate(dbPath: string, hadExistingDatabase: boolean) {
    const currentVersion = this.getUserVersion()

    if (currentVersion > SCHEMA_VERSION) {
      throw new Error(
        `SQLite schema version ${currentVersion} is newer than this server supports (${SCHEMA_VERSION}). Refusing to start to avoid damaging telemetry data.`,
      )
    }

    if (hadExistingDatabase && currentVersion < SCHEMA_VERSION) {
      this.backupBeforeMigration(dbPath, currentVersion, SCHEMA_VERSION)
    }

    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS walking_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at TEXT NOT NULL,
          started_at_ms INTEGER NOT NULL UNIQUE,
          ended_at TEXT,
          ended_at_ms INTEGER,
          source TEXT NOT NULL CHECK (source IN ('vendor_73', 'inferred')),
          device_name TEXT NOT NULL,
          start_device_steps INTEGER DEFAULT 0,
          start_distance_km REAL DEFAULT 0,
          end_device_steps INTEGER,
          end_distance_km REAL,
          end_reason TEXT,
          vendor_stable_value INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS treadmill_status_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER REFERENCES walking_sessions(id),
          observed_at TEXT NOT NULL,
          observed_at_ms INTEGER NOT NULL,
          local_day TEXT NOT NULL,
          device_name TEXT NOT NULL,
          protocol TEXT NOT NULL,
          speed_kmh REAL NOT NULL,
          distance_km REAL NOT NULL,
          device_steps INTEGER NOT NULL,
          elapsed_seconds INTEGER,
          delta_steps INTEGER NOT NULL,
          delta_distance_km REAL NOT NULL,
          delta_active_seconds REAL NOT NULL,
          walking INTEGER NOT NULL,
          raw_json TEXT NOT NULL
        );
      `)

      if (!this.columnExists('treadmill_status_events', 'session_id')) {
        this.db.exec('ALTER TABLE treadmill_status_events ADD COLUMN session_id INTEGER REFERENCES walking_sessions(id)')
      }

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_walking_sessions_started_at_ms
          ON walking_sessions(started_at_ms);

        CREATE INDEX IF NOT EXISTS idx_walking_sessions_open
          ON walking_sessions(ended_at_ms);

        CREATE INDEX IF NOT EXISTS idx_treadmill_events_session_id
          ON treadmill_status_events(session_id);

        CREATE INDEX IF NOT EXISTS idx_treadmill_events_observed_at_ms
          ON treadmill_status_events(observed_at_ms);

        CREATE INDEX IF NOT EXISTS idx_treadmill_events_local_day
          ON treadmill_status_events(local_day);
      `)

      this.db.pragma(`user_version = ${SCHEMA_VERSION}`)
    })()
  }

  private getUserVersion() {
    return Number(this.db.pragma('user_version', { simple: true }))
  }

  private backupBeforeMigration(dbPath: string, fromVersion: number, toVersion: number) {
    const backupDir = path.join(path.dirname(dbPath), BACKUP_DIR_NAME)
    const timestamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', '')
    const backupPath = path.join(
      backupDir,
      `${path.basename(dbPath)}.v${fromVersion}-to-v${toVersion}.${timestamp}.${process.pid}.bak`,
    )

    mkdirSync(backupDir, { recursive: true })
    this.db.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`)
    console.log(`Backed up WalkingPad SQLite DB before migration: ${backupPath}`)
  }

  private assertIntegrity() {
    const result = this.db.pragma('quick_check', { simple: true })

    if (result !== 'ok') {
      throw new Error(`SQLite quick_check failed: ${String(result)}`)
    }
  }

  private columnExists(tableName: string, columnName: string) {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[]
    return rows.some((row) => row.name === columnName)
  }

  private loadPreviousStatus(): PreviousStatus | null {
    const latest = this.latestEvent.get()

    if (!latest) {
      return null
    }

    return {
      observedAtMs: latest.observed_at_ms,
      localDay: latest.local_day,
      distanceKm: latest.distance_km,
      deviceSteps: latest.device_steps,
      elapsedSeconds: latest.elapsed_seconds,
      speedKmh: latest.speed_kmh,
    }
  }

  private startInferredSession(status: WalkingPadLiveStatus, observedAtMs: number, context: StatusContext) {
    const elapsedMs = status.elapsedSeconds && status.elapsedSeconds > 0 ? status.elapsedSeconds * 1000 : 0
    const startedAtMs = Math.max(0, observedAtMs - elapsedMs)
    const startedAt = new Date(startedAtMs).toISOString()
    const now = new Date().toISOString()

    this.insertInferredSession.run({
      startedAt,
      startedAtMs,
      deviceName: context.deviceName,
      now,
    })

    const session = this.sessionByStartMs.get(startedAtMs)
    this.currentSession = session ?? null
    this.currentSessionLastWalkingAtMs = observedAtMs
    return this.currentSession
  }

  private closeStaleOpenSession(nowMs: number, nextEventIsWalking: boolean) {
    if (!this.currentSession) {
      return
    }

    const lastEvent = this.latestEventForSession.get(this.currentSession.id)
    const lastWalkingAtMs =
      this.currentSessionLastWalkingAtMs ??
      this.lastWalkingEventForSession.get(this.currentSession.id)?.observed_at_ms ??
      null

    if (!lastWalkingAtMs && !lastEvent) {
      return
    }

    const lastActiveAtMs = lastWalkingAtMs ?? lastEvent?.observed_at_ms ?? this.currentSession.started_at_ms

    if (nowMs - lastActiveAtMs <= SESSION_IDLE_LIMIT_MS) {
      return
    }

    this.closeSession(this.currentSession, lastActiveAtMs, 'idle_timeout')

    if (nextEventIsWalking) {
      this.currentSession = null
      this.currentSessionLastWalkingAtMs = null
    }
  }

  private closeSession(session: SessionRow, endedAtMs: number, reason: string) {
    const boundedEndedAtMs = Math.max(session.started_at_ms, endedAtMs)
    const latest = this.latestEventForSession.get(session.id)

    this.closeSessionStatement.run({
      id: session.id,
      endedAt: new Date(boundedEndedAtMs).toISOString(),
      endedAtMs: boundedEndedAtMs,
      endDeviceSteps: latest?.device_steps ?? null,
      endDistanceKm: latest?.distance_km ?? null,
      endReason: reason,
      updatedAt: new Date().toISOString(),
    })

    if (this.currentSession?.id === session.id) {
      this.currentSession = null
      this.currentSessionLastWalkingAtMs = null
    }
  }

  private currentSessionSnapshot(): WalkingPadCurrentSessionSnapshot | null {
    if (!this.currentSession) {
      return null
    }

    const session = this.sessionById.get(this.currentSession.id)
    if (!session || session.ended_at_ms !== null) {
      this.currentSession = null
      this.currentSessionLastWalkingAtMs = null
      return null
    }

    const totals = this.sessionTotals.get(session.id)
    const latest = this.latestEventForSession.get(session.id)
    const startSteps = session.start_device_steps ?? 0
    const startDistanceKm = session.start_distance_km ?? 0
    const counterSteps = latest ? positiveDelta(latest.device_steps, startSteps) : 0
    const counterDistanceKm = latest ? positiveDelta(latest.distance_km, startDistanceKm) : 0

    this.currentSession = session

    return {
      id: session.id,
      startedAt: session.started_at,
      source: session.source,
      steps: Math.max(totals?.steps ?? 0, counterSteps),
      distanceKm: Math.max(totals?.distanceKm ?? 0, counterDistanceKm),
      activeSeconds: totals?.activeSeconds ?? 0,
    }
  }
}

function positiveDelta(current: number, previous: number | undefined | null) {
  if (previous === undefined || previous === null || current < previous) {
    return 0
  }

  return current - previous
}

function sum<T>(items: T[], value: (item: T) => number) {
  return items.reduce((total, item) => total + value(item), 0)
}

function formatLocalDay(date: Date) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function rangeStartMs(range: WalkingPadAnalyticsRange) {
  const now = new Date()

  if (range === 'today') {
    return startOfLocalDay(now)
  }

  if (range === '7d') {
    return startOfLocalDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6))
  }

  if (range === '30d') {
    return startOfLocalDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29))
  }

  if (range === '90d') {
    return startOfLocalDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 89))
  }

  if (range === 'year') {
    return new Date(now.getFullYear(), 0, 1).getTime()
  }

  return null
}

function distinctDays(rows: TelemetryRow[]) {
  return new Set(rows.map((row) => row.local_day))
}

function fallbackDayCount(range: WalkingPadAnalyticsRange, rows: TelemetryRow[]) {
  if (range === 'today') {
    return 1
  }

  if (range === '7d') {
    return 7
  }

  if (range === '30d') {
    return 30
  }

  if (range === '90d') {
    return 90
  }

  if (range === 'year') {
    const now = new Date()
    return Math.ceil((startOfLocalDay(now) - new Date(now.getFullYear(), 0, 1).getTime()) / 86_400_000) + 1
  }

  const first = rows[0]
  const last = rows[rows.length - 1]
  return first && last
    ? Math.max(1, Math.ceil((last.observed_at_ms - first.observed_at_ms) / 86_400_000))
    : 1
}

function summarizeBreaks(rows: TelemetryRow[]) {
  const breakDurations: number[] = []
  let wasWalking = false
  let breakStartedAt: number | null = null

  for (const row of rows) {
    const walking = row.walking === 1

    if (!walking && wasWalking) {
      breakStartedAt = row.observed_at_ms
    }

    if (walking && !wasWalking && breakStartedAt !== null) {
      const durationSeconds = Math.max(0, (row.observed_at_ms - breakStartedAt) / 1000)
      if (durationSeconds >= 60) {
        breakDurations.push(durationSeconds)
      }
      breakStartedAt = null
    }

    wasWalking = walking
  }

  const totalSeconds = breakDurations.reduce((total, duration) => total + duration, 0)

  return {
    count: breakDurations.length,
    totalSeconds,
    averageSeconds: breakDurations.length ? totalSeconds / breakDurations.length : 0,
    longestSeconds: breakDurations.length ? Math.max(...breakDurations) : 0,
  }
}

function buildLiveSeries(rows: TelemetryRow[]): WalkingPadLiveSeriesPoint[] {
  return rows.map((row, index) => {
    const windowStartMs = row.observed_at_ms - STEP_DERIVATIVE_WINDOW_MS
    let windowSteps = 0
    let windowActiveSeconds = 0
    let firstObservedAtMs = row.observed_at_ms

    for (let rowIndex = index; rowIndex >= 0; rowIndex -= 1) {
      const candidate = rows[rowIndex]

      if (candidate.observed_at_ms < windowStartMs) {
        break
      }

      firstObservedAtMs = candidate.observed_at_ms
      windowSteps += candidate.delta_steps
      windowActiveSeconds += candidate.delta_active_seconds
    }

    const elapsedSeconds = Math.max(windowActiveSeconds, (row.observed_at_ms - firstObservedAtMs) / 1000)

    return {
      observedAt: row.observed_at,
      observedAtMs: row.observed_at_ms,
      speedKmh: row.speed_kmh,
      stepsPerMinute: elapsedSeconds > 0 ? windowSteps / (elapsedSeconds / 60) : 0,
      deltaSteps: row.delta_steps,
    }
  })
}

function bucketRows(rows: TelemetryRow[], range: WalkingPadAnalyticsRange): WalkingPadAnalyticsBucket[] {
  const buckets = new Map<string, TelemetryRow[]>()
  const hourly = range === 'today'

  for (const row of rows) {
    const date = new Date(row.observed_at_ms)
    const key = hourly ? `${row.local_day} ${date.getHours().toString().padStart(2, '0')}:00` : row.local_day
    const existing = buckets.get(key)

    if (existing) {
      existing.push(row)
    } else {
      buckets.set(key, [row])
    }
  }

  return [...buckets.entries()].map(([label, bucket]) => {
    const activeSeconds = sum(bucket, (row) => row.delta_active_seconds)
    const weightedSpeed = sum(bucket, (row) => row.speed_kmh * row.delta_active_seconds)
    const first = bucket[0]

    return {
      label,
      start: first?.observed_at ?? new Date().toISOString(),
      steps: sum(bucket, (row) => row.delta_steps),
      distanceKm: sum(bucket, (row) => row.delta_distance_km),
      activeSeconds,
      averageSpeedKmh: activeSeconds > 0 ? weightedSpeed / activeSeconds : 0,
    }
  })
}

function isPlausibleVendorSession(startedAtMs: number) {
  return startedAtMs >= MIN_VENDOR_SESSION_MS && startedAtMs <= Date.now() + MAX_VENDOR_CLOCK_SKEW_MS
}

function databaseFileHasContent(dbPath: string) {
  return existsSync(dbPath) && statSync(dbPath).size > 0
}

function quoteSqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}
