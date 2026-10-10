#!/usr/bin/env python3
"""NUCODE-HUD receiver with reconnect, protocol validation and optional JSONL recording."""
import argparse
import asyncio
import json
import sys
import time
from contextlib import nullcontext
from protocol import SERVICE, UUIDS, decode


async def receive(args, output):
    from bleak import BleakClient, BleakScanner
    from bleak.exc import BleakError
    retry = 2
    while True:
        try:
            if args.address:
                device = await BleakScanner.find_device_by_address(args.address, timeout=15)
            else:
                device = await BleakScanner.find_device_by_filter(
                    lambda _, adv: SERVICE in [s.lower() for s in adv.service_uuids]
                    and adv.local_name == args.name, timeout=15)
            if device is None:
                raise BleakError("보드를 찾지 못했습니다. 전원과 PC Bluetooth를 확인하세요.")
            disconnected = asyncio.Event()
            latest = {}
            received = time.monotonic()
            loop = asyncio.get_running_loop()
            error = None
            def callback(kind):
                def on_packet(_, data):
                    nonlocal received, error
                    try:
                        packet = decode(kind, data)
                        packet["received_at"] = time.time()
                        latest[kind] = (time.monotonic(), packet)
                        received = time.monotonic()
                        if output:
                            output.write(json.dumps(packet, ensure_ascii=False) + "\n")
                    except (ValueError, OSError) as exc:
                        error = exc
                        disconnected.set()
                return on_packet
            async with BleakClient(device, disconnected_callback=lambda _: loop.call_soon_threadsafe(disconnected.set)) as client:
                if client.services.get_service(SERVICE) is None:
                    raise ValueError("보드의 서비스 UUID가 프로토콜 v3과 다릅니다.")
                for kind, uuid in UUIDS.items():
                    await client.start_notify(uuid, callback(kind))
                print(f"Connected: {device.address}", file=sys.stderr)
                retry = 2
                while not disconnected.is_set():
                    try:
                        await asyncio.wait_for(disconnected.wait(), timeout=1)
                    except asyncio.TimeoutError:
                        pass
                    if error:
                        raise RuntimeError(f"수신/기록 실패: {error}")
                    if disconnected.is_set():
                        break
                    now = time.monotonic()
                    if now - received > 5:
                        raise BleakError("5초 동안 데이터가 없어 재연결합니다.")
                    # Expire old readings instead of displaying a disconnected sensor forever.
                    for kind, (stamp, packet) in list(latest.items()):
                        if now - stamp < 3:
                            print(json.dumps(packet, ensure_ascii=False))
                        else:
                            del latest[kind]
                    if output:
                        output.flush()
                if error:
                    raise RuntimeError(f"수신/기록 실패: {error}")
        except (BleakError, OSError, asyncio.TimeoutError) as exc:
            print(f"BLE: {exc}", file=sys.stderr)
        print(f"Reconnecting in {retry}s...", file=sys.stderr)
        await asyncio.sleep(retry)
        retry = min(retry * 2, 30)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", default="NUCODE-HUD")
    parser.add_argument("--address", help="Specific device address (macOS: UUID)")
    parser.add_argument("--jsonl", help="Append every notification to a JSONL file")
    args = parser.parse_args()
    try:
        with (open(args.jsonl, "a", encoding="utf-8") if args.jsonl else nullcontext()) as output:
            asyncio.run(receive(args, output))
    except KeyboardInterrupt:
        pass
    except (ValueError, OSError, RuntimeError) as exc:
        parser.exit(1, f"오류: {exc}\n")
    except ImportError:
        parser.exit(1, "pip install -r tools/requirements.txt 로 의존성을 설치하세요.\n")


if __name__ == "__main__":
    main()
