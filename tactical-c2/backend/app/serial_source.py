"""Hardware data source: the gateway ESP32 prints received packets over USB serial.

Expected line format (one per received packet):
    PKT:<36 hex chars>,RSSI:<int>
Any other line (debug prints) is ignored.
"""
from __future__ import annotations

import asyncio
import logging
import threading

from . import config

log = logging.getLogger("c2.serial")


def start_serial_reader(loop: asyncio.AbstractEventLoop, queue: asyncio.Queue) -> threading.Thread:
    import serial  # pyserial

    def run() -> None:
        while True:
            try:
                with serial.Serial(config.SERIAL_PORT, config.SERIAL_BAUD, timeout=1) as port:
                    log.info("serial open %s @ %d", config.SERIAL_PORT, config.SERIAL_BAUD)
                    while True:
                        raw = port.readline()
                        if raw:
                            line = raw.decode("ascii", errors="ignore")
                            loop.call_soon_threadsafe(queue.put_nowait, line)
            except Exception as exc:  # unplugged, wrong port: retry
                log.warning("serial error: %s (retrying in 2 s)", exc)
                threading.Event().wait(2)

    th = threading.Thread(target=run, name="serial-reader", daemon=True)
    th.start()
    return th
