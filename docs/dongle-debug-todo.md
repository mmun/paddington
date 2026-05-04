# Dongle Debug TODO

Expected arrival window: around 2026-05-03.

Goal: use two USB Bluetooth dongles for protocol discovery while the Raspberry Pi built-in Bluetooth remains the production tracker.

## Adapter Roles

- Raspberry Pi built-in Bluetooth: production tracker only. Keep `walkingpad.service` always scanning or connected, recording SQLite telemetry, serving the dashboard, and publishing WebSocket updates.
- Dongle A: passive physical-remote sniffer. Focus on `C1:00:00:00:30:3F / KS-REMOTE-01` and log every advertisement and scan response with timestamps, RSSI, adapter id, and treadmill state.
- Dongle B: remote replay/test adapter. Advertise captured physical-remote payloads without interrupting the Pi tracker.

## First Setup

- Label the dongles physically and map them to stable Linux adapter names or USB paths.
- Confirm BlueZ sees all adapters with `btmgmt info` and `hciconfig -a`.
- Keep production service pinned to the Pi built-in adapter if needed.
- Add scripts/env vars for selecting debug adapter IDs explicitly.
- Make sure debug scans/replays do not stop or reset `walkingpad.service`.

## Capture Matrix

For each capture, record:

- treadmill state: asleep, awake stopped, running, paused, or mode-changing
- physical remote action: button, long press vs single press, and number of repeats
- raw advertisement data
- raw scan response data
- interval/timing between repeated packets
- RSSI and adapter id
- Pi-side GATT notifications observed at the same time: `2ACD`, `2AD3`, `2ADA`, vendor `72`, vendor `73`
- resulting treadmill behavior: woke, started, paused, stopped, speed changed, mode changed, no-op

Actions to capture:

- wake / power from asleep
- power from awake stopped
- start from stopped
- pause while running
- stop or long-press power while running, if supported
- speed up while running
- speed down while running
- speed up/down while stopped
- manual mode
- automatic mode
- any long-press variants for speed or mode buttons
- repeated speed button bursts at each speed step

## Replay Validation

- Replay one captured packet family at a time from Dongle B.
- Keep Pi tracker connected or scanning so it records resulting treadmill telemetry.
- Compare replay results against physical remote results.
- Determine whether payload bytes encode action, counter, checksum, identity, rolling code, or timing-only behavior.
- Determine whether replay requires the exact public address `C1:00:00:00:30:3F`, adapter name `KS-REMOTE-01`, scan-response name, or only manufacturer/service data.
- Determine whether the treadmill accepts replay while already GATT-connected to the Pi.
- Determine whether the treadmill accepts replay while disconnected but awake.
- Determine whether the treadmill accepts replay while asleep.

## Implementation Follow-Ups

- Add a `remoteReplay` module separate from the FTMS/GATT command path.
- Add API commands for captured remote actions once payloads are known.
- Prefer FTMS/GATT controls when connected and remote replay only when connectionless control is needed, unless replay proves more reliable.
- After every replay burst, immediately return the production adapter to always-on scan/connect tracking.
- Store captured remote packet definitions in source with names, notes, and capture evidence.
- Add a small CLI for replaying one named remote action from a chosen adapter.
- Add docs explaining which actions are connectionless and which still require GATT.

## Open Questions

- Is wake just the base remote-presence advertisement, or does it encode a button press?
- Are start/pause/speed/mode encoded in advertisement payloads, scan responses, burst timing, or a mix?
- Is there a rolling counter or anti-replay behavior?
- Can one adapter simultaneously maintain production GATT tracking and replay remote advertisements, or do we need strict adapter separation permanently?
- Does the treadmill accept remote packets from a cloned identity while the physical remote is nearby?
- Does mode control behave differently in manual vs automatic treadmill states?
