# WalkingPad BLE Protocol

This document is a working protocol reference for the KingSmith/WalkingPad BLE interface observed on a `KS-R3F` / `KS-AP-RF3` treadmill.

The device exposes mostly standard Bluetooth Fitness Machine Service (FTMS) behavior for live treadmill control and telemetry, plus a KingSmith vendor service for settings, session timestamps, and app-specific state.

## Current Understanding

- Basic control is standard FTMS: request control, start/resume, set target speed, pause, and stop all go through characteristic `2AD9`.
- Live telemetry is standard FTMS `2ACD`: speed, distance, calories, elapsed time, and steps.
- Training/machine state is exposed through standard FTMS `2AD3` and `2ADA`.
- Settings are not FTMS. They use vendor service `24e2521c-f63b-48ed-85be-c5330a00fdf7`.
- The app needs more than FTMS for the full settings UI. It also appears to gate behavior on BLE identity/name.
- There is no observed random workout UUID. A walking session can likely be identified by treadmill identity plus the vendor `73` session start timestamp.
- The treadmill does not appear to replay the full last completed workout summary on app boot. Reconnect during an active session works because current state is still available from `2ACD`.

## Devices And Roles

Observed components:

| Role | Name | BLE address | Notes |
| --- | --- | --- | --- |
| WalkingPad | `KS-AP-RF3` | `54:50:A0:10:4E:84` | Public address, FTMS peripheral |
| Remote | `KS-REMOTE-01` | `C1:00:00:00:30:3F` | Public address, wake advertiser |
| Raspberry Pi MITM | `KS-AP-RF3` during successful MITM | `D8:3A:DD:2E:37:B4` | Pi adapter address |

App UI note: the phone app may display `KS Walking Pad` even when the BLE local name is `KS-AP-RF3`.

Important MITM note: when the Pi advertised as `KS-AP-RF3-MITM`, basic FTMS control worked but the app settings UI was incomplete. Restoring the BLE name and adapter alias to exactly `KS-AP-RF3` made the full settings UI return. For app-compatible MITM, mirror GATT and use the real BLE name.

## Advertisements

### Awake WalkingPad

Observed when the treadmill is awake and connectable:

```text
Name: KS-AP-RF3
Address: 54:50:A0:10:4E:84
Address type: Public
Service UUID: 0x1826 Fitness Machine Service
Service Data 0x1826: 01 00 01
Manufacturer company ID: 0x5054
Manufacturer data: a0 10 4e 84
Flags: 06
```

### Remote Wake

Observed remote wake advertisement:

```text
Name: KS-REMOTE-01
Address: C1:00:00:00:30:3F
Address type: Public
Service UUID: 0xfff0
Manufacturer company ID: 0x00c1
Manufacturer payload: 00 00 30 3f
Raw advertisement: 02 01 06 03 03 f0 ff 07 ff c1 00 00 00 30 3f
Raw scan response: 0d 09 4b 53 2d 52 45 4d 4f 54 45 2d 30 31
```

Working hypothesis: sleeping treadmill wake is advertisement-triggered. A replay should advertise public address `C1:00:00:00:30:3F`, service `0xfff0`, manufacturer data `c1 00 00 00 30 3f`, and scan-response name `KS-REMOTE-01`.

## GATT Database

Observed upstream GATT database:

| Service | Characteristics | Properties | Meaning |
| --- | --- | --- | --- |
| `1800` | `2A00`, `2A01`, `2A04` | read | GAP |
| `1801` | `2A05` | indicate | GATT Service Changed |
| `180A` | `2A23`..`2A29` | read | Device Information |
| `1826` | `2ACC`, `2ACD`, `2AD3`, `2AD4`, `2AD5`, `2AD7`, `2AD9`, `2ADA` | mixed | Fitness Machine Service |
| `24e2521c-f63b-48ed-85be-c5330a00fdf7` | `...b00fdf7`, `...d00fdf7` | notify, write/write-without-response | KingSmith vendor settings/session service |
| `5833ff01-9b8b-5191-6142-22a4536ef123` | `5833ff02...`, `5833ff03...` | write, notify | Secondary vendor service, not yet decoded |

### Device Information `180A`

| Characteristic | Field | Hex | Text |
| --- | --- | --- | --- |
| `2A23` | System ID | `54 50 a0 10 4e 84` | binary-like, starts with `TP`, includes address bytes |
| `2A24` | Model Number | `4b 53 2d 52 33 46` | `KS-R3F` |
| `2A25` | Serial Number | `35 34 35 30 41 30 31 30 34 45 38 34` | `5450A0104E84` |
| `2A26` | Firmware Revision | `56 37 34 2e 30 32 2e 32 33` | `V74.02.23` |
| `2A27` | Hardware Revision | `53 54` | `ST` |
| `2A28` | Software Revision | `56 30 2e 30 2e 35` | `V0.0.5` |
| `2A29` | Manufacturer | `33 46` | `3F` |

## App Startup Sequence

On a fresh app reconnect through the MITM, the phone typically does this:

1. Enables standard FTMS notifications/indications:

```text
2ACD Treadmill Data notify
2AD9 Fitness Machine Control Point indicate
2ADA Fitness Machine Status notify
```

2. Reads FTMS static/status characteristics:

| Characteristic | Example value | Meaning |
| --- | --- | --- |
| `2ACC` | `44 12 00 00 01 00 00 00` | Fitness Machine Feature bitfields |
| `2AD3` | `01 01` or `01 0f` | Training status |
| `2AD4` | `a0 00 80 02 0a 00` | Supported speed range |
| `2AD5` | `00 00 00 00 00 00` | No inclination |
| `2AD7` | `00 00 00` | No power range |

3. Enables vendor notifications:

```text
24e2521c-f63b-48ed-85be-c5330b00fdf7 notify
```

4. Runs vendor handshake and state queries:

```text
app -> treadmill: 71 00 05 ...
treadmill -> app: 71 80 00 f1
app -> treadmill: 71 01 08 ...
treadmill -> app: 71 81 09 03 00 00 00 1f 03 00 00 00 20
treadmill -> app: 73 50 0d ...
app -> treadmill: 72 00 00 00 72
treadmill -> app: 72 80 24 ...
app -> treadmill: 75 00 00 75
treadmill -> app: 75 80 0c ...
```

Reconnect behavior:

- If the belt is currently active, the app recovers current state from `2ACD`, `2AD3`, `2ADA`, and vendor `73`.
- If a session has already ended before reconnect, no capture so far shows the treadmill replaying final distance/calories/steps. It appears to boot into stopped/zero live telemetry.
- `75` did not change during active-session reconnect tests and does not appear to contain live metrics.

## FTMS Telemetry

### Treadmill Data `2ACD`

The WalkingPad sends a 17-byte FTMS Treadmill Data payload with flags `0x2484`.

Example:

```text
84 24  54 01  46 00 00  05 00  00 00  00  d0 01  8c 00 00
```

Decoded layout:

| Offset | Bytes | Field | Unit | Example |
| --- | --- | --- | --- | --- |
| 0 | `84 24` | Flags, little-endian `0x2484` | bitfield | distance, energy, elapsed, steps present |
| 2 | `54 01` | Instantaneous speed | `0.01 km/h` | `0x0154 = 340 = 3.40 km/h` |
| 4 | `46 00 00` | Total distance | metres | `70 m` |
| 7 | `05 00` | Total energy | kcal | `5 kcal` |
| 9 | `00 00` | Energy per hour | kcal/hour | not populated so far |
| 11 | `00` | Energy per minute | kcal/min | not populated so far |
| 12 | `d0 01` | Elapsed time | seconds | `464 s` |
| 14 | `8c 00 00` | Step count | steps | `140` |

Conversions:

```text
speed_kmh = speed_raw / 100
distance_m = distance_raw
distance_miles = distance_m / 1609.344
elapsed_seconds = elapsed_raw
steps = steps_raw
```

The phone app may display mph, but the FTMS value remains `0.01 km/h`.

Captured examples:

```text
App speed 2.0 mph -> control write 02 40 01 -> 0x0140 = 320 = 3.20 km/h
App speed 2.1 mph -> control write 02 54 01 -> 0x0154 = 340 = 3.40 km/h
App speed 4.0 mph -> control write 02 80 02 -> 0x0280 = 640 = 6.40 km/h
```

### Step/Distance/Calorie Behavior

Distance, calories, and steps appear walker-derived, not simply belt-derived.

Evidence:

- While the user was walking, steps/distance/calories advanced.
- When the user stepped off but the belt kept running, speed and elapsed time continued, while distance/calories/steps froze.
- At `6.40 km/h`, one capture plateaued at `110 m`, `8 kcal`, and `163 steps` while elapsed time kept advancing.

Open detail: in one snapshot the app showed `150` steps while BLE `2ACD` showed `140`. That could be display lag, smoothing, app-side correction, or another source.

### Training Status `2AD3`

Observed values:

| Value | Meaning |
| --- | --- |
| `03 0e 33 00 00 00`, then `...32...`, `...31...`, `...30...` | Start countdown-like sequence |
| `01 0d` | Running-ish state |
| `01 0f` | Paused state |
| `01 01` | Stopped state |

### Machine Status `2ADA`

Observed notifications:

| Notify | Meaning |
| --- | --- |
| `04` | Start/resume completed or running |
| `02 02` | Paused |
| `02 01` | Stopped/session ended |
| `05 xx xx` | Speed changed, little-endian `0.01 km/h` |

Examples:

| Notify | Decode |
| --- | --- |
| `05 f0 00` | `2.40 km/h` |
| `05 40 01` | `3.20 km/h` |
| `05 90 01` | `4.00 km/h` |

## FTMS Control

Control uses standard FTMS Fitness Machine Control Point `2AD9`.

Observed commands:

| App write | Meaning | Treadmill response |
| --- | --- | --- |
| `00` | Request Control | `80 00 01` |
| `07` | Start or Resume | `80 07 01` |
| `02 xx xx` | Set Target Speed | `80 02 01 xx xx` |
| `08 02` | Pause | `80 08 01 02` |
| `08 01` | Stop/end session | `80 08 01 01` |

Result codes:

| Code | Meaning |
| --- | --- |
| `01` | Success |
| `04` | Failed |

Operational finding: serialize control point writes. During early relay testing, forwarding multiple writes without waiting for each `0x80` response caused dropped commands and `80 07 04` failures. Queueing one upstream control command at a time fixed Start and Set Target Speed.

### Pause And Stop Effects

Pause:

```text
app -> treadmill: 00
treadmill -> app: 80 00 01
app -> treadmill: 08 02
treadmill -> app: 80 08 01 02
treadmill -> app: 2ADA 02 02
```

The belt then ramps down while preserving distance/calories/steps.

Stop/end:

```text
app -> treadmill: 00
treadmill -> app: 80 00 01
app -> treadmill: 08 01
treadmill -> app: 80 08 01 01
treadmill -> app: 73 50 0d ... <start_ts> ... <end_ts> ...
treadmill -> app: 2ADA 02 01
treadmill -> app: 2AD3 01 01
treadmill -> app: 2ACD all-zero telemetry
```

No immediate or delayed `75` query was observed on pause or stop. The app appears to rely on `2ACD`, `2AD3`, `2ADA`, and vendor `73`.

## Supported Speed Range `2AD4`

`2AD4` is read-only. Attempting to write a minimum speed of `0.00 km/h` failed with `org.bluez.Error.NotPermitted`.

Observed values:

| Mode/profile | `2AD4` value | Decode |
| --- | --- | --- |
| Imperial/friendly profile | `a0 00 80 02 0a 00` | min `1.60 km/h`, max `6.40 km/h`, step `0.10 km/h` |
| Metric profile | `64 00 58 02 0a 00` | min `1.00 km/h`, max `6.00 km/h`, step `0.10 km/h` |

Changing units in the app requires a treadmill power-cycle. After power-cycle, `2AD4` changes and confirms which profile persisted.

## Vendor Service `24e2521c...`

Primary app-specific vendor service:

```text
Service: 24e2521c-f63b-48ed-85be-c5330a00fdf7
Notify:  24e2521c-f63b-48ed-85be-c5330b00fdf7
Write:   24e2521c-f63b-48ed-85be-c5330d00fdf7
```

Frame shape:

```text
request:  <command> <subcommand/index> <length?> <payload...> <checksum?>
response: <command> <subcommand|0x80> <length?> <payload...> <checksum?>
status:   <command> 50 <length?> <payload...> <status/checksum?>
```

For observed `72 01` setting writes, the final byte is the modulo-256 sum of all prior bytes:

```text
72 01 03 08 03 00 -> 0x81
72 01 03 08 01 00 -> 0x7f
```

The final byte in some `72 50` status frames is not yet fully explained by the same rule.

### `71` Handshake

Typical startup handshake:

```text
app -> treadmill: 71 00 05 <payload> <checksum>
treadmill -> app: 71 80 00 f1
app -> treadmill: 71 01 08 <timestamp_or_nonce> 86 92 60 00 <checksum>
treadmill -> app: 71 81 09 03 00 00 00 1f 03 00 00 00 20
```

The app payload varies per reconnect. The stable `86 92 60 00` value also appears in `73` session/status frames. Its semantic meaning is unknown.

### `73` Session/Status Notification

`73 50 0d` appears to carry session timestamps.

Example while connected:

```text
73 50 0d 00 81 0c e7 69 86 92 60 00 00 00 00 00 b2
```

Layout:

| Offset | Bytes | Meaning |
| --- | --- | --- |
| 0 | `73` | Command class |
| 1 | `50` | Status/notification opcode |
| 2 | `0d` | Payload length, 13 bytes |
| 3 | `00` | Unknown status/type byte |
| 4 | `81 0c e7 69` | Little-endian Unix timestamp, likely session start |
| 8 | `86 92 60 00` | Unknown stable 32-bit value |
| 12 | `00 00 00 00` | End timestamp, zero when not reporting an ended session |
| 16 | `b2` | Checksum/status byte |

Example stop/end frame:

```text
73 50 0d 00 81 0c e7 69 86 92 60 00 08 0f e7 69 19
```

Decoded:

```text
start timestamp: 81 0c e7 69 -> 2026-04-21 01:34:57 local
end timestamp:   08 0f e7 69 -> 2026-04-21 01:45:44 local
```

Working session identifier:

```text
treadmill_serial_or_ble_address + session_start_timestamp
```

### `72` Settings Query And Writes

Settings snapshot query:

```text
app -> treadmill: 72 00 00 00 72
treadmill -> app: 72 80 24 <nine 4-byte records> <checksum>
```

Snapshot records appear to be:

```text
<key:1> 00 <value_le16>
```

Current imperial/friendly snapshot after power-cycle:

```text
72 80 24
01 00 03 00
04 00 0e 00
05 00 00 00
02 00 05 e0
08 00 05 00
0a 00 00 03
06 00 00 00
09 00 01 00
07 00 40 00
89
```

Metric snapshot after unit change and power-cycle:

```text
72 80 24
01 00 00 00
04 00 0e 00
05 00 00 00
02 00 05 e0
08 00 05 00
0a 00 00 03
06 00 00 00
09 00 01 00
07 00 3c 00
82
```

Known snapshot keys:

| Key | Meaning | Notes |
| --- | --- | --- |
| `0x01` | Unit/profile setting | Immediate write enum differs from persisted snapshot enum |
| `0x02` | No-load stop setting/status | Values encode seconds plus mode/enable bits |
| `0x04` | Unknown | Observed `0x000e` |
| `0x05` | Unknown | Observed `0x0000` |
| `0x06` | Child lock | Status frames have longer payloads |
| `0x07` | Max speed candidate | Metric `0x003c` = `6.0`, imperial `0x0040` = `6.4` |
| `0x08` | Buzzer/marquee bitfield | See below |
| `0x09` | Unknown | Observed `0x0001` |
| `0x0a` | Mode/sleep state | Manual/automatic/standby |

#### Units/Profile

Immediate app writes:

| UI action | App write | Ack | Status |
| --- | --- | --- | --- |
| Metric | `72 01 03 01 01 00 78` | `72 81 02 01 00 f6` | `72 50 03 01 01 00 02` |
| Imperial | `72 01 03 01 02 00 79` | `72 81 02 01 00 f6` | `72 50 03 01 02 00 03` |

Persisted snapshot after restart:

| Profile | Snapshot `0x01` | Snapshot `0x07` | `2AD4` |
| --- | --- | --- | --- |
| Metric | `0x0000` | `0x003c` | `1.00-6.00 km/h` |
| Imperial | `0x0003` | `0x0040` | `1.60-6.40 km/h` |

#### No-Load Stop `0x02`

Observed writes:

| UI action | App write | Status |
| --- | --- | --- |
| 60s | `72 01 03 02 3c e0 94` | `72 50 03 02 3c e0 1e` |
| 45s | `72 01 03 02 2d e0 85` | `72 50 03 02 2d e0 0f` |
| 30s | `72 01 03 02 1e e0 76` | `72 50 03 02 1e e0 00` |
| 15s | `72 01 03 02 0f e0 67` | `72 50 03 02 0f e0 f1` |
| 5s | `72 01 03 02 05 e0 5d` | `72 50 03 02 05 e0 e7` |
| Off | `72 01 03 02 00 00 78` | `72 50 03 02 3c 40 7e` |

Ack for key `0x02` writes:

```text
72 81 02 02 00 f7
```

#### Buzzer And Marquee `0x08`

Observed writes/status:

| UI action | App write | Status |
| --- | --- | --- |
| Buzzer on | `72 01 03 08 03 00 81` | `72 50 03 08 07 00 0f` |
| Buzzer off | `72 01 03 08 01 00 7f` | `72 50 03 08 05 00 0d` |
| Marquee on | `72 01 03 08 0c 00 8a` | `72 50 03 08 0d 00 15` |
| Marquee off | `72 01 03 08 04 00 82` | `72 50 03 08 05 00 0d` |

Ack for key `0x08` writes:

```text
72 81 02 08 00 fd
```

Status bitfield hypothesis:

| Bit | Meaning | Evidence |
| --- | --- | --- |
| `0x01` | Baseline/always set | Present in observed status values |
| `0x02` | Buzzer enabled | `0x0005 -> 0x0007` |
| `0x04` | Unknown baseline/capability/current bit | Present in `0x0005`, `0x0007`, `0x000d` |
| `0x08` | Marquee light enabled | `0x0005 -> 0x000d` |

#### Child Lock `0x06`

| UI action | App write | Ack | Status |
| --- | --- | --- | --- |
| On | `72 01 03 06 03 00 7f` | `72 81 02 06 00 fb` | `72 50 06 06 02 00 0a 00 03 15` |
| Off | `72 01 03 06 00 00 7c` | `72 81 02 06 00 fb` | `72 50 06 06 00 00 0a 00 03 13` |

#### Mode And Sleep `0x0a`

| UI/action | App write or status | Ack/status |
| --- | --- | --- |
| Manual | `72 01 03 0a 00 00 80` | `72 50 03 0a 00 03 0d` |
| Automatic | `72 01 03 0a 20 00 a0` | `72 50 03 0a 20 03 2d` |
| Sleep/standby | `72 01 03 0a 40 00 c0` | `72 50 03 0a 40 03 4d` |

Ack for key `0x0a` writes:

```text
72 81 02 0a 00 ff
```

Remote manual/automatic toggles produce the same `72 50 03 0a ...` status notifications, without phone-side app writes.

### `75` Query

The app sends this after settings snapshot:

```text
app -> treadmill: 75 00 00 75
treadmill -> app: 75 80 0c 02 00 00 00 02 00 00 00 00 00 00 00 05
```

Structural decode:

| Offset | Bytes | Meaning |
| --- | --- | --- |
| 0 | `75` | Command class |
| 1 | `80` | Response opcode |
| 2 | `0c` | Payload length, 12 bytes |
| 3 | `02 00 00 00` | Field 1, little-endian `uint32 = 2` |
| 7 | `02 00 00 00` | Field 2, little-endian `uint32 = 2` |
| 11 | `00 00 00 00` | Field 3, little-endian `uint32 = 0` |
| 15 | `05` | Modulo-256 sum of prior bytes |

Finding: `75` did not encode live running metrics and did not change when reconnecting during an active belt run. It may be a workout/session capability or state block, but its semantics are still unknown.

## Remote Control While Phone Is Connected

Remote actions do not appear as phone-side `2AD9` writes. They are visible as treadmill-originated notifications:

| Event | Observed notifications | Notes |
| --- | --- | --- |
| Remote start | `2AD3` countdown, then `2ADA 04`, then `2ACD` speed `a0 00` | Belt started at `1.60 km/h` |
| Remote speed up | `2ADA 05 f0 00`, `2ACD` speed `f0 00` | `2.40 km/h` |
| Remote speed up | `2ADA 05 40 01`, `2ACD` speed `40 01` | `3.20 km/h` |
| Remote speed up | `2ADA 05 90 01`, `2ACD` speed `90 01` | `4.00 km/h` |
| Remote automatic | `72 50 03 0a 20 03 2d` | Mode/status key `0x0a` |
| Remote manual | `72 50 03 0a 00 03 0d` | Mode/status key `0x0a` |
| Remote speed down x3 while stopped | no connected-session BLE traffic observed | No `2ACD`, `2ADA`, `2AD3`, or vendor notification |

## Legacy FE00 Protocol

Older/non-FTMS WalkingPad control uses:

```text
Service: 0000fe00-0000-1000-8000-00805f9b34fb
Notify:  0000fe01-0000-1000-8000-00805f9b34fb
Write:   0000fe02-0000-1000-8000-00805f9b34fb
```

Known frame shape from the existing app:

```text
f7 a2 <command> <payload> <crc> fd
```

The checksum is the sum of bytes from index `1` through the byte before checksum, modulo 256.

Known commands:

| Command | Payload | Meaning |
| --- | --- | --- |
| `00` | `00` | Ask stats |
| `01` | speed in `0.1 km/h` | Change speed |
| `02` | mode | Switch mode |
| `04` | `01` | Start belt |

Known modes:

| Value | Meaning |
| --- | --- |
| `00` | Automatic |
| `01` | Manual |
| `02` | Standby |

This legacy protocol is separate from the FTMS path used by the captured `KS-R3F`.

## MITM Implementation Notes

Current Pi relay behavior:

- Connects upstream to real WalkingPad `54:50:A0:10:4E:84`.
- Advertises a fake FTMS peripheral using name `KS-AP-RF3`.
- Exposes local FTMS relay characteristics `2ACD`, `2AD9`, and `2ADA`.
- Mirrors all other non-system upstream GATT services/characteristics/descriptors.
- Proxies mirrored reads, writes, and notifications to/from the real treadmill.
- Logs phone-side reads, writes, notify enables/disables, and upstream values.
- Queues phone `2AD9` writes and forwards one upstream control command at a time.

Power-cycle behavior: treadmill sleep/off usually stales the Pi's upstream connection. Restart the relay after the treadmill wakes and advertises again.

Pairing note: iOS may prompt for OS-level numeric-code pairing with the Pi identity. Reject the prompt. The observed FTMS/vendor GATT relay traffic does not require confirming OS pairing.

## WebUSB / Firmware Bridge Direction

Desired future shape:

```text
browser WebUSB/WebSerial
  -> USB MCU or nRF bridge
  -> BLE central/peripheral firmware
  -> WalkingPad FTMS or remote-wake advertisement
```

Recommended split:

- Keep FTMS and vendor-frame parsing in TypeScript as pure functions.
- Implement a transport abstraction with BLE, WebUSB, and WebSerial backends.
- Treat FTMS as the primary protocol for `KS-R3F`.
- Keep legacy FE00 support as a separate codec.
- For nRF firmware, expose a simple framed USB protocol for scanning, connecting, GATT reads/writes, notifications, advertisement control, and BLE identity/address configuration.

Candidate USB message types:

| Type | Direction | Meaning |
| --- | --- | --- |
| `scan_start` | host -> bridge | Start BLE scan |
| `connect` | host -> bridge | Connect to WalkingPad |
| `gatt_write` | host -> bridge | Write `2AD9` or vendor characteristic |
| `notify` | bridge -> host | Forward `2ACD`, `2AD3`, `2ADA`, or vendor notifications |
| `advertise_start` | host -> bridge | Start wake or fake peripheral advertisement |
| `identity_set` | host -> bridge | Set random/static BLE address or advertising identity |

WebUSB is clean for custom firmware, but WebSerial may be simpler during early development because it avoids browser USB descriptor friction.

## Open Questions

- Decode vendor service `5833ff01-9b8b-5191-6142-22a4536ef123`.
- Identify the stable `86 92 60 00` value in `71` and `73` frames.
- Fully explain `72 50` final status/checksum bytes.
- Confirm whether the treadmill ever replays a last completed workout outcome if the phone reconnects after a disconnected stop.
- Decode snapshot keys `0x04`, `0x05`, and `0x09`.
- Confirm whether `0x07` is always max speed in deci-km/h across more models/profiles.
