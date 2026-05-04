# WalkingPad BLE Debugger

Standalone Node web app for live-debugging the WalkingPad BLE protocol.

The web server, WebSocket layer, protocol parser, command builder, and BLE transport are all Node. BLE uses `node-ble`, which talks to BlueZ over D-Bus. This is intended for Raspberry Pi/Linux, not macOS.

It connects directly to the treadmill as a BLE central, subscribes to known FTMS/vendor characteristics, displays raw values plus parsed interpretations, logs every read/write/notification/response, and exposes broad command buttons for protocol exploration.

## Run

```sh
cd ble-debugger
npm install
npm start
```

Then open:

```text
http://localhost:8787
```

Default target:

```text
KS-AP-RF3 / 54:50:A0:10:4E:84
```

Override with environment variables:

```sh
WALKINGPAD_ADDRESS=54:50:A0:10:4E:84 PORT=8787 npm start
```

## Deploy/Restart On Raspberry Pi

From the Mac:

```sh
cd ble-debugger
npm run pi
```

That command:

- rsyncs this folder to `pi@raspberrypi.local:/home/pi/walkingpad/ble-debugger`.
- Runs `npm install --omit=optional` on the Pi.
- Stops any previous debugger server started from that folder.
- Starts `node src/server.js` on the Pi with `HOST=0.0.0.0` and `PORT=8787`.
- Writes logs to `/home/pi/walkingpad/ble-debugger/server.log`.

Override target/port if needed:

```sh
PI_HOST=pi@raspberrypi.local PI_DIR=/home/pi/walkingpad/ble-debugger PORT=8788 npm run pi
```

## Bluetooth Notes

This app expects Linux + BlueZ. On Raspberry Pi, make sure `bluetooth.service` is running and the user can access BlueZ over D-Bus. Running with `sudo npm start` is the blunt path if normal-user BLE access fails.

`node-ble` is Linux/BlueZ-only. macOS is not supported by this direct-Node transport.

## Safety

This is intentionally a debugging console. Buttons are not gated by treadmill state. Some commands may fail, be ignored, put the treadmill to sleep, or disconnect BLE. Keep the physical treadmill clear while testing.
