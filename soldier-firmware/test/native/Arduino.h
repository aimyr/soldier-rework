#pragma once
#include <stdint.h>
constexpr uint8_t A4 = 11, A5 = 10, INPUT = 0;
uint32_t millis();
int analogRead(uint8_t);
void pinMode(uint8_t, uint8_t);


constexpr uint8_t LOW = 0, OUTPUT = 1, INPUT_PULLUP = 2;
uint32_t micros();
void delayMicroseconds(uint32_t);
void digitalWrite(uint8_t, uint8_t);
int digitalRead(uint8_t);

void delay(uint32_t);
