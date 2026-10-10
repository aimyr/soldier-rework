#!/bin/sh
# Build/upload the NU-87 gateway with Arduino CLI and the Realtek AmebaD 3.1.9 core
# (same core and board settings as soldier-firmware/tools/nu87.sh).
set -eu
cd "$(dirname "$0")"
cli=${ARDUINO_CLI:-}
if [ -z "$cli" ]; then
  if command -v arduino-cli >/dev/null 2>&1; then cli=$(command -v arduino-cli)
  else cli="$HOME/.local/bin/arduino-cli"; fi
fi
if [ ! -x "$cli" ]; then echo "Install Arduino CLI or set ARDUINO_CLI to its path." >&2; exit 127; fi
index=https://raw.githubusercontent.com/Ameba-AIoT/ameba-arduino-d/master/Arduino_package/package_realtek_amebad_index.json
fqbn=realtek:AmebaD:Ameba_AMB26:AutoUploadMode=Enable,UploadBaudrate=921600
case "${1:-build}" in
  setup)
    "$cli" core update-index --additional-urls "$index"
    exec "$cli" core install realtek:AmebaD@3.1.9 --additional-urls "$index"
    ;;
  build|upload)
    mkdir -p .build
    "$cli" compile --fqbn "$fqbn" --build-path "$(pwd)/.build" .
    if [ "${1:-build}" = upload ]; then
      if [ -z "${2:-}" ]; then echo 'Usage: build.sh upload /dev/ttyUSB0' >&2; exit 2; fi
      "$cli" upload --fqbn "$fqbn" --port "$2" --input-file .build/km0_km4_image2.bin .
    fi
    ;;
  monitor)
    exec "$cli" monitor --port "${2:-/dev/ttyUSB0}" --config baudrate=115200
    ;;
  test) exec sh test/run.sh ;;
  *) echo 'Usage: build.sh {setup|build|upload PORT|monitor PORT|test}' >&2; exit 2 ;;
esac
