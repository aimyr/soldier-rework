import asyncio
import io
import pathlib
import struct
import sys
import types
import unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tools"))
from ble_receiver import receive
from protocol import UUIDS


class ReceiverTests(unittest.IsolatedAsyncioTestCase):
    async def run_session(self, bad=False):
        subscriptions = []
        class BleakError(Exception): pass
        class Scanner:
            @staticmethod
            async def find_device_by_filter(*args, **kwargs):
                return types.SimpleNamespace(address="test-board")
        class Client:
            def __init__(self, device, disconnected_callback):
                self.callback = disconnected_callback
                self.services = types.SimpleNamespace(get_service=lambda _: object())
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def start_notify(self, uuid, callback):
                subscriptions.append(uuid)
                if uuid == UUIDS["status"]:
                    callback(None, b"bad" if bad else struct.pack("<IHHII", 100, 1, 63, 0, 0))
                    self.callback(self)
        module = types.ModuleType("bleak")
        module.BleakClient, module.BleakScanner = Client, Scanner
        exc_module = types.ModuleType("bleak.exc")
        exc_module.BleakError = BleakError
        async def cancel_sleep(_): raise asyncio.CancelledError
        args = types.SimpleNamespace(address=None, name="NUCODE-HUD")
        output = io.StringIO()
        with patch.dict(sys.modules, {"bleak": module, "bleak.exc": exc_module}), patch("ble_receiver.asyncio.sleep", cancel_sleep):
            with self.assertRaises(RuntimeError if bad else asyncio.CancelledError):
                await receive(args, output)
        return subscriptions, output.getvalue()

    async def test_disconnect_reconnect_and_record(self):
        subscriptions, text = await self.run_session()
        self.assertEqual(subscriptions, list(UUIDS.values()))
        self.assertIn('"version": 1', text)
        self.assertIn('"received_at":', text)

    async def test_bad_packet_fails_without_reconnect_loop(self):
        _, text = await self.run_session(bad=True)
        self.assertEqual(text, "")
