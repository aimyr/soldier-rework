#include "log.h"
#include <FreeRTOS.h>
#include <task.h>
#include <queue.h>
#include <stdarg.h>
#include <stdio.h>

namespace {
struct Line { uint16_t length; char text[160]; };
QueueHandle_t lines = nullptr;
void output(void*) {
  Line line;
  for (;;) {
    if (xQueueReceive(lines, &line, portMAX_DELAY) == pdPASS) {
      for (uint16_t i = 0; i < line.length; ++i) {
        Serial.write(static_cast<uint8_t>(line.text[i]));
        // The vendor UART writer polls the FIFO. Yield between bytes.
        vTaskDelay(1);
      }
    }
  }
}
}
bool beginLogging() {
#if CFG_DEBUG
  lines = xQueueCreate(8, sizeof(Line));
  if (!lines) return false;
  if (xTaskCreate(output, "serial_log", 1024, nullptr, 1, nullptr) != pdPASS) {
    vQueueDelete(lines); lines = nullptr; return false;
  }
#endif
  return true;
}
void logMessage(const char* format, ...) {
#if CFG_DEBUG
  if (!lines) return;
  Line line{};
  va_list args;
  va_start(args, format);
  int n = vsnprintf(line.text, sizeof(line.text), format, args);
  va_end(args);
  if (n <= 0 || n >= static_cast<int>(sizeof(line.text))) return;
  line.length = n;
  xQueueSend(lines, &line, 0);
#else
  (void)format;
#endif
}
