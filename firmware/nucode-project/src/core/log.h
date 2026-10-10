#pragma once
#include "config.h"
#include <Adafruit_TinyUSB.h>
#include <stdarg.h>
#include <stdio.h>
#include <atomic>

// Drop a log rather than wait for an absent or slow USB host.
inline void logMessage(const char* format, ...) {
#if CFG_DEBUG
  if (!Serial) return;
  // BLE callbacks and loop() can log concurrently. A nonblocking guard keeps
  // availableForWrite()+write() atomic with respect to other log producers.
  static std::atomic_flag writing = ATOMIC_FLAG_INIT;
  if (writing.test_and_set(std::memory_order_acquire)) return;
  char buffer[128];
  va_list args;
  va_start(args, format);
  int n = vsnprintf(buffer, sizeof(buffer), format, args);
  va_end(args);
  if (n > 0 && n < (int)sizeof(buffer) && Serial.availableForWrite() >= n)
    Serial.write((const uint8_t*)buffer, n);
  writing.clear(std::memory_order_release);
#else
  (void)format;
#endif
}
#define LOG(...) logMessage(__VA_ARGS__)
