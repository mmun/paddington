if (!ObjC.available) {
  throw new Error('Objective-C runtime not available')
}

function safeString(getter, fallback) {
  try {
    const value = getter()
    return value ? value.toString() : fallback
  } catch {
    return fallback
  }
}

function nsDataToByteArray(nsdata) {
  const length = nsdata.length().valueOf()
  const bytes = nsdata.bytes()
  const raw = Memory.readByteArray(bytes, length)
  return raw ? new Uint8Array(raw) : new Uint8Array()
}

function hex(buffer) {
  return Array.from(buffer)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ')
}

function characteristicInfo(characteristic) {
  return {
    uuid: safeString(() => characteristic.UUID().UUIDString(), '?'),
    serviceUuid: safeString(() => characteristic.service().UUID().UUIDString(), '?'),
  }
}

const CBPeripheral = ObjC.classes.CBPeripheral

Interceptor.attach(
  CBPeripheral['- writeValue:forCharacteristic:type:'].implementation,
  {
    onEnter(args) {
      const data = new ObjC.Object(args[2])
      const characteristic = new ObjC.Object(args[3])
      const writeType = args[4].toInt32()
      const info = characteristicInfo(characteristic)

      console.log(
        JSON.stringify({
          event: 'write',
          serviceUuid: info.serviceUuid,
          characteristicUuid: info.uuid,
          writeType,
          data: hex(nsDataToByteArray(data)),
        }),
      )
    },
  },
)

Interceptor.attach(
  CBPeripheral['- setNotifyValue:forCharacteristic:'].implementation,
  {
    onEnter(args) {
      const enabled = args[2].toInt32() !== 0
      const characteristic = new ObjC.Object(args[3])
      const info = characteristicInfo(characteristic)

      console.log(
        JSON.stringify({
          event: 'set-notify',
          enabled,
          serviceUuid: info.serviceUuid,
          characteristicUuid: info.uuid,
        }),
      )
    },
  },
)

const resolver = new ApiResolver('objc')
for (const match of resolver.enumerateMatchesSync('*[* *didUpdateValueForCharacteristic:error:*]')) {
  Interceptor.attach(match.address, {
    onEnter(args) {
      try {
        const characteristic = new ObjC.Object(args[3])
        const info = characteristicInfo(characteristic)
        const value = characteristic.value()
        const bytes = value.isNull() ? new Uint8Array() : nsDataToByteArray(value)

        console.log(
          JSON.stringify({
            event: 'notify-in',
            serviceUuid: info.serviceUuid,
            characteristicUuid: info.uuid,
            data: hex(bytes),
          }),
        )
      } catch (error) {
        console.log(
          JSON.stringify({
            event: 'notify-in-error',
            error: String(error),
          }),
        )
      }
    },
  })
}
