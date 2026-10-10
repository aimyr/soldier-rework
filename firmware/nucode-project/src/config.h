#pragma once
// Central configuration for board pins, wiring, and timing.

#include <Arduino.h>

// ---- Pins ----
// Analog inputs for TMP36GT9Z (Vout) and Pulse Sensor (Signal).
constexpr uint8_t PIN_TMP36 = A0;
constexpr uint8_t PIN_PULSE = A1;
// GPS UART (Serial1): GPS TX -> board RX, GPS RX -> board TX; pins follow the board variant.
// IMU Qwiic: SDA=P0.26, SCL=P0.27, bounded I2cBus driver.

// ---- GPS ----
constexpr uint32_t GPS_BAUD = 9600;  // Actual module baud rate must match.

static_assert(PIN_TMP36 != PIN_PULSE, "Analog sensors need separate pins");

// ---- ADC ----
constexpr uint8_t  ADC_BITS      = 12;
constexpr uint16_t ADC_VREF_MV   = 3600;  // analogReference(AR_INTERNAL): 0.6V / (1/6) = 3.6V full scale

static_assert(ADC_BITS >= 10 && ADC_BITS <= 12, "Supported ADC resolution: 10..12");

// ---- Sampling periods (us) ----
constexpr uint32_t PULSE_PERIOD_US = 2000;     // 500 Hz (beat detection)
constexpr uint32_t IMU_PERIOD_US   = 20000;    // 50 Hz
constexpr uint32_t VITALS_PERIOD_US = 200000;  // 5 Hz (temperature and pulse telemetry)
constexpr uint32_t GPS_PERIOD_US    = 1000000; // 1 Hz (latest GPS telemetry)

// ---- BLE ----
constexpr char BLE_DEVICE_NAME[] = "NUCODE-HUD";
constexpr int8_t BLE_TX_POWER_DBM = 0;  // Increase only if range measurements require it.
constexpr uint16_t BLE_CONN_MIN_UNITS = 24;  // 30ms, units of 1.25ms
constexpr uint16_t BLE_CONN_MAX_UNITS = 40;  // 50ms; multiple notifications per event
constexpr uint16_t BLE_ADV_FAST_UNITS = 160; // 100ms, units of 0.625ms
constexpr uint16_t BLE_ADV_SLOW_UNITS = 1600; // 1s after initial discovery window
constexpr uint16_t BLE_ADV_FAST_SECONDS = 10;
constexpr uint32_t MAIN_IDLE_MS = 5;
// 52Hz low-power mode retains the requested ~50Hz stream, with more sensor noise
// than high-performance mode. Set false for 104Hz high-performance acquisition.
constexpr bool IMU_LOW_POWER = true;
// UART NMEA GPS enabled; adjust baud rate for the actual module.
#ifndef CFG_GPS
#define CFG_GPS 1
#endif
constexpr uint32_t GPS_STALE_MS = 3000;
constexpr uint32_t IMU_RETRY_US = 2000000;

// ---- Debug logging (USB CDC Serial; separate from GPS Serial1) ----
constexpr uint32_t SERIAL_DEBUG_BAUD = 9600;
#ifndef CFG_DEBUG
#define CFG_DEBUG 1
#endif
