#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)
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
    mkdir -p .build/nu87_hud .build/output
    rm -rf .build/nu87_hud/src
    cp -R src .build/nu87_hud/src
    printf '#include <BLEDevice.h>\n' > .build/nu87_hud/nu87_hud.ino
    "$cli" compile --fqbn "$fqbn" --build-path "$root/.build/output" \
      --build-property "compiler.c.extra_flags=-I$root/.build/output/sketch/src" .build/nu87_hud
    if [ "${1:-build}" = upload ]; then
      if [ -z "${2:-}" ]; then echo 'Usage: tools/nu87.sh upload /dev/ttyUSB0' >&2; exit 2; fi
      "$cli" upload --fqbn "$fqbn" --port "$2" --input-file .build/output/km0_km4_image2.bin .build/nu87_hud
    fi
    ;;
  monitor)
    exec "$cli" monitor --port "${2:-/dev/ttyUSB0}" --config baudrate=9600
    ;;
  *) echo 'Usage: tools/nu87.sh {setup|build|upload PORT|monitor PORT}' >&2; exit 2 ;;
esac
