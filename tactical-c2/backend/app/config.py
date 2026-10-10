"""Runtime configuration (environment variables)."""
import os


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


# Data source: "sim" (built-in simulator) or "serial" (gateway ESP32 over USB)
SOURCE = _env("C2_SOURCE", "sim")
SERIAL_PORT = _env("C2_SERIAL_PORT", "/dev/ttyUSB0")  # Windows: COM3
SERIAL_BAUD = int(_env("C2_SERIAL_BAUD", "115200"))

# Local LLM: any OpenAI-compatible server (llama.cpp server, Ollama, LM Studio)
LLM_BASE_URL = _env("C2_LLM_BASE_URL", "http://127.0.0.1:11434/v1")
LLM_MODEL = _env("C2_LLM_MODEL", "llama3.1:8b")
LLM_TIMEOUT_S = float(_env("C2_LLM_TIMEOUT_S", "25"))
LLM_ENABLED = _env("C2_LLM_ENABLED", "1") == "1"

# Simulator
SIM_SQUAD_SIZE = int(_env("C2_SIM_SQUAD_SIZE", "8"))
SIM_SPEED = float(_env("C2_SIM_SPEED", "1.0"))  # 1.0 = real time
SIM_SEED = int(_env("C2_SIM_SEED", "7"))

# Area of operations: square grid, columns A.., rows 1..
AO_SIZE_M = 300.0
GRID_N = 3  # 3x3 sectors (A1..C3), each 100 m

# Check-in: low-rate randomized heartbeat so the commander can detect isolation
CHECKIN_PERIOD_S = float(_env("C2_CHECKIN_PERIOD_S", "120"))
CHECKIN_JITTER_S = float(_env("C2_CHECKIN_JITTER_S", "30"))
STALE_AFTER_S = CHECKIN_PERIOD_S * 2 + CHECKIN_JITTER_S

# Squad correlation window
CORRELATION_WINDOW_S = 30.0
