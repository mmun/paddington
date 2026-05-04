# WalkingPad Web

Always-on web dashboard for controlling and tracking a KingSmith WalkingPad from a Raspberry Pi.

The Node server owns the BLE connection, records every treadmill status event to SQLite, tracks walking sessions from the vendor `73` start timestamp with an inferred fallback, serves the React dashboard, exposes analytics APIs, and publishes a live WebSocket stream for the macOS menu bar app.

## Development

```bash
npm install
npm run dev
```

`npm run dev` starts both:
- the local BLE API on `http://127.0.0.1:8788`
- the Vite UI on `http://localhost:5173`

If you are on macOS, make sure the terminal app running `npm run dev` has Bluetooth permission in System Settings.

If you only need the backend, run:

```bash
npm run dev:server
```

After `npm run build`, the backend also serves the built dashboard from `http://127.0.0.1:8788`.

## Raspberry Pi

The default target comes from `docs/protocol.md`:

```text
WalkingPad: KS-AP-RF3 / 54:50:A0:10:4E:84
Remote wake: KS-REMOTE-01 / C1:00:00:00:30:3F
```

Useful environment variables:

```bash
WALKINGPAD_SERVER_HOST=0.0.0.0
WALKINGPAD_SERVER_PORT=8788
WALKINGPAD_REDIRECT_PORT=8787
WALKINGPAD_ADDRESS=54:50:A0:10:4E:84
WALKINGPAD_NAME=KS-AP-RF3
WALKINGPAD_AUTO_CONNECT=1
WALKINGPAD_AUTO_SCAN_MS=10000
WALKINGPAD_AUTO_RETRY_MS=0
WALKINGPAD_STALE_LINK_MS=45000
WALKINGPAD_DB_PATH=/var/lib/walkingpad/walkingpad.sqlite
WALKINGPAD_WAKE_ADDRESS=C1:00:00:00:30:3F
```

Run:

```bash
npm install
npm run build
WALKINGPAD_SERVER_HOST=0.0.0.0 npm run serve
```

For a real "wake from sleep" replay, set `WALKINGPAD_WAKE_COMMAND` to a Pi-local script if the built-in BlueZ advertisement is not enough for your treadmill:

```bash
WALKINGPAD_WAKE_COMMAND=/usr/local/bin/walkingpad-wake npm run serve
```

A systemd starter is included at `scripts/walkingpad.service.example`.

For wake-from-sleep, install both:

```bash
sudo install -m 0755 scripts/walkingpad-wake.sh /usr/local/bin/walkingpad-wake
sudo install -m 0755 scripts/walkingpad-set-remote-identity.sh /usr/local/bin/walkingpad-set-remote-identity
sudo install -m 0755 scripts/walkingpad-trigger-wake.sh /usr/local/bin/walkingpad-trigger-wake
sudo install -m 0644 scripts/walkingpad-wake.service.example /etc/systemd/system/walkingpad-wake.service
sudo install -m 0644 scripts/walkingpad.service.example /etc/systemd/system/walkingpad.service
sudo systemctl daemon-reload
sudo systemctl enable --now walkingpad
```

The tracker runs with the captured physical remote identity
`C1:00:00:00:30:3F / KS-REMOTE-01`. The wake job advertises the recorded remote
payload using that same identity, then restarts tracking.

Set the Pi adapter identity once before starting the service:

```bash
sudo systemctl stop walkingpad
sudo /usr/local/bin/walkingpad-set-remote-identity
sudo systemctl start walkingpad
```

## Architecture

- `server/` holds the Node BLE daemon using `@stoprocent/noble`
- `server/telemetryStore.ts` owns SQLite persistence, walking sessions, and analytics rollups
- `src/` holds the React dashboard plus the shared WalkingPad/FTMS packet logic
- the UI talks to the backend over HTTP + Server-Sent Events
- the menu bar app listens to `ws://<host>:8788/ws`

The BLE session now lives in Node, so refreshing the page no longer disconnects the pad.

With `WALKINGPAD_AUTO_CONNECT=1`, the server continuously tries to own the BLE
session. When disconnected, it scans for advertisements for
`WALKINGPAD_AUTO_SCAN_MS`, then retries after `WALKINGPAD_AUTO_RETRY_MS` instead
of sleeping between scan windows. When marked connected, the server expects
regular BLE notifications; if the link is quiet for `WALKINGPAD_STALE_LINK_MS`,
it resets the stale connection and returns to scanning.

## SQLite Data Safety

The Pi service stores telemetry outside the deployed app tree:

```text
/var/lib/walkingpad/walkingpad.sqlite
```

Deploys can replace `/home/pi/walkingpad/web` without touching the SQLite file. The server also:

- uses SQLite WAL mode with `synchronous=FULL`
- runs `PRAGMA quick_check` at startup
- refuses to open a DB with a newer schema than the code supports
- creates a timestamped backup in `/var/lib/walkingpad/backups/` before migrating an existing DB
- never deletes treadmill status events during session reconciliation

## Verification

```bash
npm run lint
npm run build
```

## Local Error Listener

To collect client-side errors in a local loop while testing:

```bash
npm run error:listener
```

The frontend will POST browser and app errors to `http://127.0.0.1:8787/client-error` by default. You can override that with `VITE_ERROR_REPORT_URL`.
