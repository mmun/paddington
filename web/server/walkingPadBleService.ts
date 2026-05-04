import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { withBindings } from '@stoprocent/noble'
import type { Characteristic, Peripheral } from '@stoprocent/noble'
import {
  COMMAND_GAP_MS,
  FTMS_CONTROL_POINT_UUID,
  FTMS_SERVICE_UUID,
  FTMS_STATUS_UUID,
  FTMS_TREADMILL_DATA_UUID,
  FtmsControlOpcode,
  KINGSMITH_VENDOR_NOTIFY_UUID,
  KINGSMITH_VENDOR_SERVICE_UUID,
  KINGSMITH_VENDOR_WRITE_UUID,
  WalkingPadMode,
  WALKINGPAD_NOTIFY_UUID,
  WALKINGPAD_SERVICE_UUID,
  WALKINGPAD_WRITE_UUID,
  DEFAULT_WALKINGPAD_ADDRESS,
  DEFAULT_WALKINGPAD_NAME,
  DEFAULT_REMOTE_WAKE_ADDRESS,
  DEFAULT_REMOTE_WAKE_NAME,
  VendorSettingKey,
  createAskStatsCommand,
  createChangeSpeedCommand,
  createFtmsPauseCommand,
  createFtmsRequestControlCommand,
  createFtmsSetTargetSpeedCommand,
  createFtmsStopCommand,
  createFtmsStartOrResumeCommand,
  createStartBeltCommand,
  createStopBeltCommand,
  createSwitchModeCommand,
  createVendorQuerySessionCommand,
  createVendorQuerySettingsCommand,
  createVendorSettingCommand,
  ftmsResultCodeToMessage,
  normalizeLegacyCurrentStatus,
  parseFtmsControlResponse,
  parseFtmsMachineStatus,
  parseFtmsTreadmillData,
  parseVendorSessionStatus,
  parseWalkingPadMessage,
  type WalkingPadProtocolType,
} from '../src/lib/walkingPadProtocol'
import type {
  WalkingPadCommandRequest,
  WalkingPadDeviceSummary,
  WalkingPadServerEvent,
  WalkingPadServerState,
  WalkingPadVendorSettingCommand,
} from '../src/lib/walkingPadApi'

type WalkingPadEventListener = (event: WalkingPadServerEvent) => void

const LAST_DEVICE_PATH = path.resolve(process.cwd(), 'tmp', 'walkingpad-last-device.json')
const TARGET_ADDRESS = normalizeAddress(process.env.WALKINGPAD_ADDRESS || DEFAULT_WALKINGPAD_ADDRESS)
const TARGET_NAME = process.env.WALKINGPAD_NAME || DEFAULT_WALKINGPAD_NAME
const REMOTE_WAKE_ADDRESS = normalizeAddress(process.env.WALKINGPAD_WAKE_ADDRESS || DEFAULT_REMOTE_WAKE_ADDRESS)
const BLE_CLEANUP_TIMEOUT_MS = 2500
const execFileAsync = promisify(execFile)

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  })
}

function normalizeUuid(uuid: string) {
  return uuid.toLowerCase().replace(/-/g, '')
}

function uuidMatches(candidate: string | undefined, target: string) {
  if (!candidate) {
    return false
  }

  const normalizedCandidate = normalizeUuid(candidate)
  const normalizedTarget = normalizeUuid(target)

  if (normalizedCandidate === normalizedTarget) {
    return true
  }

  if (
    normalizedTarget.length === 32 &&
    normalizedTarget.startsWith('0000') &&
    normalizedTarget.endsWith('00001000800000805f9b34fb')
  ) {
    return normalizedCandidate === normalizedTarget.slice(4, 8)
  }

  return false
}

function characteristicWriteWithoutResponse(characteristic: Characteristic) {
  return characteristic.properties.includes('writeWithoutResponse') &&
    !characteristic.properties.includes('write')
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

function settled<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  )
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')
}

function ftmsOpcodeLabel(opcode: number) {
  switch (opcode) {
    case FtmsControlOpcode.RequestControl:
      return 'Request control'
    case FtmsControlOpcode.Reset:
      return 'Reset'
    case FtmsControlOpcode.SetTargetSpeed:
      return 'Set target speed'
    case FtmsControlOpcode.StartOrResume:
      return 'Start/resume'
    case FtmsControlOpcode.StopOrPause:
      return 'Stop/pause'
    default:
      return `Opcode 0x${opcode.toString(16).padStart(2, '0')}`
  }
}

function ftmsCommandLabel(command: Uint8Array, opcode: number) {
  if (opcode === FtmsControlOpcode.SetTargetSpeed && command.length >= 3) {
    const speedKmh = (((command[2] ?? 0) << 8) | (command[1] ?? 0)) / 100
    return `Set target speed ${speedKmh.toFixed(2)} km/h`
  }

  if (opcode === FtmsControlOpcode.StopOrPause) {
    const stopPauseCode = command[1]
    if (stopPauseCode === 0x01) {
      return 'Stop'
    }
    if (stopPauseCode === 0x02) {
      return 'Pause'
    }
  }

  return ftmsOpcodeLabel(opcode)
}

function isLikelyWalkingPad(peripheral: Peripheral) {
  const name = peripheral.advertisement.localName ?? ''
  const serviceUuids = peripheral.advertisement.serviceUuids ?? []
  const address = normalizeAddress(peripheral.address)

  if (address === REMOTE_WAKE_ADDRESS || name === DEFAULT_REMOTE_WAKE_NAME) {
    return false
  }

  return (
    address === TARGET_ADDRESS ||
    name === TARGET_NAME ||
    name.startsWith('WalkingPad') ||
    name.startsWith('KS-AP') ||
    serviceUuids.some((uuid) => uuidMatches(uuid, WALKINGPAD_SERVICE_UUID)) ||
    serviceUuids.some((uuid) => uuidMatches(uuid, FTMS_SERVICE_UUID))
  )
}

export class WalkingPadBleService {
  private readonly noble = withBindings('default')
  private readonly listeners = new Set<WalkingPadEventListener>()
  private readonly peripherals = new Map<string, Peripheral>()
  private connectionState: WalkingPadServerState['connectionState'] = 'disconnected'
  private protocol: WalkingPadProtocolType | null = null
  private deviceName = 'WalkingPad'
  private devices: WalkingPadDeviceSummary[] = []
  private scanning = false
  private connectedPeripheral: Peripheral | null = null
  private notifyCharacteristic: Characteristic | null = null
  private writeCharacteristic: Characteristic | null = null
  private ftmsStatusCharacteristic: Characteristic | null = null
  private vendorNotifyCharacteristic: Characteristic | null = null
  private vendorWriteCharacteristic: Characteristic | null = null
  private explicitDisconnect = false
  private lastCommandAt = 0
  private commandQueue: Promise<void> = Promise.resolve()
  private ftmsIndicationsUnavailable = false
  private scanPromise: Promise<WalkingPadDeviceSummary[]> | null = null
  private lastStaleDisconnectAt = 0
  private connectedAt = 0
  private lastNotificationAt = 0
  private pendingFtmsIndication:
    | {
        resolve: (value: Uint8Array) => void
        reject: (error: Error) => void
      }
    | null = null

  subscribe(listener: WalkingPadEventListener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState(): WalkingPadServerState {
    return {
      connectionState: this.connectionState,
      deviceName: this.deviceName,
      protocol: this.protocol,
      scanning: this.scanning,
      devices: this.devices,
      targetAddress: TARGET_ADDRESS,
      targetName: TARGET_NAME,
      wakeAddress: REMOTE_WAKE_ADDRESS,
      live: null,
    }
  }

  async scanDevices(timeoutMs = 6000) {
    if (this.scanPromise) {
      return this.scanPromise
    }

    this.scanPromise = this.performScan(timeoutMs)

    try {
      return await this.scanPromise
    } finally {
      this.scanPromise = null
    }
  }

  async connect(deviceId?: string, scanTimeoutMs = 6000) {
    if (this.connectedPeripheral?.state === 'connected') {
      if (this.connectionState !== 'connected' || !this.writeCharacteristic) {
        await this.connectPeripheral(this.connectedPeripheral)
        await this.rememberDevice(this.connectedPeripheral)
      }
      return this.getState()
    }

    this.connectionState = 'connecting'
    await this.releaseStaleBluezConnection()
    const scannedDevices = await this.scanDevices(scanTimeoutMs)
    const peripheral = await this.selectPeripheral(deviceId, scannedDevices)

    if (!peripheral) {
      this.connectionState = 'disconnected'
      throw new Error('No compatible WalkingPad device was found during the scan.')
    }

    try {
      await this.connectPeripheral(peripheral)
      await this.rememberDevice(peripheral)
      return this.getState()
    } catch (error) {
      this.connectionState = 'disconnected'
      await this.safeDisconnect()
      throw error
    }
  }

  async disconnect() {
    this.explicitDisconnect = true
    await this.safeDisconnect()
    await this.releaseStaleBluezConnection(true)
    this.emit({ type: 'disconnected' })
    return this.getState()
  }

  isStaleConnectedLink(maxQuietMs: number) {
    if (this.connectionState !== 'connected') {
      return false
    }

    if (this.connectedPeripheral?.state !== 'connected') {
      return true
    }

    const lastActivityAt = Math.max(this.lastNotificationAt, this.connectedAt)
    return lastActivityAt > 0 && performance.now() - lastActivityAt > maxQuietMs
  }

  async recoverStaleConnectedLink() {
    const quietSeconds = Math.round((performance.now() - Math.max(this.lastNotificationAt, this.connectedAt)) / 1000)
    this.reportMachineStatus(0, `BLE link went quiet for ${quietSeconds}s; resetting connection and returning to scan.`)
    await this.safeDisconnect()
    await this.releaseStaleBluezConnection(true)
    this.emit({ type: 'disconnected' })
    return this.getState()
  }

  async runCommand(command: WalkingPadCommandRequest) {
    switch (command.type) {
      case 'start':
        await this.startBelt()
        break
      case 'request-control':
        await this.requestFtmsControl()
        break
      case 'pause':
        await this.stopBelt()
        break
      case 'stop':
        await this.endSession()
        break
      case 'wake':
        this.emit({
          type: 'machine-status',
          code: 0,
          message: 'Wake is handled by the HTTP server before BLE reconnect.',
        })
        break
      case 'ask-stats':
        await this.askStats()
        break
      case 'resume':
        await this.resumeAt(command.speedTenthsKmh)
        break
      case 'switch-mode':
        await this.switchMode(command.mode)
        break
      case 'set-speed':
        await this.changeSpeed(command.speedTenthsKmh)
        break
      case 'query-settings':
        await this.queryVendorSettings()
        break
      case 'query-session':
        await this.queryVendorSession()
        break
      case 'vendor-setting':
        await this.applyVendorSetting(command.command)
        break
    }

    return this.getState()
  }

  private emit(event: WalkingPadServerEvent) {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  private reportMachineStatus(code: number, message: string) {
    console.log(message)
    this.emit({ type: 'machine-status', code, message })
  }

  private async cleanup(label: string, action: () => Promise<unknown>) {
    try {
      await withTimeout(action(), BLE_CLEANUP_TIMEOUT_MS, label)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`${label} cleanup did not complete: ${message}`)
    }
  }

  private enqueueCommand(run: () => Promise<void>) {
    const queued = this.commandQueue.catch(() => undefined).then(run)
    this.commandQueue = queued.catch(() => undefined)
    return queued
  }

  private async waitForPoweredOn() {
    await this.noble.waitForPoweredOnAsync()
  }

  private async releaseStaleBluezConnection(force = false) {
    if (process.platform !== 'linux') {
      return
    }

    const now = performance.now()
    if (!force && now - this.lastStaleDisconnectAt < 10_000) {
      return
    }
    this.lastStaleDisconnectAt = now

    await execFileAsync('bluetoothctl', ['disconnect', TARGET_ADDRESS], { timeout: 5000 }).catch(() => undefined)
  }

  private async performScan(timeoutMs: number) {
    await this.waitForPoweredOn()

    this.scanning = true
    this.emit({ type: 'scanning', active: true })
    const discovered = new Map<string, Peripheral>()

    const handleDiscover = (peripheral: Peripheral) => {
      discovered.set(peripheral.id, peripheral)
      this.peripherals.set(peripheral.id, peripheral)
    }

    this.noble.on('discover', handleDiscover)

    try {
      await this.noble.startScanningAsync([], false)
      await delay(timeoutMs)
    } finally {
      await this.noble.stopScanningAsync().catch(() => undefined)
      this.noble.off('discover', handleDiscover)
      this.scanning = false
      this.emit({ type: 'scanning', active: false })
    }

    this.devices = [...discovered.values()]
      .filter(isLikelyWalkingPad)
      .sort((left, right) => (right.rssi ?? Number.NEGATIVE_INFINITY) - (left.rssi ?? Number.NEGATIVE_INFINITY))
      .map((peripheral) => this.summarizePeripheral(peripheral))

    this.emit({ type: 'devices', devices: this.devices })
    return this.devices
  }

  private async selectPeripheral(deviceId: string | undefined, devices: WalkingPadDeviceSummary[]) {
    if (deviceId) {
      return this.peripherals.get(deviceId) ?? null
    }

    const targetDevice = devices.find((device) => normalizeAddress(device.address) === TARGET_ADDRESS)
    if (targetDevice) {
      return this.peripherals.get(targetDevice.id) ?? null
    }

    const rememberedDeviceId = await this.readRememberedDeviceId()
    if (rememberedDeviceId) {
      const rememberedPeripheral = this.peripherals.get(rememberedDeviceId)
      if (rememberedPeripheral) {
        return rememberedPeripheral
      }
    }

    const [firstDevice] = devices
    if (!firstDevice) {
      return null
    }

    if (devices.length > 1) {
      this.emit({
        type: 'machine-status',
        code: 0,
        message: `Multiple WalkingPad candidates found. Selecting ${firstDevice.name} (${firstDevice.id}) by strongest signal.`,
      })
    }

    return this.peripherals.get(firstDevice.id) ?? null
  }

  private async connectPeripheral(peripheral: Peripheral) {
    this.explicitDisconnect = false
    this.connectedPeripheral = peripheral

    peripheral.removeAllListeners('disconnect')
    peripheral.on('disconnect', this.handleDisconnect)

    if (peripheral.state !== 'connected') {
      try {
        await peripheral.connectAsync()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        if (!message.toLowerCase().includes('already connected')) {
          throw error
        }
      }
    }

    const { services, characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync()
    const legacyService = services.find((service) => uuidMatches(service.uuid, WALKINGPAD_SERVICE_UUID))
    const vendorService = services.find((service) => uuidMatches(service.uuid, KINGSMITH_VENDOR_SERVICE_UUID))
    const vendorNotifyCharacteristic =
      characteristics.find((characteristic) => uuidMatches(characteristic.uuid, KINGSMITH_VENDOR_NOTIFY_UUID)) ?? null
    const vendorWriteCharacteristic =
      characteristics.find((characteristic) => uuidMatches(characteristic.uuid, KINGSMITH_VENDOR_WRITE_UUID)) ?? null

    if (legacyService) {
      const notifyCharacteristic = characteristics.find((characteristic) =>
        uuidMatches(characteristic.uuid, WALKINGPAD_NOTIFY_UUID),
      )
      const writeCharacteristic = characteristics.find((characteristic) =>
        uuidMatches(characteristic.uuid, WALKINGPAD_WRITE_UUID),
      )

      if (!notifyCharacteristic || !writeCharacteristic) {
        throw new Error('WalkingPad FE00 service is missing FE01/FE02 characteristics.')
      }

      this.protocol = 'legacy'
      this.connectionState = 'connected'
      this.markConnected()
      this.deviceName = peripheral.advertisement.localName ?? peripheral.id
      this.notifyCharacteristic = notifyCharacteristic
      this.writeCharacteristic = writeCharacteristic
      this.vendorNotifyCharacteristic = vendorNotifyCharacteristic
      this.vendorWriteCharacteristic = vendorWriteCharacteristic
      this.notifyCharacteristic.on('data', this.handleLegacyNotification)
      await this.notifyCharacteristic.subscribeAsync()
      await this.subscribeVendorNotifications()

      this.emit({ type: 'connected', deviceName: this.deviceName, protocol: 'legacy' })
      await this.switchMode(WalkingPadMode.Manual)
      await this.askStats()
      return
    }

    const ftmsService = services.find((service) => uuidMatches(service.uuid, FTMS_SERVICE_UUID))

    if (ftmsService) {
      const notifyCharacteristic = characteristics.find((characteristic) =>
        uuidMatches(characteristic.uuid, FTMS_TREADMILL_DATA_UUID),
      )
      const writeCharacteristic = characteristics.find((characteristic) =>
        uuidMatches(characteristic.uuid, FTMS_CONTROL_POINT_UUID),
      )
      const statusCharacteristic =
        characteristics.find((characteristic) => uuidMatches(characteristic.uuid, FTMS_STATUS_UUID)) ?? null

      if (!notifyCharacteristic || !writeCharacteristic) {
        throw new Error('FTMS service is missing the treadmill data or control point characteristic.')
      }

      this.protocol = 'ftms'
      this.connectionState = 'connected'
      this.markConnected()
      this.deviceName = peripheral.advertisement.localName ?? peripheral.id
      this.notifyCharacteristic = notifyCharacteristic
      this.writeCharacteristic = writeCharacteristic
      this.ftmsStatusCharacteristic = statusCharacteristic
      this.vendorNotifyCharacteristic = vendorService ? vendorNotifyCharacteristic : null
      this.vendorWriteCharacteristic = vendorService ? vendorWriteCharacteristic : null

      this.notifyCharacteristic.on('data', this.handleFtmsNotification)
      await this.notifyCharacteristic.subscribeAsync()

      this.writeCharacteristic.on('data', this.handleFtmsControlNotification)
      await this.writeCharacteristic.subscribeAsync()

      if (this.ftmsStatusCharacteristic) {
        this.ftmsStatusCharacteristic.on('data', this.handleFtmsStatusNotification)
        await this.ftmsStatusCharacteristic.subscribeAsync()
      }
      await this.subscribeVendorNotifications()

      this.emit({ type: 'connected', deviceName: this.deviceName, protocol: 'ftms' })
      return
    }

    throw new Error('The selected device does not expose a supported WalkingPad BLE service.')
  }

  private summarizePeripheral(peripheral: Peripheral): WalkingPadDeviceSummary {
    return {
      id: peripheral.id,
      name: peripheral.advertisement.localName ?? peripheral.id,
      address: peripheral.address && peripheral.address !== 'unknown' ? peripheral.address : null,
      rssi: typeof peripheral.rssi === 'number' ? peripheral.rssi : null,
      advertisedServices: (peripheral.advertisement.serviceUuids ?? []).map((uuid) => uuid.toLowerCase()),
    }
  }

  private async switchMode(mode: number) {
    this.assertConnected()

    if (this.protocol === 'legacy') {
      await this.sendLegacy(createSwitchModeCommand(mode as 0 | 1 | 2))
    }
  }

  private async changeSpeed(speedTenthsKmh: number) {
    this.assertConnected()

    if (this.protocol === 'legacy') {
      await this.sendLegacy(createChangeSpeedCommand(speedTenthsKmh))
      return
    }

    await this.sendFtms(createFtmsSetTargetSpeedCommand(speedTenthsKmh), FtmsControlOpcode.SetTargetSpeed)
  }

  private async requestFtmsControl() {
    this.assertConnected()

    if (this.protocol === 'legacy') {
      this.reportMachineStatus(0, 'Legacy WalkingPad protocol does not use FTMS request control.')
      return
    }

    await this.sendFtms(createFtmsRequestControlCommand(), FtmsControlOpcode.RequestControl)
  }

  private async stopBelt() {
    this.assertConnected()

    if (this.protocol === 'legacy') {
      await this.sendLegacy(createStopBeltCommand())
      return
    }

    await this.sendFtms(createFtmsPauseCommand(), FtmsControlOpcode.StopOrPause)
  }

  private async endSession() {
    this.assertConnected()

    if (this.protocol === 'legacy') {
      await this.sendLegacy(createStopBeltCommand())
      return
    }

    await this.sendFtms(createFtmsStopCommand(), FtmsControlOpcode.StopOrPause)
  }

  private async startBelt() {
    this.assertConnected()

    if (this.protocol === 'legacy') {
      await this.sendLegacy(createStartBeltCommand())
      return
    }

    await this.sendFtms(createFtmsStartOrResumeCommand(), FtmsControlOpcode.StartOrResume)
  }

  private async askStats() {
    this.assertConnected()

    if (this.protocol === 'legacy') {
      await this.sendLegacy(createAskStatsCommand())
    }
  }

  private async resumeAt(speedTenthsKmh: number) {
    this.assertConnected()

    if (this.protocol === 'legacy') {
      await this.switchMode(WalkingPadMode.Standby)
      await delay(500)
      await this.switchMode(WalkingPadMode.Manual)
      await delay(500)
      await this.startBelt()
      await delay(500)
      await this.changeSpeed(speedTenthsKmh)
      return
    }

    await this.startBelt()
    await delay(300)
    await this.changeSpeed(speedTenthsKmh)
  }

  private async queryVendorSettings() {
    await this.sendVendor(createVendorQuerySettingsCommand(), 'Query settings')
  }

  private async queryVendorSession() {
    await this.sendVendor(createVendorQuerySessionCommand(), 'Query session')
  }

  private async applyVendorSetting(command: WalkingPadVendorSettingCommand) {
    const nextCommand = (() => {
      if (command.setting === 'units') {
        return createVendorSettingCommand(
          VendorSettingKey.Units,
          command.value === 'metric' ? 0x0001 : 0x0002,
        )
      }

      if (command.setting === 'no-load-stop') {
        const valueBySeconds = {
          0: 0x0000,
          5: 0xe005,
          15: 0xe00f,
          30: 0xe01e,
          45: 0xe02d,
          60: 0xe03c,
        } as const
        return createVendorSettingCommand(VendorSettingKey.NoLoadStop, valueBySeconds[command.seconds])
      }

      if (command.setting === 'buzzer') {
        return createVendorSettingCommand(VendorSettingKey.BuzzerMarquee, command.enabled ? 0x0003 : 0x0001)
      }

      if (command.setting === 'marquee') {
        return createVendorSettingCommand(VendorSettingKey.BuzzerMarquee, command.enabled ? 0x000c : 0x0004)
      }

      if (command.setting === 'child-lock') {
        return createVendorSettingCommand(VendorSettingKey.ChildLock, command.enabled ? 0x0003 : 0x0000)
      }

      const modeValues = {
        manual: 0x0000,
        automatic: 0x0020,
        sleep: 0x0040,
      } as const
      return createVendorSettingCommand(VendorSettingKey.Mode, modeValues[command.mode])
    })()

    await this.sendVendor(nextCommand, `Set ${command.setting}`)
  }

  private assertConnected() {
    if (!this.connectedPeripheral || this.connectionState !== 'connected' || !this.writeCharacteristic) {
      throw new Error('WalkingPad is not connected.')
    }
  }

  private async sendLegacy(command: Uint8Array) {
    await this.enqueueCommand(async () => {
      if (!this.writeCharacteristic) {
        throw new Error('WalkingPad write characteristic is unavailable.')
      }

      const waitTime = Math.max(0, COMMAND_GAP_MS - (performance.now() - this.lastCommandAt))
      if (waitTime > 0) {
        await delay(waitTime)
      }

      await this.writeCharacteristic.writeAsync(
        Buffer.from(command),
        characteristicWriteWithoutResponse(this.writeCharacteristic),
      )
      this.lastCommandAt = performance.now()
    })
  }

  private async sendVendor(command: Uint8Array, label: string) {
    await this.enqueueCommand(async () => {
      if (!this.vendorWriteCharacteristic) {
        throw new Error('WalkingPad vendor settings characteristic is unavailable.')
      }

      const waitTime = Math.max(0, COMMAND_GAP_MS - (performance.now() - this.lastCommandAt))
      if (waitTime > 0) {
        await delay(waitTime)
      }

      await this.vendorWriteCharacteristic.writeAsync(
        Buffer.from(command),
        characteristicWriteWithoutResponse(this.vendorWriteCharacteristic),
      )
      this.lastCommandAt = performance.now()
      this.reportMachineStatus(0, `${label} command sent (${bytesToHex(command)}).`)
    })
  }

  private async sendFtms(command: Uint8Array, opcode: number) {
    await this.enqueueCommand(async () => {
      if (!this.writeCharacteristic) {
        throw new Error('FTMS control point is unavailable.')
      }

      if (opcode !== FtmsControlOpcode.RequestControl) {
        await this.sendFtmsCommandOnce(createFtmsRequestControlCommand(), FtmsControlOpcode.RequestControl)
      }

      await this.sendFtmsCommandOnce(command, opcode)
    })
  }

  private async sendFtmsCommandOnce(command: Uint8Array, opcode: number) {
    if (!this.writeCharacteristic) {
      throw new Error('FTMS control point is unavailable.')
    }

    const commandLabel = ftmsCommandLabel(command, opcode)
    const commandHex = bytesToHex(command)
    const waitTime = Math.max(0, COMMAND_GAP_MS - (performance.now() - this.lastCommandAt))
    if (waitTime > 0) {
      await delay(waitTime)
    }

    if (this.ftmsIndicationsUnavailable) {
      await this.writeCharacteristic.writeAsync(Buffer.from(command), false)

      this.lastCommandAt = performance.now()
      this.reportMachineStatus(opcode, `FTMS ${commandLabel} sent write-only (${commandHex}).`)
      return
    }

    const indication = settled(new Promise<Uint8Array>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (!this.pendingFtmsIndication) {
          return
        }

        this.pendingFtmsIndication = null
        reject(new Error('Timed out waiting for FTMS control response.'))
      }, 3000)

      this.pendingFtmsIndication = {
        resolve: (value) => {
          clearTimeout(timeoutId)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timeoutId)
          reject(error)
        },
      }
    }))

    try {
      await this.writeCharacteristic.writeAsync(Buffer.from(command), false)
      this.lastCommandAt = performance.now()
      this.reportMachineStatus(opcode, `FTMS ${commandLabel} sent (${commandHex}).`)
    } catch (error) {
      if (this.pendingFtmsIndication) {
        this.pendingFtmsIndication.reject(toError(error))
        this.pendingFtmsIndication = null
      }
      throw error
    }

    const result = await indication

    if (!result.ok) {
      const nextError = toError(result.error)

      if (nextError.message === 'Timed out waiting for FTMS control response.') {
        this.ftmsIndicationsUnavailable = true

        this.lastCommandAt = performance.now()
        this.reportMachineStatus(
          opcode,
          `FTMS ${commandLabel} (${commandHex}) did not return an indication; falling back to write-only control mode.`,
        )
        return
      }

      throw nextError
    }

    const responseBytes = result.value
    const response = parseFtmsControlResponse(responseBytes)
    const responseHex = bytesToHex(responseBytes)

    if (!response || response.requestCode !== opcode) {
      throw new Error(
        `FTMS ${commandLabel} response did not match the request (sent ${commandHex}, received ${responseHex}).`,
      )
    }

    const resultMessage = ftmsResultCodeToMessage(response.resultCode)
    this.reportMachineStatus(opcode, `FTMS ${commandLabel} response ${responseHex}: ${resultMessage}.`)

    if (response.resultCode !== 0x01) {
      throw new Error(`FTMS ${commandLabel} failed: ${resultMessage} (sent ${commandHex}, received ${responseHex}).`)
    }

    this.lastCommandAt = performance.now()
  }

  private handleLegacyNotification = (data: Buffer) => {
    this.markNotification()
    const parsed = parseWalkingPadMessage(data)

    if (parsed.kind === 'current-status') {
      this.emit({ type: 'current-status', status: normalizeLegacyCurrentStatus(parsed.status) })
      return
    }

    if (parsed.kind === 'last-status') {
      this.emit({ type: 'last-status', status: parsed.status })
    }
  }

  private handleFtmsNotification = (data: Buffer) => {
    this.markNotification()
    this.emit({ type: 'current-status', status: parseFtmsTreadmillData(data) })
  }

  private handleFtmsControlNotification = (data: Buffer) => {
    this.markNotification()
    if (!this.pendingFtmsIndication) {
      return
    }

    const pending = this.pendingFtmsIndication
    this.pendingFtmsIndication = null
    pending.resolve(new Uint8Array(data))
  }

  private handleFtmsStatusNotification = (data: Buffer) => {
    this.markNotification()
    const status = parseFtmsMachineStatus(data)

    this.emit({
      type: 'machine-status',
      code: status.code,
      message:
        status.targetSpeedKmh !== null
          ? `FTMS target speed is now ${status.targetSpeedKmh.toFixed(2)} km/h.`
          : `FTMS machine status code ${status.code} received.`,
    })
  }

  private handleVendorNotification = (data: Buffer) => {
    this.markNotification()
    const session = parseVendorSessionStatus(data)

    if (session) {
      this.emit({ type: 'session-status', session })
    }

    this.emit({
      type: 'machine-status',
      code: data[0] ?? 0,
      message: `Vendor notification ${data.toString('hex').toUpperCase().replace(/../g, '$& ').trim()}.`,
    })
  }

  private handleDisconnect = () => {
    const wasExplicit = this.explicitDisconnect
    this.explicitDisconnect = false

    void this.safeDisconnect().then(() => {
      this.emit({ type: 'disconnected' })

      if (!wasExplicit) {
        this.emit({ type: 'error', message: 'WalkingPad disconnected unexpectedly.' })
      }
    })
  }

  private async safeDisconnect() {
    if (this.pendingFtmsIndication) {
      this.pendingFtmsIndication.reject(new Error('FTMS control point disconnected.'))
      this.pendingFtmsIndication = null
    }

    const notifyCharacteristic = this.notifyCharacteristic
    if (notifyCharacteristic) {
      notifyCharacteristic.removeListener('data', this.handleLegacyNotification)
      notifyCharacteristic.removeListener('data', this.handleFtmsNotification)
      await this.cleanup('WalkingPad data unsubscribe', () => notifyCharacteristic.unsubscribeAsync())
    }

    const writeCharacteristic = this.writeCharacteristic
    if (writeCharacteristic) {
      writeCharacteristic.removeListener('data', this.handleFtmsControlNotification)
      await this.cleanup('FTMS control point unsubscribe', () => writeCharacteristic.unsubscribeAsync())
    }

    const ftmsStatusCharacteristic = this.ftmsStatusCharacteristic
    if (ftmsStatusCharacteristic) {
      ftmsStatusCharacteristic.removeListener('data', this.handleFtmsStatusNotification)
      await this.cleanup('FTMS status unsubscribe', () => ftmsStatusCharacteristic.unsubscribeAsync())
    }

    const vendorNotifyCharacteristic = this.vendorNotifyCharacteristic
    if (vendorNotifyCharacteristic) {
      vendorNotifyCharacteristic.removeListener('data', this.handleVendorNotification)
      await this.cleanup('Vendor notification unsubscribe', () => vendorNotifyCharacteristic.unsubscribeAsync())
    }

    const connectedPeripheral = this.connectedPeripheral
    if (connectedPeripheral) {
      connectedPeripheral.removeListener('disconnect', this.handleDisconnect)

      if (connectedPeripheral.state === 'connected') {
        await this.cleanup('BLE peripheral disconnect', () => connectedPeripheral.disconnectAsync())
      }
    }

    this.connectedPeripheral = null
    this.notifyCharacteristic = null
    this.writeCharacteristic = null
    this.ftmsStatusCharacteristic = null
    this.vendorNotifyCharacteristic = null
    this.vendorWriteCharacteristic = null
    this.protocol = null
    this.connectionState = 'disconnected'
    this.deviceName = 'WalkingPad'
    this.lastCommandAt = 0
    this.connectedAt = 0
    this.lastNotificationAt = 0
    this.ftmsIndicationsUnavailable = false
    this.commandQueue = Promise.resolve()
  }

  private markConnected() {
    const now = performance.now()
    this.connectedAt = now
    this.lastNotificationAt = now
  }

  private markNotification() {
    this.lastNotificationAt = performance.now()
  }

  private async rememberDevice(peripheral: Peripheral) {
    await mkdir(path.dirname(LAST_DEVICE_PATH), { recursive: true })
    await writeFile(
      LAST_DEVICE_PATH,
      JSON.stringify({
        id: peripheral.id,
      }),
      'utf8',
    )
  }

  private async readRememberedDeviceId() {
    try {
      const contents = await readFile(LAST_DEVICE_PATH, 'utf8')
      const parsed = JSON.parse(contents) as { id?: unknown }
      return typeof parsed.id === 'string' ? parsed.id : null
    } catch {
      return null
    }
  }

  private async subscribeVendorNotifications() {
    if (!this.vendorNotifyCharacteristic) {
      return
    }

    this.vendorNotifyCharacteristic.on('data', this.handleVendorNotification)
    await this.vendorNotifyCharacteristic.subscribeAsync()
  }
}

function normalizeAddress(address: string | null | undefined) {
  return String(address ?? '').trim().toUpperCase()
}
