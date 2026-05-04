"use strict";

const EventEmitter = require("events");
const { createBluetooth } = require("node-ble");
const {
  KNOWN_BY_ID,
  KNOWN_BY_UUID,
  KNOWN_CHARACTERISTICS,
  fromHex,
  normalizeUuid,
  parseCharacteristicValue,
  shortUuid,
  toHex
} = require("./protocol");

const DEFAULT_TARGET_NAME = "KS-AP-RF3";
const DEFAULT_TARGET_ADDRESS = "54:50:A0:10:4E:84";

class WalkingPadBle extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      targetAddress: normalizeAddress(options.targetAddress || process.env.WALKINGPAD_ADDRESS || DEFAULT_TARGET_ADDRESS),
      targetName: options.targetName || process.env.WALKINGPAD_NAME || DEFAULT_TARGET_NAME
    };
    this.adapterState = "not-initialized";
    this.status = "idle";
    this.connection = {
      peripheralId: null,
      address: null,
      name: null,
      rssi: null
    };
    this.values = new Map();
    this.logs = [];
    this.bluetoothSession = null;
    this.adapter = null;
    this.device = null;
    this.gatt = null;
    this.characteristics = new Map();
    this.pendingFtms = [];
    this.ftmsChain = Promise.resolve();

    for (const known of KNOWN_CHARACTERISTICS) {
      this.values.set(known.id, emptyValueRecord(known));
    }
  }

  getSnapshot() {
    return {
      adapter: { state: this.adapterState },
      target: {
        address: this.options.targetAddress,
        name: this.options.targetName
      },
      connection: {
        status: this.status,
        ...this.connection
      },
      values: Array.from(this.values.values()).sort((a, b) => `${a.service}:${a.id}`.localeCompare(`${b.service}:${b.id}`)),
      logs: this.logs
    };
  }

  setTarget({ address, name }) {
    if (address) this.options.targetAddress = normalizeAddress(address);
    if (name) this.options.targetName = name;
    this.log("target", `target address=${this.options.targetAddress || "(any)"} name=${this.options.targetName || "(any)"}`);
    this.emitUpdate();
  }

  async connect({ address, name } = {}) {
    this.setTarget({ address, name });
    await this.close();
    await this.ensureAdapter();

    this.status = "scanning";
    this.emitUpdate();
    this.log("scan", `scanning address=${this.options.targetAddress || "(any)"} name=${this.options.targetName || "(any)"}`);

    if (!(await this.adapter.isDiscovering())) await this.adapter.startDiscovery();
    const device = await this.findDevice();

    this.status = "connecting";
    this.device = device;
    this.emitUpdate();
    this.log("connect", `connecting to ${await safeCall(() => device.getAddress(), this.options.targetAddress)}`);

    await device.connect();
    this.gatt = await device.gatt();

    this.connection = {
      peripheralId: await safeCall(() => device.getAddress(), this.options.targetAddress),
      address: normalizeAddress(await safeCall(() => device.getAddress(), this.options.targetAddress)),
      name: await safeCall(() => device.getName(), this.options.targetName),
      rssi: null
    };
    this.status = "connected";
    this.log("connect", `connected address=${this.connection.address} name=${this.connection.name || "(none)"}`);
    this.emitUpdate();

    await this.discoverKnownCharacteristics();
    await this.subscribeKnown();
    await this.readAllKnown();
  }

  async disconnect() {
    await this.close();
  }

  async close() {
    this.rejectPendingFtms(new Error("Disconnected before FTMS response."));

    for (const { characteristic, listener } of this.characteristics.values()) {
      if (listener && typeof characteristic.off === "function") {
        characteristic.off("valuechanged", listener);
      }
      if (listener && typeof characteristic.removeListener === "function") {
        characteristic.removeListener("valuechanged", listener);
      }
      if (listener && typeof characteristic.stopNotifications === "function") {
        await characteristic.stopNotifications().catch(() => {});
      }
    }

    if (this.device) {
      await this.device.disconnect().catch(() => {});
    }
    if (this.adapter && await this.adapter.isDiscovering().catch(() => false)) {
      await this.adapter.stopDiscovery().catch(() => {});
    }
    if (this.bluetoothSession) {
      this.bluetoothSession.destroy();
    }

    this.bluetoothSession = null;
    this.adapter = null;
    this.device = null;
    this.gatt = null;
    this.characteristics.clear();
    this.markDisconnected("disconnected");
  }

  async readAllKnown() {
    let count = 0;
    for (const [id, entry] of this.characteristics.entries()) {
      const known = KNOWN_BY_ID.get(id);
      if (!known || !entry.properties.includes("read")) continue;
      await this.readCharacteristic(id);
      count += 1;
    }
    this.log("read", `read ${count} known characteristics`);
  }

  async readCharacteristic(id) {
    const entry = this.getCharacteristicEntry(id);
    const data = Buffer.from(await entry.characteristic.readValue());
    this.log("read", `${entry.id} -> ${toHex(data)}`);
    this.recordValue(entry.id, data, "read");
    return data;
  }

  async writeCharacteristic(id, data, options = {}) {
    const entry = this.getCharacteristicEntry(id);
    const withoutResponse = Boolean(options.withoutResponse);
    this.log("write", `${options.label || entry.id} -> ${entry.id} ${toHex(data)}${withoutResponse ? " without-response" : ""}`);
    this.recordValue(entry.id, data, "write");
    if (withoutResponse && typeof entry.characteristic.writeValueWithoutResponse === "function") {
      await entry.characteristic.writeValueWithoutResponse(Buffer.from(data));
    } else if (!withoutResponse && typeof entry.characteristic.writeValueWithResponse === "function") {
      await entry.characteristic.writeValueWithResponse(Buffer.from(data));
    } else {
      await entry.characteristic.writeValue(Buffer.from(data), withoutResponse ? { type: "command" } : {});
    }
  }

  async writeFtmsSequence(steps) {
    const run = this.ftmsChain.catch(() => {}).then(() => this.performFtmsSequence(steps));
    this.ftmsChain = run.catch(() => {});
    return run;
  }

  async performFtmsSequence(steps) {
    for (const step of steps) {
      const opcode = step.data[0];
      const responsePromise = this.waitForFtmsResponse(opcode, 4000);
      try {
        await this.writeCharacteristic("2ad9", step.data, { label: step.label });
      } catch (error) {
        this.cancelFtmsResponseWait(opcode, error);
        throw error;
      }
      await responsePromise;
    }
  }

  waitForFtmsResponse(opcode, timeoutMs) {
    return new Promise((resolve, reject) => {
      const pending = {
        opcode,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pendingFtms = this.pendingFtms.filter((item) => item !== pending);
          reject(new Error(`Timed out waiting for FTMS response to opcode 0X${opcode.toString(16).toUpperCase().padStart(2, "0")}.`));
        }, timeoutMs)
      };
      this.pendingFtms.push(pending);
    });
  }

  resolveFtmsResponse(buffer) {
    if (buffer[0] !== 0x80 || buffer.length < 3) return;
    const opcode = buffer[1];
    const index = this.pendingFtms.findIndex((item) => item.opcode === opcode);
    if (index < 0) return;
    const [pending] = this.pendingFtms.splice(index, 1);
    clearTimeout(pending.timer);
    pending.resolve(buffer);
  }

  cancelFtmsResponseWait(opcode, error) {
    const index = this.pendingFtms.findIndex((item) => item.opcode === opcode);
    if (index < 0) return;
    const [pending] = this.pendingFtms.splice(index, 1);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  rejectPendingFtms(error) {
    for (const pending of this.pendingFtms) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingFtms = [];
  }

  async ensureAdapter() {
    this.bluetoothSession = createBluetooth();
    this.adapter = await this.bluetoothSession.bluetooth.defaultAdapter();
    this.adapterState = "bluez-ready";
    this.log("adapter", "BlueZ adapter ready");
    this.emitUpdate();
  }

  async findDevice() {
    const address = this.options.targetAddress;
    if (address) {
      return this.adapter.waitDevice(address);
    }

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const devices = await this.adapter.devices();
      for (const devicePath of devices) {
        const device = await this.adapter.getDevice(devicePath);
        const deviceName = await safeCall(() => device.getName(), "");
        if (this.options.targetName && deviceName === this.options.targetName) return device;
      }
      await sleep(500);
    }
    throw new Error("WalkingPad not found during scan.");
  }

  async discoverKnownCharacteristics() {
    if (!this.gatt) throw new Error("Not connected.");
    this.characteristics.clear();

    for (const known of KNOWN_CHARACTERISTICS) {
      try {
        const service = await this.gatt.getPrimaryService(formatUuidForNodeBle(known.service));
        const characteristic = await service.getCharacteristic(formatUuidForNodeBle(known.uuid));
        const properties = await characteristic.getFlags().catch(() => flagsFromKnown(known));
        const entry = {
          id: known.id,
          uuid: known.uuid,
          service: known.service,
          name: known.name,
          role: known.role,
          characteristic,
          properties,
          listener: null
        };
        this.characteristics.set(known.id, entry);
        this.characteristics.set(known.uuid, entry);
        this.values.set(known.id, {
          ...this.values.get(known.id),
          properties,
          present: true
        });
        this.log("gatt", `${known.id} ${known.name} props=${properties.join(",")}`);
      } catch (error) {
        this.log("gatt", `${known.id} missing (${error.message})`);
      }
    }
    this.emitUpdate();
  }

  async subscribeKnown() {
    for (const entry of uniqueEntries(this.characteristics.values())) {
      if (!entry.properties.includes("notify") && !entry.properties.includes("indicate")) continue;
      const listener = (buffer) => {
        const data = Buffer.from(buffer);
        this.log("notify", `${entry.id} <- ${toHex(data)}`);
        this.recordValue(entry.id, data, "notify");
        if (entry.id === "2ad9") this.resolveFtmsResponse(data);
      };
      entry.characteristic.on("valuechanged", listener);
      await entry.characteristic.startNotifications();
      entry.listener = listener;
      const existing = this.values.get(entry.id);
      this.values.set(entry.id, { ...existing, notifying: true });
      this.log("subscribe", `${entry.id} ${entry.name}`);
    }
    this.emitUpdate();
  }

  getCharacteristicEntry(id) {
    const normalized = normalizeUuid(id);
    const entry = this.characteristics.get(id) || this.characteristics.get(normalized) || this.characteristics.get(shortUuid(normalized));
    if (!entry) throw new Error(`Characteristic ${id} is not available.`);
    return entry;
  }

  recordValue(id, data, source) {
    const known = KNOWN_BY_ID.get(id) || KNOWN_BY_UUID.get(normalizeUuid(id));
    const recordId = known ? known.id : shortUuid(id);
    const existing = this.values.get(recordId) || emptyValueRecord({
      id: recordId,
      uuid: known ? known.uuid : normalizeUuid(id),
      service: known ? known.service : "",
      name: known ? known.name : recordId,
      role: known ? known.role : "unknown"
    });
    this.values.set(recordId, {
      ...existing,
      rawHex: toHex(data),
      parsed: parseCharacteristicValue(recordId, data),
      lastUpdatedAt: new Date().toISOString(),
      lastSource: source
    });
    this.emitUpdate();
  }

  markDisconnected(reason) {
    this.log("disconnect", reason);
    this.status = "idle";
    this.connection = {
      peripheralId: null,
      address: null,
      name: null,
      rssi: null
    };
    for (const [id, record] of this.values.entries()) {
      this.values.set(id, { ...record, present: false, notifying: false });
    }
    this.emitUpdate();
  }

  log(kind, message) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).toUpperCase().slice(2)}`,
      at: new Date().toISOString(),
      kind,
      message
    };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    console.log(`${entry.at} ${kind} ${message}`);
    this.emit("log", entry);
    this.emitUpdate();
  }

  emitUpdate() {
    this.emit("update", this.getSnapshot());
  }
}

function emptyValueRecord(known) {
  return {
    id: known.id,
    uuid: known.uuid,
    service: known.service,
    name: known.name,
    role: known.role,
    properties: [],
    present: false,
    notifying: false,
    rawHex: "",
    parsed: null,
    lastUpdatedAt: null,
    lastSource: null
  };
}

function flagsFromKnown(known) {
  const flags = [];
  if (known.readable) flags.push("read");
  if (known.writable) flags.push("write");
  if (known.notifiable) flags.push("notify");
  return flags;
}

function formatUuidForNodeBle(uuid) {
  const normalized = normalizeUuid(uuid);
  if (normalized.length !== 32) return normalized;
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`;
}

function normalizeAddress(address) {
  return String(address || "").trim().toUpperCase();
}

function uniqueEntries(entries) {
  const seen = new Set();
  const unique = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    unique.push(entry);
  }
  return unique;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeCall(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

module.exports = {
  DEFAULT_TARGET_ADDRESS,
  DEFAULT_TARGET_NAME,
  WalkingPadBle
};
