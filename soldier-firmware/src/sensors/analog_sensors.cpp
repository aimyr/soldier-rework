#include "analog_sensors.h"
#include <Arduino.h>
#include "config.h"
#include "core/periodic.h"
#include "core/fractional_ticks.h"
#include "pulse_sensor.h"
#include "tmp36.h"
#include <FreeRTOS.h>
#include <task.h>
#include <queue.h>

namespace {
struct Reading { VitalsPacket vitals; uint32_t gaps; };
QueueHandle_t readings = nullptr;
void acquire(void*) {
  PulseSensor pulse(PIN_PULSE);
  Tmp36 temperature(PIN_TMP36);
  analogReadResolution(ADC_BITS);
  analogReference(AR_DEFAULT);
  pulse.begin(); temperature.begin();
  static_assert(uint64_t(PULSE_PERIOD_US) * configTICK_RATE_HZ >= 1000000,
                "Sampling period must be at least one RTOS tick");
  FractionalTicks cadence(PULSE_PERIOD_US, configTICK_RATE_HZ);
  Periodic temperatureTick(10000);
  TickType_t scheduled = xTaskGetTickCount();
  uint32_t previous = micros(), gaps = 0;
  for (;;) {
    const TickType_t step = cadence.next();
    vTaskDelayUntil(&scheduled, step);
    // Skip missed deadlines: never fabricate catch-up ADC samples after a stall.
    const TickType_t actual = xTaskGetTickCount();
    if ((TickType_t)(actual - scheduled) >= step) scheduled = actual;
    const uint32_t now = micros();
    if ((uint32_t)(now - previous) > PULSE_PERIOD_US * 2) ++gaps;
    previous = now;
    pulse.sample();
    if (temperatureTick.due(micros())) temperature.sample();
    Reading reading{{millis(), temperature.readCelsiusX100(), pulse.bpm(), pulse.raw()}, gaps};
    xQueueOverwrite(readings, &reading);
  }
}
}
bool AnalogSensors::begin() {
  readings = xQueueCreate(1, sizeof(Reading));
  if (!readings) return false;
  if (xTaskCreate(acquire, "analog", 1024, nullptr, 3, nullptr) != pdPASS) {
    vQueueDelete(readings); readings = nullptr; return false;
  }
  return true;
}
bool AnalogSensors::snapshot(VitalsPacket& packet, uint32_t& gaps) {
  Reading reading;
  if (!readings || xQueuePeek(readings, &reading, 0) != pdPASS) return false;
  packet = reading.vitals; gaps = reading.gaps; return true;
}
