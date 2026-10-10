#pragma once
#include "config.h"

// Logging is queued; slow UART writes never run in the acquisition task.
bool beginLogging();
void logMessage(const char* format, ...);
#define LOG(...) logMessage(__VA_ARGS__)
