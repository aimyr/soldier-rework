#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Match the VS Code extension's isolated PlatformIO install when available.
if [ -x "$HOME/.platformio/penv/bin/pio" ]; then
  exec "$HOME/.platformio/penv/bin/pio" "$@"
fi
exec pio "$@"
