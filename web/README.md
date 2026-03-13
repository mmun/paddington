# WalkingPad Web

Vite + React frontend for controlling a WalkingPad through a local Node BLE service and syncing app state to Google Drive `appDataFolder`.

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

## Architecture

- `server/` holds the Node BLE daemon using `@stoprocent/noble`
- `src/` holds the React UI plus the shared WalkingPad/FTMS packet logic
- the UI talks to the backend over HTTP + Server-Sent Events

The BLE session now lives in Node, so refreshing the page no longer disconnects the pad.

## Google Drive Sync

To enable Google OAuth and save state in Drive `appDataFolder`, set:

```bash
VITE_GOOGLE_CLIENT_ID=your-google-oauth-client-id.apps.googleusercontent.com
```

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
