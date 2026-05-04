# WalkingPad Menu Bar

Tiny macOS menu bar app that listens to a local WebSocket and shows the latest step count.

## Build

```sh
cd mac-menu
swift build
```

To build a Finder-launchable app bundle:

```sh
cd mac-menu
scripts/build-app.sh
open "dist/WalkingPad Menu.app"
```

The app bundle runs as a menu bar accessory app, so it does not need a Terminal window.

## Run

By default it connects to the Raspberry Pi WalkingPad server:

```text
ws://raspberrypi.local:8788/ws
```

Run it with:

```sh
swift run walkingpad-menu
```

Point it at another local WebSocket with:

```sh
WALKINGPAD_MENU_WS_URL=ws://127.0.0.1:8788/ws swift run walkingpad-menu
```

The menu includes an `Open WalkingPad` item. By default it opens the dashboard
derived from the WebSocket URL, such as:

```text
http://raspberrypi.local:8788/
```

For the `.app` bundle, configure URLs with macOS defaults:

```sh
defaults write com.mmunoz.WalkingPadMenuBar websocketURL "ws://raspberrypi.local:8788/ws"
defaults write com.mmunoz.WalkingPadMenuBar dashboardURL "http://raspberrypi.local:8788/"
```

Environment variables still work when launching from a shell:

```sh
WALKINGPAD_MENU_WS_URL=ws://127.0.0.1:8788/ws \
WALKINGPAD_MENU_DASHBOARD_URL=http://127.0.0.1:8788/ \
swift run walkingpad-menu
```

## Mock WebSocket

For testing without BLE:

```sh
node scripts/mock-websocket.mjs
```

Then run the menu app in another terminal:

```sh
WALKINGPAD_MENU_WS_URL=ws://127.0.0.1:8787/ swift run walkingpad-menu
```

The mock server sends one message per second:

```json
{"type":"live_status","dailySteps":4231}
```

## Message Format

The hot path can be a tiny full-value message:

```json
{"type":"live_status","dailySteps":4231}
```

The app also understands the current `ble-debugger` snapshot messages and extracts `parsed.steps` from treadmill data.
