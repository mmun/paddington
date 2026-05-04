"use strict";

const FTMS_SERVICE = "0000182600001000800000805f9b34fb";
const DEVICE_INFO_SERVICE = "0000180a00001000800000805f9b34fb";
const VENDOR_SERVICE = "24e2521cf63b48ed85bec5330a00fdf7";
const VENDOR2_SERVICE = "5833ff019b8b5191614222a4536ef123";

const KNOWN_CHARACTERISTICS = [
  { id: "2a23", uuid: "00002a2300001000800000805f9b34fb", service: DEVICE_INFO_SERVICE, name: "System ID", role: "device-info", readable: true },
  { id: "2a24", uuid: "00002a2400001000800000805f9b34fb", service: DEVICE_INFO_SERVICE, name: "Model Number", role: "device-info", readable: true },
  { id: "2a25", uuid: "00002a2500001000800000805f9b34fb", service: DEVICE_INFO_SERVICE, name: "Serial Number", role: "device-info", readable: true },
  { id: "2a26", uuid: "00002a2600001000800000805f9b34fb", service: DEVICE_INFO_SERVICE, name: "Firmware Revision", role: "device-info", readable: true },
  { id: "2a27", uuid: "00002a2700001000800000805f9b34fb", service: DEVICE_INFO_SERVICE, name: "Hardware Revision", role: "device-info", readable: true },
  { id: "2a28", uuid: "00002a2800001000800000805f9b34fb", service: DEVICE_INFO_SERVICE, name: "Software Revision", role: "device-info", readable: true },
  { id: "2a29", uuid: "00002a2900001000800000805f9b34fb", service: DEVICE_INFO_SERVICE, name: "Manufacturer", role: "device-info", readable: true },
  { id: "2acc", uuid: "00002acc00001000800000805f9b34fb", service: FTMS_SERVICE, name: "Fitness Machine Feature", role: "ftms-feature", readable: true },
  { id: "2acd", uuid: "00002acd00001000800000805f9b34fb", service: FTMS_SERVICE, name: "Treadmill Data", role: "ftms-treadmill-data", notifiable: true },
  { id: "2ad3", uuid: "00002ad300001000800000805f9b34fb", service: FTMS_SERVICE, name: "Training Status", role: "ftms-training-status", readable: true, notifiable: true },
  { id: "2ad4", uuid: "00002ad400001000800000805f9b34fb", service: FTMS_SERVICE, name: "Supported Speed Range", role: "ftms-speed-range", readable: true },
  { id: "2ad5", uuid: "00002ad500001000800000805f9b34fb", service: FTMS_SERVICE, name: "Supported Inclination Range", role: "ftms-inclination-range", readable: true },
  { id: "2ad7", uuid: "00002ad700001000800000805f9b34fb", service: FTMS_SERVICE, name: "Supported Power Range", role: "ftms-power-range", readable: true },
  { id: "2ad9", uuid: "00002ad900001000800000805f9b34fb", service: FTMS_SERVICE, name: "Fitness Machine Control Point", role: "ftms-control-point", writable: true, notifiable: true },
  { id: "2ada", uuid: "00002ada00001000800000805f9b34fb", service: FTMS_SERVICE, name: "Fitness Machine Status", role: "ftms-machine-status", notifiable: true },
  { id: "vendorNotify", uuid: "24e2521cf63b48ed85bec5330b00fdf7", service: VENDOR_SERVICE, name: "KingSmith Vendor Notify", role: "vendor-frame", notifiable: true },
  { id: "vendorWrite", uuid: "24e2521cf63b48ed85bec5330d00fdf7", service: VENDOR_SERVICE, name: "KingSmith Vendor Write", role: "vendor-frame", writable: true },
  { id: "vendor2Write", uuid: "5833ff029b8b5191614222a4536ef123", service: VENDOR2_SERVICE, name: "Secondary Vendor Write", role: "unknown-vendor", writable: true },
  { id: "vendor2Notify", uuid: "5833ff039b8b5191614222a4536ef123", service: VENDOR2_SERVICE, name: "Secondary Vendor Notify", role: "unknown-vendor", notifiable: true }
];

const KNOWN_BY_UUID = new Map(KNOWN_CHARACTERISTICS.map((item) => [item.uuid, item]));
const KNOWN_BY_ID = new Map(KNOWN_CHARACTERISTICS.map((item) => [item.id, item]));

const COMMAND_DEFS = [
  { id: "ftms.requestControl", group: "FTMS Control", label: "Request Control" },
  { id: "ftms.start", group: "FTMS Control", label: "Start / Resume" },
  { id: "ftms.pause", group: "FTMS Control", label: "Pause" },
  { id: "ftms.stop", group: "FTMS Control", label: "Stop / End" },
  { id: "vendor.querySettings", group: "Vendor Queries", label: "Query Settings Snapshot" },
  { id: "vendor.querySession", group: "Vendor Queries", label: "Query Session Block" },
  { id: "vendor.unitsMetric", group: "Settings: Units", label: "Units: Metric" },
  { id: "vendor.unitsImperial", group: "Settings: Units", label: "Units: Imperial" },
  { id: "vendor.noLoadOff", group: "Settings: No-Load Stop", label: "No-Load Stop: Off" },
  { id: "vendor.noLoad5", group: "Settings: No-Load Stop", label: "No-Load Stop: 5s" },
  { id: "vendor.noLoad15", group: "Settings: No-Load Stop", label: "No-Load Stop: 15s" },
  { id: "vendor.noLoad30", group: "Settings: No-Load Stop", label: "No-Load Stop: 30s" },
  { id: "vendor.noLoad45", group: "Settings: No-Load Stop", label: "No-Load Stop: 45s" },
  { id: "vendor.noLoad60", group: "Settings: No-Load Stop", label: "No-Load Stop: 60s" },
  { id: "vendor.buzzerOn", group: "Settings: Buzzer/Light", label: "Buzzer On" },
  { id: "vendor.buzzerOff", group: "Settings: Buzzer/Light", label: "Buzzer Off" },
  { id: "vendor.marqueeOn", group: "Settings: Buzzer/Light", label: "Marquee On" },
  { id: "vendor.marqueeOff", group: "Settings: Buzzer/Light", label: "Marquee Off" },
  { id: "vendor.childLockOn", group: "Settings: Child Lock", label: "Child Lock On" },
  { id: "vendor.childLockOff", group: "Settings: Child Lock", label: "Child Lock Off" },
  { id: "vendor.manual", group: "Settings: Mode", label: "Manual Mode" },
  { id: "vendor.automatic", group: "Settings: Mode", label: "Automatic Mode" },
  { id: "vendor.sleep", group: "Settings: Mode", label: "Sleep / Standby" }
];

function normalizeUuid(uuid) {
  return String(uuid || "").replace(/-/g, "").toLowerCase();
}

function shortUuid(uuid) {
  const normalized = normalizeUuid(uuid);
  if (normalized.length === 32 && normalized.endsWith("00001000800000805f9b34fb")) {
    return normalized.slice(4, 8);
  }
  return normalized;
}

function toHex(buffer) {
  return Buffer.from(buffer || []).toString("hex").toUpperCase().replace(/../g, "$& ").trim();
}

function fromHex(hex) {
  const clean = String(hex || "").replace(/[^0-9a-f]/gi, "");
  if (!clean) return Buffer.alloc(0);
  if (clean.length % 2 !== 0) {
    throw new Error("Hex payload must contain an even number of hex digits.");
  }
  return Buffer.from(clean, "hex");
}

function checksum(bytes) {
  let sum = 0;
  for (const byte of bytes) sum = (sum + byte) & 0xff;
  return sum;
}

function appendChecksum(bytes) {
  const payload = Array.from(bytes);
  payload.push(checksum(payload));
  return Buffer.from(payload);
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function textValue(buffer) {
  return Buffer.from(buffer).toString("utf8").replace(/\0+$/g, "");
}

function timestamp(value) {
  if (!value) return null;
  const date = new Date(value * 1000);
  return {
    unix: value,
    iso: date.toISOString(),
    local: date.toLocaleString()
  };
}

function parseCharacteristicValue(characteristicIdOrUuid, buffer) {
  const id = shortUuid(characteristicIdOrUuid);
  const known = KNOWN_BY_ID.get(id) || KNOWN_BY_UUID.get(normalizeUuid(characteristicIdOrUuid));
  const role = known ? known.role : "unknown";

  try {
    switch (role) {
      case "device-info":
        return parseDeviceInfo(id, buffer);
      case "ftms-feature":
        return parseFtmsFeature(buffer);
      case "ftms-treadmill-data":
        return parseTreadmillData(buffer);
      case "ftms-training-status":
        return parseTrainingStatus(buffer);
      case "ftms-speed-range":
        return parseSpeedRange(buffer);
      case "ftms-inclination-range":
        return parseInclinationRange(buffer);
      case "ftms-power-range":
        return parsePowerRange(buffer);
      case "ftms-control-point":
        return parseControlPoint(buffer);
      case "ftms-machine-status":
        return parseMachineStatus(buffer);
      case "vendor-frame":
        return parseVendorFrame(buffer);
      default:
        return { kind: role, length: buffer.length };
    }
  } catch (error) {
    return { kind: role, error: error.message, length: buffer.length };
  }
}

function parseDeviceInfo(id, buffer) {
  if (id === "2a23") {
    return { kind: "device-info", field: "System ID", hex: toHex(buffer) };
  }
  return { kind: "device-info", text: textValue(buffer) };
}

function parseFtmsFeature(buffer) {
  return {
    kind: "ftms-feature",
    fitnessMachineFeatures: buffer.length >= 4 ? hexNumber(buffer.readUInt32LE(0), 8) : null,
    targetSettingFeatures: buffer.length >= 8 ? hexNumber(buffer.readUInt32LE(4), 8) : null
  };
}

function parseTreadmillData(buffer) {
  if (buffer.length < 17) throw new Error("Expected 17-byte WalkingPad treadmill data payload.");
  const flags = buffer.readUInt16LE(0);
  const speedRaw = buffer.readUInt16LE(2);
  const distanceM = readUInt24LE(buffer, 4);
  const calories = buffer.readUInt16LE(7);
  const energyPerHour = buffer.readUInt16LE(9);
  const energyPerMinute = buffer[11];
  const elapsedSeconds = buffer.readUInt16LE(12);
  const steps = readUInt24LE(buffer, 14);

  return {
    kind: "ftms-treadmill-data",
    flags: hexNumber(flags, 4),
    speedKmh: speedRaw / 100,
    speedRaw,
    distanceM,
    distanceMi: distanceM / 1609.344,
    calories,
    energyPerHour,
    energyPerMinute,
    elapsedSeconds,
    steps,
    flagDecode: {
      totalDistancePresent: Boolean(flags & (1 << 2)),
      expendedEnergyPresent: Boolean(flags & (1 << 7)),
      elapsedTimePresent: Boolean(flags & (1 << 10)),
      stepCountPresent: Boolean(flags & (1 << 13))
    }
  };
}

function parseTrainingStatus(buffer) {
  const hex = toHex(buffer);
  if (buffer.length >= 6 && buffer[0] === 0x03 && buffer[1] === 0x0e) {
    const ascii = String.fromCharCode(buffer[2]);
    return { kind: "ftms-training-status", status: "start-countdown", countdown: /^\d$/.test(ascii) ? Number(ascii) : null, hex };
  }
  const statusByte = buffer.length >= 2 ? buffer[1] : null;
  const status = {
    0x01: "stopped",
    0x0d: "running-ish",
    0x0f: "paused"
  }[statusByte] || "unknown";
  return { kind: "ftms-training-status", status, statusByte, hex };
}

function parseSpeedRange(buffer) {
  if (buffer.length < 6) throw new Error("Expected 6-byte Supported Speed Range.");
  return {
    kind: "ftms-supported-speed-range",
    minKmh: buffer.readUInt16LE(0) / 100,
    maxKmh: buffer.readUInt16LE(2) / 100,
    incrementKmh: buffer.readUInt16LE(4) / 100
  };
}

function parseInclinationRange(buffer) {
  if (buffer.length < 6) return { kind: "ftms-supported-inclination-range", raw: toHex(buffer) };
  return {
    kind: "ftms-supported-inclination-range",
    min: buffer.readInt16LE(0) / 10,
    max: buffer.readInt16LE(2) / 10,
    increment: buffer.readUInt16LE(4) / 10
  };
}

function parsePowerRange(buffer) {
  if (buffer.length < 3) return { kind: "ftms-supported-power-range", raw: toHex(buffer) };
  return {
    kind: "ftms-supported-power-range",
    minWatts: buffer.readInt8(0),
    maxWattsRaw: buffer[1],
    incrementWatts: buffer[2]
  };
}

function parseControlPoint(buffer) {
  if (buffer[0] === 0x80) {
    const requestOpcode = buffer[1];
    const resultCode = buffer[2];
    return {
      kind: "ftms-control-point-response",
      requestOpcode,
      request: ftmsOpcodeName(requestOpcode),
      resultCode,
      result: resultCode === 0x01 ? "success" : resultCode === 0x04 ? "failed" : "unknown",
      responsePayload: toHex(buffer.slice(3))
    };
  }
  return {
    kind: "ftms-control-point-write",
    opcode: buffer[0],
    operation: ftmsOpcodeName(buffer[0]),
    payload: toHex(buffer.slice(1))
  };
}

function ftmsOpcodeName(opcode) {
  return {
    0x00: "request-control",
    0x02: "set-target-speed",
    0x07: "start-or-resume",
    0x08: "stop-or-pause"
  }[opcode] || "unknown";
}

function parseMachineStatus(buffer) {
  if (buffer[0] === 0x04) return { kind: "ftms-machine-status", status: "running/start-resume" };
  if (buffer[0] === 0x02) {
    return {
      kind: "ftms-machine-status",
      status: buffer[1] === 0x02 ? "paused" : buffer[1] === 0x01 ? "stopped/session-ended" : "stop-or-pause-unknown",
      subcode: buffer[1]
    };
  }
  if (buffer[0] === 0x05 && buffer.length >= 3) {
    return {
      kind: "ftms-machine-status",
      status: "speed-changed",
      speedKmh: buffer.readUInt16LE(1) / 100
    };
  }
  return { kind: "ftms-machine-status", status: "unknown", raw: toHex(buffer) };
}

function parseVendorFrame(buffer) {
  const command = buffer[0];
  const opcode = buffer[1];
  const length = buffer[2];
  const checksumByte = buffer[buffer.length - 1];
  const checksumValid = buffer.length > 1 ? checksum(buffer.slice(0, -1)) === checksumByte : null;
  const base = {
    kind: "vendor-frame",
    command: hexNumber(command, 2),
    opcode: opcode == null ? null : hexNumber(opcode, 2),
    length,
    checksum: checksumByte == null ? null : hexNumber(checksumByte, 2),
    checksumValid
  };

  if (command === 0x71) return { ...base, ...parseVendor71(buffer) };
  if (command === 0x72) return { ...base, ...parseVendor72(buffer) };
  if (command === 0x73) return { ...base, ...parseVendor73(buffer) };
  if (command === 0x75) return { ...base, ...parseVendor75(buffer) };
  return { ...base, frame: "unknown-vendor-command", raw: toHex(buffer) };
}

function parseVendor71(buffer) {
  const opcode = buffer[1];
  if (opcode === 0x80) return { frame: "handshake-ack" };
  if (opcode === 0x81) return { frame: "handshake-response", payload: toHex(buffer.slice(3, -1)) };
  return { frame: "handshake-request", payload: toHex(buffer.slice(3, -1)) };
}

function parseVendor72(buffer) {
  const opcode = buffer[1];
  if (opcode === 0x00) return { frame: "settings-snapshot-query" };
  if (opcode === 0x80) return parseSettingsSnapshot(buffer);
  if (opcode === 0x81) {
    const key = buffer[3];
    return {
      frame: "settings-write-ack",
      setting: describeSettingKey(key),
      status: buffer[4],
      statusName: buffer[4] === 0x00 ? "ok" : "nonzero"
    };
  }
  if (opcode === 0x01) {
    const key = buffer[3];
    const value = buffer.length >= 7 ? buffer.readUInt16LE(4) : null;
    return {
      frame: "settings-write",
      setting: interpretSettingValue(key, value, "write")
    };
  }
  if (opcode === 0x50) {
    const key = buffer[3];
    const payload = buffer.slice(4, -1);
    const value = payload.length >= 2 ? payload.readUInt16LE(0) : null;
    return {
      frame: "settings-status",
      setting: interpretSettingValue(key, value, "status"),
      payload: toHex(payload)
    };
  }
  return { frame: "settings-unknown", payload: toHex(buffer.slice(3, -1)) };
}

function parseSettingsSnapshot(buffer) {
  const payload = buffer.slice(3, -1);
  const records = [];
  for (let offset = 0; offset + 3 < payload.length; offset += 4) {
    const key = payload[offset];
    const value = payload.readUInt16LE(offset + 2);
    records.push(interpretSettingValue(key, value, "snapshot"));
  }
  return { frame: "settings-snapshot", records };
}

function describeSettingKey(key) {
  return {
    0x01: "units/profile",
    0x02: "no-load stop",
    0x04: "unknown-0X04",
    0x05: "unknown-0X05",
    0x06: "child lock",
    0x07: "max speed candidate",
    0x08: "buzzer/marquee",
    0x09: "unknown-0X09",
    0x0a: "mode/sleep"
  }[key] || `unknown-${hexNumber(key, 2)}`;
}

function interpretSettingValue(key, value, context) {
  const base = {
    key,
    keyHex: hexNumber(key, 2),
    name: describeSettingKey(key),
    value,
    valueHex: value == null ? null : hexNumber(value, 4),
    context
  };
  if (value == null) return base;

  if (key === 0x01) {
    return {
      ...base,
      interpretation: context === "snapshot"
        ? ({ 0x0000: "metric profile", 0x0003: "imperial profile" }[value] || "unknown profile")
        : ({ 0x0001: "set metric", 0x0002: "set imperial" }[value] || "unknown units write")
    };
  }
  if (key === 0x02) {
    return {
      ...base,
      seconds: value & 0xff,
      modeByte: (value >> 8) & 0xff,
      interpretation: value === 0x0000 ? "disable no-load stop request" : `no-load stop ${value & 0xff}s / mode ${hexNumber((value >> 8) & 0xff, 2)}`
    };
  }
  if (key === 0x06) {
    return { ...base, interpretation: value === 0 ? "child lock off" : "child lock on/related status" };
  }
  if (key === 0x07) {
    return { ...base, maxSpeedKmhCandidate: value / 10, interpretation: `candidate max speed ${value / 10} km/h` };
  }
  if (key === 0x08) {
    return {
      ...base,
      bits: {
        baseline: Boolean(value & 0x01),
        buzzer: Boolean(value & 0x02),
        unknown04: Boolean(value & 0x04),
        marquee: Boolean(value & 0x08)
      }
    };
  }
  if (key === 0x0a) {
    const modeByte = value & 0xff;
    return {
      ...base,
      modeByte,
      auxByte: (value >> 8) & 0xff,
      interpretation: ({ 0x00: "manual", 0x20: "automatic", 0x40: "sleep/standby" }[modeByte] || "unknown mode")
    };
  }
  return base;
}

function parseVendor73(buffer) {
  if (buffer.length < 17) return { frame: "session-status", raw: toHex(buffer) };
  const startUnix = buffer.readUInt32LE(4);
  const stableValue = buffer.readUInt32LE(8);
  const endUnix = buffer.readUInt32LE(12);
  return {
    frame: "session-status",
    statusByte: buffer[3],
    startTimestamp: timestamp(startUnix),
    stableValue,
    stableValueHex: hexNumber(stableValue, 8),
    endTimestamp: timestamp(endUnix)
  };
}

function parseVendor75(buffer) {
  if (buffer[1] === 0x00) return { frame: "session-block-query" };
  if (buffer.length >= 16) {
    return {
      frame: "session-block-response",
      fields: [
        buffer.readUInt32LE(3),
        buffer.readUInt32LE(7),
        buffer.readUInt32LE(11)
      ]
    };
  }
  return { frame: "session-block-unknown", raw: toHex(buffer) };
}

function ftmsTargetSpeed(kmh) {
  const raw = Math.round(Number(kmh) * 100);
  if (!Number.isFinite(raw) || raw < 0 || raw > 0xffff) {
    throw new Error("Speed must be a finite km/h value between 0 and 655.35.");
  }
  return Buffer.from([0x02, raw & 0xff, (raw >> 8) & 0xff]);
}

function hexNumber(value, width) {
  return `0X${Number(value).toString(16).toUpperCase().padStart(width, "0")}`;
}

function buildVendorSetting(key, value) {
  return appendChecksum([0x72, 0x01, 0x03, key, value & 0xff, (value >> 8) & 0xff]);
}

function buildCommand(id, args = {}) {
  const vendor = (bytes) => ({ kind: "write", characteristicId: "vendorWrite", data: Buffer.from(bytes), withoutResponse: false });
  const vendorSetting = (key, value) => ({ kind: "write", characteristicId: "vendorWrite", data: buildVendorSetting(key, value), withoutResponse: false });
  const ftmsSequence = (steps) => ({ kind: "ftms-sequence", steps });

  switch (id) {
    case "ftms.requestControl":
      return ftmsSequence([{ label: "Request Control", data: Buffer.from([0x00]) }]);
    case "ftms.start":
      return ftmsSequence([{ label: "Request Control", data: Buffer.from([0x00]) }, { label: "Start / Resume", data: Buffer.from([0x07]) }]);
    case "ftms.pause":
      return ftmsSequence([{ label: "Request Control", data: Buffer.from([0x00]) }, { label: "Pause", data: Buffer.from([0x08, 0x02]) }]);
    case "ftms.stop":
      return ftmsSequence([{ label: "Request Control", data: Buffer.from([0x00]) }, { label: "Stop / End", data: Buffer.from([0x08, 0x01]) }]);
    case "ftms.setSpeed":
      return ftmsSequence([{ label: "Request Control", data: Buffer.from([0x00]) }, { label: `Set Target Speed ${args.kmh} km/h`, data: ftmsTargetSpeed(args.kmh) }]);
    case "vendor.querySettings":
      return vendor([0x72, 0x00, 0x00, 0x00, 0x72]);
    case "vendor.querySession":
      return vendor([0x75, 0x00, 0x00, 0x75]);
    case "vendor.unitsMetric":
      return vendorSetting(0x01, 0x0001);
    case "vendor.unitsImperial":
      return vendorSetting(0x01, 0x0002);
    case "vendor.noLoadOff":
      return vendorSetting(0x02, 0x0000);
    case "vendor.noLoad5":
      return vendorSetting(0x02, 0xe005);
    case "vendor.noLoad15":
      return vendorSetting(0x02, 0xe00f);
    case "vendor.noLoad30":
      return vendorSetting(0x02, 0xe01e);
    case "vendor.noLoad45":
      return vendorSetting(0x02, 0xe02d);
    case "vendor.noLoad60":
      return vendorSetting(0x02, 0xe03c);
    case "vendor.buzzerOn":
      return vendorSetting(0x08, 0x0003);
    case "vendor.buzzerOff":
      return vendorSetting(0x08, 0x0001);
    case "vendor.marqueeOn":
      return vendorSetting(0x08, 0x000c);
    case "vendor.marqueeOff":
      return vendorSetting(0x08, 0x0004);
    case "vendor.childLockOn":
      return vendorSetting(0x06, 0x0003);
    case "vendor.childLockOff":
      return vendorSetting(0x06, 0x0000);
    case "vendor.manual":
      return vendorSetting(0x0a, 0x0000);
    case "vendor.automatic":
      return vendorSetting(0x0a, 0x0020);
    case "vendor.sleep":
      return vendorSetting(0x0a, 0x0040);
    default:
      throw new Error(`Unknown command: ${id}`);
  }
}

module.exports = {
  COMMAND_DEFS,
  FTMS_SERVICE,
  KNOWN_BY_ID,
  KNOWN_BY_UUID,
  KNOWN_CHARACTERISTICS,
  VENDOR_SERVICE,
  appendChecksum,
  buildCommand,
  checksum,
  fromHex,
  normalizeUuid,
  parseCharacteristicValue,
  shortUuid,
  toHex
};
