#!/usr/bin/env python3
import argparse
import asyncio
from typing import Optional

from bleak import BleakClient, BleakScanner


async def find_device(identifier: str, timeout: float):
    device = await BleakScanner.find_device_by_name(identifier, timeout=timeout)
    if device:
        return device

    return await BleakScanner.find_device_by_address(identifier, timeout=timeout)


async def list_devices(timeout: float):
    print(f"Scanning for BLE devices for {timeout:.1f}s...")
    devices = await BleakScanner.discover(timeout=timeout, return_adv=True)

    if not devices:
        print("No BLE devices found.")
        return

    for address, payload in devices.items():
        device, advertisement = payload
        print(f"- name={device.name!r} address={address}")
        if advertisement.service_uuids:
          print(f"  advertised_services={advertisement.service_uuids}")
        if advertisement.manufacturer_data:
          print(f"  manufacturer_data={dict(advertisement.manufacturer_data)}")


async def inspect_device(identifier: str, timeout: float):
    print(f"Looking up device {identifier!r}...")
    device = await find_device(identifier, timeout)
    if not device:
        raise SystemExit(f"Could not find device matching {identifier!r}.")

    print(f"Connecting to name={device.name!r} address={device.address}")

    async with BleakClient(device) as client:
        print(f"Connected={client.is_connected}")
        print("Enumerating services...")

        for service in client.services:
            print(f"[service] {service.uuid}  {service.description}")

            for characteristic in service.characteristics:
                props = ",".join(characteristic.properties)
                print(
                    f"  [char] {characteristic.uuid} handle={characteristic.handle} "
                    f"properties={props} description={characteristic.description}"
                )

                if "read" in characteristic.properties:
                    try:
                        value = await client.read_gatt_char(characteristic.uuid)
                        print(f"    value={bytes(value).hex()}")
                    except Exception as exc:
                        print(f"    read_failed={exc}")

                for descriptor in characteristic.descriptors:
                    try:
                        value = await client.read_gatt_descriptor(descriptor.handle)
                        print(
                            f"    [desc] {descriptor.uuid} handle={descriptor.handle} "
                            f"value={bytes(value).hex()}"
                        )
                    except Exception as exc:
                        print(
                            f"    [desc] {descriptor.uuid} handle={descriptor.handle} "
                            f"read_failed={exc}"
                        )


def main():
    parser = argparse.ArgumentParser(
        description="Inspect BLE services and characteristics for a device.",
    )
    parser.add_argument(
        "identifier",
        nargs="?",
        help="Device name or address. Omit to only scan and list nearby devices.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=8.0,
        help="Scan timeout in seconds. Default: 8.0",
    )
    args = parser.parse_args()

    if args.identifier:
        asyncio.run(inspect_device(args.identifier, args.timeout))
    else:
        asyncio.run(list_devices(args.timeout))


if __name__ == "__main__":
    main()
