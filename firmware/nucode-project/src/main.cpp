#include <Arduino.h>
#include "config.h"
#include "core/log.h"
#include "core/periodic.h"
#include "core/status_led.h"
#include "comm/ble_link.h"
#include "comm/serial_telemetry.h"
#include "sensors/analog_sensors.h"
#include "sensors/gps.h"
#include "sensors/imu.h"

namespace {
Imu imu;
AnalogSensors analog;
Gps gps;
BleLink ble;
StatusLed statusLed;
uint32_t readyMs = 0;
bool analogReady = false, bleReady = false;
uint32_t sampleGaps = 0;
VitalsPacket vitals{0, INT16_MIN, 0, 0};
Periodic imuTick(IMU_PERIOD_US), vitalsTick(VITALS_PERIOD_US);
Periodic gpsTick(GPS_PERIOD_US), retryTick(IMU_RETRY_US), statusTick(1000000);
}
void setup() {
  statusLed.begin();
  Serial.begin(SERIAL_DEBUG_BAUD);
  beginLogging();
  bleReady = ble.begin();
  analogReady = analog.begin();
  imu.begin();
  if (CFG_GPS) gps.begin();
  readyMs = millis();
  LOG("[main] ready imu=%u analog=%u ble=%u\n", imu.ok(), analogReady, bleReady);
}
void loop() {
  if (CFG_GPS) gps.poll();
  if (retryTick.due(micros()) && !imu.active()) imu.begin();
  imu.poll();
  if (imuTick.due(micros())) {
    ImuPacket packet{};
    OrientationPacket orientation{};
    if (imu.read(packet, orientation)) {
      static Periodic serialImu(1000000);
      if (serialImu.due(micros())) {
        SerialTelemetry::print(packet);
        SerialTelemetry::print(orientation);
      }
      if (bleReady) { ble.sendImu(packet); ble.sendOrientation(orientation); }
    }
  }
  if (vitalsTick.due(micros())) {
    if (analog.snapshot(vitals, sampleGaps)) {
      static Periodic serialVitals(1000000);
      if (serialVitals.due(micros())) SerialTelemetry::print(vitals);
      if (bleReady) ble.sendVitals(vitals);
    }
  }
  if (CFG_GPS && gpsTick.due(micros())) {
    GpsPacket packet{};
    gps.snapshot(packet);
    SerialTelemetry::print(packet);
    if (bleReady) ble.sendGps(packet);
  }
  if (statusTick.due(micros())) {
    GpsPacket position{};
    gps.snapshot(position);
    const bool freshAnalog = analogReady && (uint32_t)(millis() - vitals.t_ms) < 1000;
    uint16_t flags = (imu.ok() ? 1 : 0) | (freshAnalog ? 2 : 0)
      | ((freshAnalog && vitals.temp_c_x100 != INT16_MIN) ? 4 : 0)
      | ((freshAnalog && vitals.bpm) ? 8 : 0)
      | (position.fix ? 16 : 0) | (CFG_GPS ? 32 : 0)
      | ((imu.active() && !imu.ok()) ? 64 : 0);
    StatusPacket packet{millis(), 3, flags, ble.dropped(), sampleGaps};
    if (bleReady) ble.sendStatus(packet);
    SerialTelemetry::print(packet);
    LOG("DMP,state=%u,fifo_resets=%lu\n", unsigned(imu.state()), (unsigned long)imu.fifoResets());
  }
  const uint32_t nowMs = millis();
  const bool settled = (uint32_t)(nowMs - readyMs) >= 1000;
  const bool analogStale = settled && (uint32_t)(nowMs - vitals.t_ms) >= 1000;
  StatusLed::State ledState;
  if (!bleReady || !analogReady || analogStale) ledState = StatusLed::State::Fatal;
  else if (imu.active() && !imu.ok()) ledState = StatusLed::State::Boot;
  else if (!imu.ok() || (settled && vitals.temp_c_x100 == INT16_MIN))
    ledState = StatusLed::State::SensorFault;
  else ledState = ble.connected() ? StatusLed::State::Connected : StatusLed::State::Ready;
  statusLed.update(ledState, nowMs);
  delay(MAIN_IDLE_MS);
}
