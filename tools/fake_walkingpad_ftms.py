#!/usr/bin/env python3
"""
BlueZ GATT peripheral that impersonates the WalkingPad's awake FTMS surface.

This is the front-side logger for the phone -> WalkingPad MITM path. It
advertises as KS-AP-RF3, exposes the FTMS service, logs phone subscriptions and
writes, and returns successful FTMS control-point responses.
"""

from __future__ import annotations

import argparse
import itertools
import signal
import sys
import time
from collections import deque
from typing import Any, Callable

import dbus
import dbus.exceptions
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib


BLUEZ_SERVICE = "org.bluez"
ADAPTER_PATH = "/org/bluez/hci0"
APP_PATH = "/com/walkingpad/mitm"
ADV_PATH = "/com/walkingpad/mitm/advertisement0"

DBUS_OM_IFACE = "org.freedesktop.DBus.ObjectManager"
DBUS_PROP_IFACE = "org.freedesktop.DBus.Properties"
ADAPTER_IFACE = "org.bluez.Adapter1"
DEVICE_IFACE = "org.bluez.Device1"
LE_ADV_IFACE = "org.bluez.LEAdvertisement1"
LE_ADV_MANAGER_IFACE = "org.bluez.LEAdvertisingManager1"
GATT_MANAGER_IFACE = "org.bluez.GattManager1"
GATT_SERVICE_IFACE = "org.bluez.GattService1"
GATT_CHRC_IFACE = "org.bluez.GattCharacteristic1"
GATT_DESC_IFACE = "org.bluez.GattDescriptor1"

FTMS_SERVICE_UUID = "00001826-0000-1000-8000-00805f9b34fb"
GAP_SERVICE_UUID = "00001800-0000-1000-8000-00805f9b34fb"
GATT_SERVICE_UUID = "00001801-0000-1000-8000-00805f9b34fb"
TREADMILL_DATA_UUID = "00002acd-0000-1000-8000-00805f9b34fb"
CONTROL_POINT_UUID = "00002ad9-0000-1000-8000-00805f9b34fb"
MACHINE_STATUS_UUID = "00002ada-0000-1000-8000-00805f9b34fb"
CCCD_UUID = "00002902-0000-1000-8000-00805f9b34fb"
DEFAULT_WALKINGPAD_ADDRESS = "54:50:A0:10:4E:84"


def now() -> str:
    return time.strftime("%H:%M:%S")


def log(message: str) -> None:
    print(f"{now()}  {message}", flush=True)


def hex_bytes(value: list[int] | bytes | bytearray | dbus.Array) -> str:
    return bytes(int(item) & 0xFF for item in value).hex(" ")


def dbus_array(data: list[int] | bytes | bytearray) -> dbus.Array:
    return dbus.Array([dbus.Byte(item) for item in data], signature="y")


def dbus_options(**values: Any) -> dbus.Dictionary:
    return dbus.Dictionary(values, signature="sv")


def bytes_variant(data: list[int] | bytes | bytearray) -> dbus.Array:
    return dbus.Array([dbus.Byte(item) for item in data], signature="y")


def service_data_variant(data: list[int] | bytes | bytearray) -> dbus.Array:
    return dbus.Array([dbus.Byte(item) for item in data], signature="y")


def short_uuid(uuid: str) -> str:
    uuid = uuid.lower()
    if uuid.endswith("-0000-1000-8000-00805f9b34fb") and uuid.startswith("0000"):
        return uuid[4:8].upper()
    return uuid


class InvalidArgsException(dbus.exceptions.DBusException):
    _dbus_error_name = "org.freedesktop.DBus.Error.InvalidArgs"


class NotSupportedException(dbus.exceptions.DBusException):
    _dbus_error_name = "org.bluez.Error.NotSupported"


class NotPermittedException(dbus.exceptions.DBusException):
    _dbus_error_name = "org.bluez.Error.NotPermitted"


class Application(dbus.service.Object):
    def __init__(self, bus: dbus.SystemBus):
        super().__init__(bus, APP_PATH)
        self.services: list[Service] = []

    def get_path(self) -> dbus.ObjectPath:
        return dbus.ObjectPath(APP_PATH)

    def add_service(self, service: "Service") -> None:
        self.services.append(service)

    @dbus.service.method(DBUS_OM_IFACE, out_signature="a{oa{sa{sv}}}")
    def GetManagedObjects(self) -> dict[str, dict[str, dict[str, Any]]]:
        response: dict[str, dict[str, dict[str, Any]]] = {}

        for service in self.services:
            response[service.get_path()] = service.get_properties()
            for characteristic in service.characteristics:
                response[characteristic.get_path()] = characteristic.get_properties()
                for descriptor in characteristic.descriptors:
                    response[descriptor.get_path()] = descriptor.get_properties()

        return response


class Advertisement(dbus.service.Object):
    def __init__(self, bus: dbus.SystemBus, local_name: str):
        super().__init__(bus, ADV_PATH)
        self.local_name = local_name

    def get_path(self) -> dbus.ObjectPath:
        return dbus.ObjectPath(ADV_PATH)

    def get_properties(self) -> dict[str, dict[str, Any]]:
        return {
            LE_ADV_IFACE: {
                "Type": "peripheral",
                "ServiceUUIDs": dbus.Array([FTMS_SERVICE_UUID], signature="s"),
                "ServiceData": dbus.Dictionary(
                    {FTMS_SERVICE_UUID: service_data_variant([0x01, 0x00, 0x01])},
                    signature="sv",
                ),
                "ManufacturerData": dbus.Dictionary(
                    {dbus.UInt16(0x5054): bytes_variant([0xA0, 0x10, 0x4E, 0x84])},
                    signature="qv",
                ),
                "LocalName": dbus.String(self.local_name),
                "Includes": dbus.Array([], signature="s"),
            }
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface: str) -> dict[str, Any]:
        if interface != LE_ADV_IFACE:
            raise InvalidArgsException()
        return self.get_properties()[LE_ADV_IFACE]

    @dbus.service.method(LE_ADV_IFACE, in_signature="", out_signature="")
    def Release(self) -> None:
        log("Advertisement released by BlueZ")


class Service(dbus.service.Object):
    def __init__(self, bus: dbus.SystemBus, index: int, uuid: str, primary: bool):
        self.path = f"{APP_PATH}/service{index}"
        super().__init__(bus, self.path)
        self.uuid = uuid
        self.primary = primary
        self.characteristics: list[Characteristic] = []

    def get_path(self) -> dbus.ObjectPath:
        return dbus.ObjectPath(self.path)

    def add_characteristic(self, characteristic: "Characteristic") -> None:
        self.characteristics.append(characteristic)

    def get_properties(self) -> dict[str, dict[str, Any]]:
        return {
            GATT_SERVICE_IFACE: {
                "UUID": self.uuid,
                "Primary": self.primary,
                "Characteristics": dbus.Array(
                    [characteristic.get_path() for characteristic in self.characteristics],
                    signature="o",
                ),
            }
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface: str) -> dict[str, Any]:
        if interface != GATT_SERVICE_IFACE:
            raise InvalidArgsException()
        return self.get_properties()[GATT_SERVICE_IFACE]


class Characteristic(dbus.service.Object):
    def __init__(
        self,
        bus: dbus.SystemBus,
        index: int,
        service: Service,
        uuid: str,
        flags: list[str],
        label: str,
        initial_value: list[int] | None = None,
    ):
        self.path = f"{service.get_path()}/char{index}"
        super().__init__(bus, self.path)
        self.service = service
        self.uuid = uuid
        self.flags = flags
        self.label = label
        self.value = initial_value or []
        self.notifying = False
        self.descriptors: list[Descriptor] = []

    def get_path(self) -> dbus.ObjectPath:
        return dbus.ObjectPath(self.path)

    def add_descriptor(self, descriptor: "Descriptor") -> None:
        self.descriptors.append(descriptor)

    def get_properties(self) -> dict[str, dict[str, Any]]:
        return {
            GATT_CHRC_IFACE: {
                "Service": self.service.get_path(),
                "UUID": self.uuid,
                "Flags": dbus.Array(self.flags, signature="s"),
                "Descriptors": dbus.Array(
                    [descriptor.get_path() for descriptor in self.descriptors],
                    signature="o",
                ),
            }
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface: str) -> dict[str, Any]:
        if interface != GATT_CHRC_IFACE:
            raise InvalidArgsException()
        return self.get_properties()[GATT_CHRC_IFACE]

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="a{sv}", out_signature="ay")
    def ReadValue(self, options: dict[str, Any]) -> dbus.Array:
        log(f"{self.label} read -> {hex_bytes(self.value)}")
        return dbus_array(self.value)

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="aya{sv}", out_signature="")
    def WriteValue(self, value: dbus.Array, options: dict[str, Any]) -> None:
        payload = [int(item) for item in value]
        log(f"{self.label} write <- {hex_bytes(payload)} options={dict(options)}")
        self.value = payload

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="", out_signature="")
    def StartNotify(self) -> None:
        if self.notifying:
            return
        self.notifying = True
        log(f"{self.label} notify/indicate enabled")

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="", out_signature="")
    def StopNotify(self) -> None:
        if not self.notifying:
            return
        self.notifying = False
        log(f"{self.label} notify/indicate disabled")

    @dbus.service.signal(DBUS_PROP_IFACE, signature="sa{sv}as")
    def PropertiesChanged(
        self,
        interface: str,
        changed: dict[str, Any],
        invalidated: list[str],
    ) -> None:
        pass

    def push_value(self, value: list[int]) -> None:
        self.value = value
        if not self.notifying:
            log(f"{self.label} not subscribed; skip push {hex_bytes(value)}")
            return
        log(f"{self.label} push -> {hex_bytes(value)}")
        self.PropertiesChanged(
            GATT_CHRC_IFACE,
            {"Value": dbus_array(value)},
            [],
        )


class FtmsControlPoint(Characteristic):
    def __init__(
        self,
        bus: dbus.SystemBus,
        index: int,
        service: Service,
        write_handler: Callable[[list[int]], None] | None = None,
        optimistic_acks: bool = True,
    ):
        super().__init__(
            bus,
            index,
            service,
            CONTROL_POINT_UUID,
            ["write", "indicate"],
            "FTMS control point 2AD9",
        )
        self.write_handler = write_handler
        self.optimistic_acks = optimistic_acks

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="aya{sv}", out_signature="")
    def WriteValue(self, value: dbus.Array, options: dict[str, Any]) -> None:
        payload = [int(item) for item in value]
        opcode = payload[0] if payload else 0x00
        log(f"{self.label} write <- {hex_bytes(payload)} options={dict(options)}")

        if self.write_handler:
            self.write_handler(payload)

        if self.optimistic_acks:
            # FTMS response code: 0x80, request opcode, result success 0x01.
            self.push_value([0x80, opcode, 0x01])


class MirrorCharacteristic(Characteristic):
    def __init__(
        self,
        bus: dbus.SystemBus,
        index: int,
        service: Service,
        uuid: str,
        flags: list[str],
        label: str,
        upstream: "UpstreamFtmsClient",
        upstream_path: str,
    ):
        super().__init__(bus, index, service, uuid, flags, label)
        self.upstream = upstream
        self.upstream_path = upstream_path
        self.receiver_installed = False

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="a{sv}", out_signature="ay")
    def ReadValue(self, options: dict[str, Any]) -> dbus.Array:
        log(f"{self.label} phone read options={dict(options)}")
        try:
            self.value = self.upstream.read_characteristic(self.upstream_path)
            log(f"{self.label} upstream read -> {hex_bytes(self.value)}")
        except Exception as exc:
            log(f"{self.label} upstream read failed: {exc}")
            raise NotPermittedException(str(exc))
        return dbus_array(self.value)

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="aya{sv}", out_signature="")
    def WriteValue(self, value: dbus.Array, options: dict[str, Any]) -> None:
        payload = [int(item) for item in value]
        write_type = str(options.get("type", "")) if "type" in options else self.default_write_type()
        log(
            f"{self.label} phone write <- {hex_bytes(payload)} "
            f"type={write_type or 'default'} options={dict(options)}"
        )
        try:
            self.upstream.write_characteristic(self.upstream_path, payload, write_type)
        except Exception as exc:
            log(f"{self.label} upstream write failed {hex_bytes(payload)}: {exc}")
            raise NotPermittedException(str(exc))

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="", out_signature="")
    def StartNotify(self) -> None:
        if self.notifying:
            return
        self.notifying = True
        log(f"{self.label} phone notify/indicate enabled")

        if not self.receiver_installed:
            self.upstream.subscribe_path(self.upstream_path, self.push_value, self.label)
            self.receiver_installed = True

        try:
            self.upstream.start_notify(self.upstream_path)
        except Exception as exc:
            log(f"{self.label} upstream notify enable failed: {exc}")
            self.notifying = False
            raise NotPermittedException(str(exc))

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="", out_signature="")
    def StopNotify(self) -> None:
        if not self.notifying:
            return
        self.notifying = False
        log(f"{self.label} phone notify/indicate disabled")
        try:
            self.upstream.stop_notify(self.upstream_path)
        except Exception as exc:
            log(f"{self.label} upstream notify disable ignored: {exc}")

    def default_write_type(self) -> str:
        if "write-without-response" in self.flags and "write" not in self.flags:
            return "command"
        return "request"


class Descriptor(dbus.service.Object):
    def __init__(self, bus: dbus.SystemBus, index: int, characteristic: Characteristic, uuid: str, flags: list[str]):
        self.path = f"{characteristic.get_path()}/desc{index}"
        super().__init__(bus, self.path)
        self.characteristic = characteristic
        self.uuid = uuid
        self.flags = flags
        self.value = [0x00, 0x00]

    def get_path(self) -> dbus.ObjectPath:
        return dbus.ObjectPath(self.path)

    def get_properties(self) -> dict[str, dict[str, Any]]:
        return {
            GATT_DESC_IFACE: {
                "Characteristic": self.characteristic.get_path(),
                "UUID": self.uuid,
                "Flags": dbus.Array(self.flags, signature="s"),
            }
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface: str) -> dict[str, Any]:
        if interface != GATT_DESC_IFACE:
            raise InvalidArgsException()
        return self.get_properties()[GATT_DESC_IFACE]

    @dbus.service.method(GATT_DESC_IFACE, in_signature="a{sv}", out_signature="ay")
    def ReadValue(self, options: dict[str, Any]) -> dbus.Array:
        log(f"descriptor {self.uuid} read -> {hex_bytes(self.value)}")
        return dbus_array(self.value)

    @dbus.service.method(GATT_DESC_IFACE, in_signature="aya{sv}", out_signature="")
    def WriteValue(self, value: dbus.Array, options: dict[str, Any]) -> None:
        self.value = [int(item) for item in value]
        log(f"descriptor {self.uuid} write <- {hex_bytes(self.value)} options={dict(options)}")


class MirrorDescriptor(Descriptor):
    def __init__(
        self,
        bus: dbus.SystemBus,
        index: int,
        characteristic: Characteristic,
        uuid: str,
        flags: list[str],
        label: str,
        upstream: "UpstreamFtmsClient",
        upstream_path: str,
    ):
        super().__init__(bus, index, characteristic, uuid, flags)
        self.label = label
        self.upstream = upstream
        self.upstream_path = upstream_path

    @dbus.service.method(GATT_DESC_IFACE, in_signature="a{sv}", out_signature="ay")
    def ReadValue(self, options: dict[str, Any]) -> dbus.Array:
        log(f"{self.label} phone descriptor read options={dict(options)}")
        try:
            self.value = self.upstream.read_descriptor(self.upstream_path)
            log(f"{self.label} upstream descriptor read -> {hex_bytes(self.value)}")
        except Exception as exc:
            log(f"{self.label} upstream descriptor read failed: {exc}")
            raise NotPermittedException(str(exc))
        return dbus_array(self.value)

    @dbus.service.method(GATT_DESC_IFACE, in_signature="aya{sv}", out_signature="")
    def WriteValue(self, value: dbus.Array, options: dict[str, Any]) -> None:
        payload = [int(item) for item in value]
        log(f"{self.label} phone descriptor write <- {hex_bytes(payload)} options={dict(options)}")
        try:
            self.upstream.write_descriptor(self.upstream_path, payload)
            self.value = payload
        except Exception as exc:
            log(f"{self.label} upstream descriptor write failed {hex_bytes(payload)}: {exc}")
            raise NotPermittedException(str(exc))


def make_treadmill_data(speed_centi_kmh: int, elapsed_seconds: int) -> list[int]:
    # Flags: total distance present (bit 2), elapsed time present (bit 10),
    # step count present (bit 13). The phone only needs plausible data for
    # initial discovery/logging; the real relay will forward real packets later.
    flags = (1 << 2) | (1 << 10) | (1 << 13)
    distance_m = 0
    steps = 0
    return [
        flags & 0xFF,
        (flags >> 8) & 0xFF,
        speed_centi_kmh & 0xFF,
        (speed_centi_kmh >> 8) & 0xFF,
        distance_m & 0xFF,
        (distance_m >> 8) & 0xFF,
        (distance_m >> 16) & 0xFF,
        elapsed_seconds & 0xFF,
        (elapsed_seconds >> 8) & 0xFF,
        steps & 0xFF,
        (steps >> 8) & 0xFF,
        (steps >> 16) & 0xFF,
    ]


class UpstreamFtmsClient:
    def __init__(
        self,
        bus: dbus.SystemBus,
        address: str,
        treadmill_data_sink: Callable[[list[int]], None],
        control_point_sink: Callable[[list[int]], None],
        machine_status_sink: Callable[[list[int]], None],
    ):
        self.bus = bus
        self.address = address.upper()
        self.treadmill_data_sink = treadmill_data_sink
        self.control_point_sink = control_point_sink
        self.machine_status_sink = machine_status_sink
        self.device_path: str | None = None
        self.control_point_path: str | None = None
        self.treadmill_data_path: str | None = None
        self.machine_status_path: str | None = None
        self.control_queue: deque[list[int]] = deque()
        self.control_busy = False
        self.control_current: list[int] | None = None
        self.control_timeout_source: int | None = None

    def connect(self, scan_seconds: int) -> None:
        log(f"upstream scan for WalkingPad {self.address}")
        device_path = self.find_device(scan_seconds)
        if not device_path:
            raise RuntimeError(f"could not find upstream WalkingPad {self.address}")

        self.device_path = device_path
        device = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, device_path), DEVICE_IFACE)
        props = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, device_path), DBUS_PROP_IFACE)

        try:
            connected = bool(props.Get(DEVICE_IFACE, "Connected"))
        except Exception:
            connected = False

        if not connected:
            log(f"upstream connect {device_path}")
            device.Connect()

        self.wait_for_services(device_path)
        self.discover_characteristics()
        self.subscribe_notifications()
        log("upstream WalkingPad FTMS relay is ready")

    def find_device(self, scan_seconds: int) -> str | None:
        if path := self.find_known_device():
            return path

        adapter = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, ADAPTER_PATH), ADAPTER_IFACE)

        try:
            adapter.StartDiscovery()
        except Exception as exc:
            log(f"StartDiscovery ignored: {exc}")

        deadline = time.monotonic() + scan_seconds
        try:
            while time.monotonic() < deadline:
                if path := self.find_known_device():
                    return path
                time.sleep(0.25)
        finally:
            try:
                adapter.StopDiscovery()
            except Exception as exc:
                log(f"StopDiscovery ignored: {exc}")

        return self.find_known_device()

    def find_known_device(self) -> str | None:
        objects = self.managed_objects()

        for path, interfaces in objects.items():
            device = interfaces.get(DEVICE_IFACE)
            if not device:
                continue

            address = str(device.get("Address", "")).upper()
            name = str(device.get("Name", device.get("Alias", "")))
            if address == self.address or name == "KS-AP-RF3":
                log(f"upstream candidate {path} address={address} name={name}")
                return str(path)

        return None

    def wait_for_services(self, device_path: str) -> None:
        props = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, device_path), DBUS_PROP_IFACE)
        deadline = time.monotonic() + 15

        while time.monotonic() < deadline:
            try:
                if bool(props.Get(DEVICE_IFACE, "ServicesResolved")):
                    return
            except Exception:
                pass
            time.sleep(0.25)

        raise RuntimeError("timed out waiting for upstream GATT services")

    def discover_characteristics(self) -> None:
        if not self.device_path:
            raise RuntimeError("upstream device path missing")

        for path, interfaces in self.managed_objects().items():
            if not str(path).startswith(self.device_path):
                continue

            characteristic = interfaces.get(GATT_CHRC_IFACE)
            if not characteristic:
                continue

            uuid = str(characteristic.get("UUID", "")).lower()
            if uuid == TREADMILL_DATA_UUID:
                self.treadmill_data_path = str(path)
            elif uuid == CONTROL_POINT_UUID:
                self.control_point_path = str(path)
            elif uuid == MACHINE_STATUS_UUID:
                self.machine_status_path = str(path)

        log(
            "upstream chars "
            f"2ACD={self.treadmill_data_path} "
            f"2AD9={self.control_point_path} "
            f"2ADA={self.machine_status_path}"
        )

        if not self.treadmill_data_path or not self.control_point_path:
            raise RuntimeError("upstream FTMS treadmill data/control point characteristics not found")

    def iter_gatt_services(self) -> list[dict[str, Any]]:
        if not self.device_path:
            raise RuntimeError("upstream device path missing")

        objects = self.managed_objects()
        services: dict[str, dict[str, Any]] = {}

        for path, interfaces in objects.items():
            path_str = str(path)
            if not path_str.startswith(self.device_path):
                continue

            service = interfaces.get(GATT_SERVICE_IFACE)
            if not service:
                continue

            services[path_str] = {
                "path": path_str,
                "uuid": str(service.get("UUID", "")).lower(),
                "primary": bool(service.get("Primary", True)),
                "characteristics": [],
            }

        for path, interfaces in objects.items():
            path_str = str(path)
            if not path_str.startswith(self.device_path):
                continue

            characteristic = interfaces.get(GATT_CHRC_IFACE)
            if not characteristic:
                continue

            service_path = str(characteristic.get("Service", path_str.rsplit("/", 1)[0]))
            service = services.get(service_path)
            if not service:
                continue

            service["characteristics"].append(
                {
                    "path": path_str,
                    "uuid": str(characteristic.get("UUID", "")).lower(),
                    "flags": [str(flag) for flag in characteristic.get("Flags", [])],
                    "descriptors": [],
                }
            )

        chars_by_path: dict[str, dict[str, Any]] = {}
        for service in services.values():
            for characteristic in service["characteristics"]:
                chars_by_path[characteristic["path"]] = characteristic

        for path, interfaces in objects.items():
            path_str = str(path)
            if not path_str.startswith(self.device_path):
                continue

            descriptor = interfaces.get(GATT_DESC_IFACE)
            if not descriptor:
                continue

            char_path = str(descriptor.get("Characteristic", path_str.rsplit("/", 1)[0]))
            characteristic = chars_by_path.get(char_path)
            if not characteristic:
                continue

            characteristic["descriptors"].append(
                {
                    "path": path_str,
                    "uuid": str(descriptor.get("UUID", "")).lower(),
                    "flags": [str(flag) for flag in descriptor.get("Flags", [])],
                }
            )

        ordered_services = [services[path] for path in sorted(services)]
        for service in ordered_services:
            service["characteristics"].sort(key=lambda item: item["path"])
            for characteristic in service["characteristics"]:
                characteristic["descriptors"].sort(key=lambda item: item["path"])
        return ordered_services

    def read_characteristic(self, path: str) -> list[int]:
        characteristic = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, path), GATT_CHRC_IFACE)
        value = characteristic.ReadValue(dbus_options())
        return [int(item) for item in value]

    def write_characteristic(self, path: str, payload: list[int], write_type: str = "request") -> None:
        characteristic = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, path), GATT_CHRC_IFACE)
        options = dbus_options()
        if write_type:
            options["type"] = dbus.String(write_type)
        characteristic.WriteValue(dbus_array(payload), options)

    def start_notify(self, path: str) -> None:
        characteristic = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, path), GATT_CHRC_IFACE)
        characteristic.StartNotify()

    def stop_notify(self, path: str) -> None:
        characteristic = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, path), GATT_CHRC_IFACE)
        characteristic.StopNotify()

    def read_descriptor(self, path: str) -> list[int]:
        descriptor = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, path), GATT_DESC_IFACE)
        value = descriptor.ReadValue(dbus_options())
        return [int(item) for item in value]

    def write_descriptor(self, path: str, payload: list[int]) -> None:
        descriptor = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, path), GATT_DESC_IFACE)
        descriptor.WriteValue(dbus_array(payload), dbus_options())

    def subscribe_path(self, path: str, sink: Callable[[list[int]], None], label: str) -> None:
        # dbus-python does not pass the object path into a generic
        # PropertiesChanged callback when a path filter is used, so attach one
        # handler per characteristic path with a closure.
        def handler(interface: str, changed: dict[str, Any], invalidated: list[str]) -> None:
            if interface != GATT_CHRC_IFACE or "Value" not in changed:
                return
            payload = [int(item) for item in changed["Value"]]
            log(f"upstream {label} notify -> {hex_bytes(payload)}")
            sink(payload)

        self.bus.add_signal_receiver(
            handler,
            signal_name="PropertiesChanged",
            dbus_interface=DBUS_PROP_IFACE,
            path=path,
        )

    def subscribe_notifications(self) -> None:  # type: ignore[no-redef]
        paths: list[tuple[str | None, Callable[[list[int]], None], str]] = [
            (self.treadmill_data_path, self.treadmill_data_sink, "2ACD"),
            (self.control_point_path, self.handle_control_response, "2AD9"),
            (self.machine_status_path, self.machine_status_sink, "2ADA"),
        ]

        for path, sink, label in paths:
            if not path:
                continue

            self.subscribe_path(path, sink, label)
            characteristic = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, path), GATT_CHRC_IFACE)
            try:
                characteristic.StartNotify()
                log(f"upstream notify enabled {label} {path}")
            except Exception as exc:
                log(f"upstream notify failed {label} {path}: {exc}")

    def handle_control_response(self, payload: list[int]) -> None:
        self.control_point_sink(payload)

        if len(payload) < 2 or payload[0] != 0x80:
            return

        current_opcode = self.control_current[0] if self.control_current else None
        response_opcode = payload[1]
        if not self.control_busy or current_opcode != response_opcode:
            log(
                "upstream 2AD9 response did not match active command "
                f"response={hex_bytes(payload)} active={hex_bytes(self.control_current or [])}"
            )
            return

        if self.control_timeout_source:
            try:
                GLib.source_remove(self.control_timeout_source)
            except Exception:
                pass
            self.control_timeout_source = None

        log(f"upstream 2AD9 completed {hex_bytes(self.control_current or [])} -> {hex_bytes(payload)}")
        self.control_busy = False
        self.control_current = None
        GLib.timeout_add(75, self.drain_control_queue)

    def write_control(self, payload: list[int]) -> None:
        if not self.control_point_path:
            log(f"upstream unavailable; drop control write {hex_bytes(payload)}")
            return

        self.control_queue.append([int(item) & 0xFF for item in payload])
        log(f"upstream 2AD9 queued <- {hex_bytes(payload)} queue={len(self.control_queue)}")
        GLib.idle_add(self.drain_control_queue)

    def drain_control_queue(self) -> bool:
        if self.control_busy or not self.control_queue:
            return False

        if not self.control_point_path:
            self.control_queue.clear()
            return False

        payload = self.control_queue.popleft()
        self.control_current = payload
        self.control_busy = True

        try:
            characteristic = dbus.Interface(
                self.bus.get_object(BLUEZ_SERVICE, self.control_point_path),
                GATT_CHRC_IFACE,
            )
            log(f"upstream 2AD9 write <- {hex_bytes(payload)} remaining={len(self.control_queue)}")
            characteristic.WriteValue(
                dbus_array(payload),
                dbus_options(type=dbus.String("request")),
            )
            self.control_timeout_source = GLib.timeout_add_seconds(3, self.control_response_timeout)
        except Exception as exc:
            log(f"upstream 2AD9 write failed {hex_bytes(payload)}: {exc}")
            self.control_busy = False
            self.control_current = None
            GLib.timeout_add(100, self.drain_control_queue)

        return False

    def control_response_timeout(self) -> bool:
        log(f"upstream 2AD9 response timeout active={hex_bytes(self.control_current or [])}")
        self.control_timeout_source = None
        self.control_busy = False
        self.control_current = None
        GLib.timeout_add(100, self.drain_control_queue)
        return False

    def disconnect(self) -> None:
        if not self.device_path:
            return

        try:
            device = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.device_path), DEVICE_IFACE)
            device.Disconnect()
            log("upstream disconnected")
        except Exception as exc:
            log(f"upstream disconnect ignored: {exc}")

    def managed_objects(self) -> dict[str, dict[str, dict[str, Any]]]:
        manager = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, "/"), DBUS_OM_IFACE)
        return manager.GetManagedObjects()


def add_mirrored_upstream_gatt(
    bus: dbus.SystemBus,
    app: Application,
    upstream: UpstreamFtmsClient,
    ftms_service: Service,
) -> None:
    skipped_services = {GAP_SERVICE_UUID, GATT_SERVICE_UUID}
    special_ftms_chars = {TREADMILL_DATA_UUID, CONTROL_POINT_UUID, MACHINE_STATUS_UUID}
    services_by_uuid = {FTMS_SERVICE_UUID: ftms_service}
    ftms_special_by_uuid = {characteristic.uuid: characteristic for characteristic in ftms_service.characteristics}
    mirrored_services = 0
    mirrored_chars = 0
    mirrored_descs = 0

    def add_mirrored_descriptors(
        characteristic: Characteristic,
        service_uuid: str,
        char_uuid: str,
        upstream_descriptors: list[dict[str, Any]],
    ) -> int:
        added = 0
        desc_index = len(characteristic.descriptors)
        for upstream_desc in upstream_descriptors:
            desc_uuid = upstream_desc["uuid"]
            if desc_uuid == CCCD_UUID:
                continue

            flags = list(upstream_desc["flags"]) or ["read"]
            descriptor = MirrorDescriptor(
                bus,
                desc_index,
                characteristic,
                desc_uuid,
                flags,
                f"mirror {short_uuid(service_uuid)}/{short_uuid(char_uuid)}/{short_uuid(desc_uuid)}",
                upstream,
                upstream_desc["path"],
            )
            characteristic.add_descriptor(descriptor)
            desc_index += 1
            added += 1
            log(f"mirror add desc {short_uuid(char_uuid)}/{short_uuid(desc_uuid)} flags={','.join(flags)}")
        return added

    for upstream_service in upstream.iter_gatt_services():
        service_uuid = upstream_service["uuid"]
        if service_uuid in skipped_services:
            log(f"mirror skip system service {short_uuid(service_uuid)}")
            continue

        service = services_by_uuid.get(service_uuid)
        if service is None:
            service = Service(bus, len(app.services), service_uuid, bool(upstream_service["primary"]))
            services_by_uuid[service_uuid] = service
            app.add_service(service)
            mirrored_services += 1
            log(f"mirror add service {short_uuid(service_uuid)}")
        else:
            log(f"mirror extend service {short_uuid(service_uuid)}")

        char_index = len(service.characteristics)
        for upstream_char in upstream_service["characteristics"]:
            char_uuid = upstream_char["uuid"]
            if service_uuid == FTMS_SERVICE_UUID and char_uuid in special_ftms_chars:
                log(f"mirror keep local FTMS special {short_uuid(char_uuid)}")
                if local_char := ftms_special_by_uuid.get(char_uuid):
                    mirrored_descs += add_mirrored_descriptors(
                        local_char,
                        service_uuid,
                        char_uuid,
                        upstream_char["descriptors"],
                    )
                continue

            flags = list(upstream_char["flags"])
            label = f"mirror {short_uuid(service_uuid)}/{short_uuid(char_uuid)}"
            characteristic = MirrorCharacteristic(
                bus,
                char_index,
                service,
                char_uuid,
                flags,
                label,
                upstream,
                upstream_char["path"],
            )
            if "notify" in flags or "indicate" in flags:
                characteristic.add_descriptor(Descriptor(bus, 0, characteristic, CCCD_UUID, ["read", "write"]))
            service.add_characteristic(characteristic)
            mirrored_descs += add_mirrored_descriptors(
                characteristic,
                service_uuid,
                char_uuid,
                upstream_char["descriptors"],
            )
            mirrored_chars += 1
            char_index += 1
            log(f"mirror add char {short_uuid(char_uuid)} flags={','.join(flags)}")

    log(
        "mirror GATT ready "
        f"services_added={mirrored_services} chars_added={mirrored_chars} descs_added={mirrored_descs}"
    )


def register_app_cb() -> None:
    log("GATT application registered")


def register_app_error_cb(error: Exception) -> None:
    log(f"failed to register GATT application: {error}")
    mainloop.quit()


def register_ad_cb() -> None:
    log("advertisement registered")


def register_ad_error_cb(error: Exception) -> None:
    log(f"failed to register advertisement: {error}")
    mainloop.quit()


mainloop: GLib.MainLoop


def main() -> int:
    parser = argparse.ArgumentParser(description="Fake WalkingPad FTMS GATT peripheral/logger.")
    parser.add_argument("--name", default="KS-AP-RF3", help="advertised local name")
    parser.add_argument(
        "--relay",
        action="store_true",
        help="connect to the real WalkingPad and forward FTMS writes/notifications",
    )
    parser.add_argument(
        "--upstream-address",
        default=DEFAULT_WALKINGPAD_ADDRESS,
        help="real WalkingPad BLE address to connect upstream",
    )
    parser.add_argument(
        "--scan-seconds",
        type=int,
        default=12,
        help="seconds to scan for the upstream WalkingPad in relay mode",
    )
    parser.add_argument(
        "--optimistic-acks",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="also acknowledge phone control-point writes locally",
    )
    parser.add_argument(
        "--mirror-gatt",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="in relay mode, mirror upstream non-system GATT services/chars and proxy them",
    )
    parser.add_argument(
        "--notify-interval",
        type=float,
        default=2.0,
        help="seconds between dummy treadmill notifications; 0 disables",
    )
    args = parser.parse_args()

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()

    app = Application(bus)
    service = Service(bus, 0, FTMS_SERVICE_UUID, True)
    treadmill_data = Characteristic(
        bus,
        0,
        service,
        TREADMILL_DATA_UUID,
        ["notify"],
        "FTMS treadmill data 2ACD",
        make_treadmill_data(0, 0),
    )
    upstream: UpstreamFtmsClient | None = None

    def forward_control_write(payload: list[int]) -> None:
        if upstream:
            upstream.write_control(payload)
        else:
            log(f"logger mode; not forwarding control write {hex_bytes(payload)}")

    control_point = FtmsControlPoint(
        bus,
        1,
        service,
        write_handler=forward_control_write,
        optimistic_acks=args.optimistic_acks,
    )
    machine_status = Characteristic(
        bus,
        2,
        service,
        MACHINE_STATUS_UUID,
        ["notify"],
        "FTMS machine status 2ADA",
        [0x02],
    )

    # Expose CCCD descriptors for apps that explicitly enumerate descriptors.
    treadmill_data.add_descriptor(Descriptor(bus, 0, treadmill_data, CCCD_UUID, ["read", "write"]))
    control_point.add_descriptor(Descriptor(bus, 0, control_point, CCCD_UUID, ["read", "write"]))
    machine_status.add_descriptor(Descriptor(bus, 0, machine_status, CCCD_UUID, ["read", "write"]))

    service.add_characteristic(treadmill_data)
    service.add_characteristic(control_point)
    service.add_characteristic(machine_status)
    app.add_service(service)

    advertisement = Advertisement(bus, args.name)

    if args.relay:
        upstream = UpstreamFtmsClient(
            bus,
            args.upstream_address,
            treadmill_data.push_value,
            control_point.push_value,
            machine_status.push_value,
        )
        upstream.connect(args.scan_seconds)
        if args.mirror_gatt:
            add_mirrored_upstream_gatt(bus, app, upstream, service)

    adapter = bus.get_object(BLUEZ_SERVICE, ADAPTER_PATH)
    gatt_manager = dbus.Interface(adapter, GATT_MANAGER_IFACE)
    ad_manager = dbus.Interface(adapter, LE_ADV_MANAGER_IFACE)

    global mainloop
    mainloop = GLib.MainLoop()

    gatt_manager.RegisterApplication(
        app.get_path(),
        {},
        reply_handler=register_app_cb,
        error_handler=register_app_error_cb,
    )
    ad_manager.RegisterAdvertisement(
        advertisement.get_path(),
        {},
        reply_handler=register_ad_cb,
        error_handler=register_ad_error_cb,
    )

    counter = itertools.count()

    def push_dummy_status() -> bool:
        if args.notify_interval <= 0:
            return False
        elapsed = next(counter) * int(args.notify_interval)
        treadmill_data.push_value(make_treadmill_data(0, elapsed))
        return True

    if args.notify_interval > 0 and not args.relay:
        GLib.timeout_add_seconds(max(1, int(args.notify_interval)), push_dummy_status)

    def shutdown(_signum: int, _frame: Any) -> None:
        log("shutting down fake WalkingPad peripheral")
        try:
            ad_manager.UnregisterAdvertisement(advertisement.get_path())
        except Exception as exc:  # noqa: BLE cleanup best-effort
            log(f"advertisement unregister ignored: {exc}")
        try:
            gatt_manager.UnregisterApplication(app.get_path())
        except Exception as exc:  # noqa: BLE cleanup best-effort
            log(f"GATT unregister ignored: {exc}")
        if upstream:
            upstream.disconnect()
        mainloop.quit()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    mode = "relay" if args.relay else "logger"
    log(f"fake WalkingPad FTMS peripheral starting as {args.name} ({mode} mode)")
    log("watch this terminal for phone subscriptions and writes")
    mainloop.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
