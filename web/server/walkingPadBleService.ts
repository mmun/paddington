import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { withBindings } from '@stoprocent/noble'
import type { Characteristic, Peripheral } from '@stoprocent/noble'
import {
  COMMAND_GAP_MS,
  FTMS_CONTROL_POINT_UUID,
  FTMS_SERVICE_UUID,
  FTMS_STATUS_UUID,
  FTMS_TREADMILL_DATA_UUID,
  FtmsControlOpcode,
  WalkingPadMode,
  WALKINGPAD_NOTIFY_UUID,
  WALKINGPAD_SERVICE_UUID,
  WALKINGPAD_WRITE_UUID,
  createAskStatsCommand,
  createChangeSpeedCommand,
  createFtmsPauseCommand,
  createFtmsRequestControlCommand,
  createFtmsSetTargetSpeedCommand,
  createFtmsStartOrResumeCommand,
  createStartBeltCommand,
  createStopBeltCommand,
  createSwitchModeCommand,
  ftmsResultCodeToMessage,
  normalizeLegacyCurrentStatus,
  parseFtmsControlResponse,
  parseFtmsMachineStatus,
  parseFtmsTreadmillData,
  parseWalkingPadMessage,
  type WalkingPadProtocolType,
} from '../src/lib/walkingPadProtocol'
import type {
  WalkingPadCommandRequest,
  WalkingPadDeviceSummary,
  WalkingPadServerEvent,
  WalkingPadServerState,
} from '../src/lib/walkingPadApi'

type WalkingPadEventListener = (event: WalkingPadServerEvent) => void

const LAST_DEVICE_PATH = path.resolve(process.cwd(), 'tmp', 'walkingpad-last-device.json')

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
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

function isLikelyWalkingPad(peripheral: Peripheral) {
  const name = peripheral.advertisement.localName ?? ''
  const serviceUuids = peripheral.advertisement.serviceUuids ?? []

  return (
    name.startsWith('WalkingPad') ||
    name.startsWith('KS-') ||
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
  private explicitDisconnect = false
  private lastCommandAt = 0
  private commandQueue: Promise<void> = Promise.resolve()
  private ftmsAuthorized = false
  private ftmsIndicationsUnavailable = false
  private scanPromise: Promise<WalkingPadDeviceSummary[]> | null = null
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

  async connect(deviceId?: string) {
    if (this.connectedPeripheral?.state === 'connected') {
      return this.getState()
    }

    this.connectionState = 'connecting'
    const scannedDevices = await this.scanDevices()
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
    this.emit({ type: 'disconnected' })
    return this.getState()
  }

  async runCommand(command: WalkingPadCommandRequest) {
    switch (command.type) {
      case 'start':
        await this.startBelt()
        break
      case 'stop':
        await this.stopBelt()
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
    }

    return this.getState()
  }

  private emit(event: WalkingPadServerEvent) {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  private async waitForPoweredOn() {
    await this.noble.waitForPoweredOnAsync()
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

    await peripheral.connectAsync()

    const { services, characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync()
    const legacyService = services.find((service) => uuidMatches(service.uuid, WALKINGPAD_SERVICE_UUID))

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
      this.deviceName = peripheral.advertisement.localName ?? peripheral.id
      this.notifyCharacteristic = notifyCharacteristic
      this.writeCharacteristic = writeCharacteristic
      this.notifyCharacteristic.on('data', this.handleLegacyNotification)
      await this.notifyCharacteristic.subscribeAsync()

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
      this.deviceName = peripheral.advertisement.localName ?? peripheral.id
      this.notifyCharacteristic = notifyCharacteristic
      this.writeCharacteristic = writeCharacteristic
      this.ftmsStatusCharacteristic = statusCharacteristic

      this.notifyCharacteristic.on('data', this.handleFtmsNotification)
      await this.notifyCharacteristic.subscribeAsync()

      this.writeCharacteristic.on('data', this.handleFtmsControlNotification)
      await this.writeCharacteristic.subscribeAsync()

      if (this.ftmsStatusCharacteristic) {
        this.ftmsStatusCharacteristic.on('data', this.handleFtmsStatusNotification)
        await this.ftmsStatusCharacteristic.subscribeAsync()
      }

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

  private async stopBelt() {
    this.assertConnected()

    if (this.protocol === 'legacy') {
      await this.sendLegacy(createStopBeltCommand())
      return
    }

    await this.sendFtms(createFtmsPauseCommand(), FtmsControlOpcode.StopOrPause)
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

  private assertConnected() {
    if (!this.connectedPeripheral || this.connectionState !== 'connected' || !this.writeCharacteristic) {
      throw new Error('WalkingPad is not connected.')
    }
  }

  private async sendLegacy(command: Uint8Array) {
    this.commandQueue = this.commandQueue.then(async () => {
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

    await this.commandQueue
  }

  private async sendFtms(command: Uint8Array, opcode: number) {
    this.commandQueue = this.commandQueue.then(async () => {
      if (!this.writeCharacteristic) {
        throw new Error('FTMS control point is unavailable.')
      }

      if (!this.ftmsAuthorized && opcode !== FtmsControlOpcode.RequestControl) {
        await this.sendFtmsCommandOnce(createFtmsRequestControlCommand(), FtmsControlOpcode.RequestControl)
        this.ftmsAuthorized = true
      }

      await this.sendFtmsCommandOnce(command, opcode)
    })

    await this.commandQueue
  }

  private async sendFtmsCommandOnce(command: Uint8Array, opcode: number) {
    if (!this.writeCharacteristic) {
      throw new Error('FTMS control point is unavailable.')
    }

    const waitTime = Math.max(0, COMMAND_GAP_MS - (performance.now() - this.lastCommandAt))
    if (waitTime > 0) {
      await delay(waitTime)
    }

    if (this.ftmsIndicationsUnavailable) {
      await this.writeCharacteristic.writeAsync(Buffer.from(command), false)

      if (opcode === FtmsControlOpcode.RequestControl) {
        this.ftmsAuthorized = true
      }

      this.lastCommandAt = performance.now()
      return
    }

    const indication = new Promise<Uint8Array>((resolve, reject) => {
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
    })

    await this.writeCharacteristic.writeAsync(Buffer.from(command), false)
    let responseBytes: Uint8Array

    try {
      responseBytes = await indication
    } catch (error) {
      const nextError = toError(error)

      if (nextError.message === 'Timed out waiting for FTMS control response.') {
        this.ftmsIndicationsUnavailable = true

        if (opcode === FtmsControlOpcode.RequestControl) {
          this.ftmsAuthorized = true
        }

        this.lastCommandAt = performance.now()
        this.emit({
          type: 'machine-status',
          code: opcode,
          message:
            'FTMS control point is not returning indications. Falling back to write-only control mode.',
        })
        return
      }

      throw nextError
    }

    const response = parseFtmsControlResponse(responseBytes)

    if (!response || response.requestCode !== opcode) {
      throw new Error('FTMS control response did not match the request.')
    }

    if (response.resultCode !== 0x01) {
      throw new Error(ftmsResultCodeToMessage(response.resultCode))
    }

    if (opcode === FtmsControlOpcode.RequestControl) {
      this.ftmsAuthorized = true
    }

    this.lastCommandAt = performance.now()
  }

  private handleLegacyNotification = (data: Buffer) => {
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
    this.emit({ type: 'current-status', status: parseFtmsTreadmillData(data) })
  }

  private handleFtmsControlNotification = (data: Buffer) => {
    if (!this.pendingFtmsIndication) {
      return
    }

    const pending = this.pendingFtmsIndication
    this.pendingFtmsIndication = null
    pending.resolve(new Uint8Array(data))
  }

  private handleFtmsStatusNotification = (data: Buffer) => {
    const status = parseFtmsMachineStatus(data)

    if (status.code === 0xff) {
      this.ftmsAuthorized = false
    }

    this.emit({
      type: 'machine-status',
      code: status.code,
      message:
        status.targetSpeedKmh !== null
          ? `FTMS target speed is now ${status.targetSpeedKmh.toFixed(2)} km/h.`
          : `FTMS machine status code ${status.code} received.`,
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
    if (this.notifyCharacteristic) {
      this.notifyCharacteristic.removeListener('data', this.handleLegacyNotification)
      this.notifyCharacteristic.removeListener('data', this.handleFtmsNotification)
      await this.notifyCharacteristic.unsubscribeAsync().catch(() => undefined)
    }

    if (this.writeCharacteristic) {
      this.writeCharacteristic.removeListener('data', this.handleFtmsControlNotification)
      await this.writeCharacteristic.unsubscribeAsync().catch(() => undefined)
    }

    if (this.ftmsStatusCharacteristic) {
      this.ftmsStatusCharacteristic.removeListener('data', this.handleFtmsStatusNotification)
      await this.ftmsStatusCharacteristic.unsubscribeAsync().catch(() => undefined)
    }

    if (this.connectedPeripheral) {
      this.connectedPeripheral.removeListener('disconnect', this.handleDisconnect)

      if (this.connectedPeripheral.state === 'connected') {
        await this.connectedPeripheral.disconnectAsync().catch(() => undefined)
      }
    }

    if (this.pendingFtmsIndication) {
      this.pendingFtmsIndication.reject(new Error('FTMS control point disconnected.'))
      this.pendingFtmsIndication = null
    }

    this.connectedPeripheral = null
    this.notifyCharacteristic = null
    this.writeCharacteristic = null
    this.ftmsStatusCharacteristic = null
    this.protocol = null
    this.connectionState = 'disconnected'
    this.deviceName = 'WalkingPad'
    this.lastCommandAt = 0
    this.ftmsAuthorized = false
    this.ftmsIndicationsUnavailable = false
    this.commandQueue = Promise.resolve()
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
}
