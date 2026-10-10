// Commander-side gateway: receive ESP-NOW packets, print them for the backend.
// Output format (docs/DATA_SPEC.md section 5):  PKT:<hex>,RSSI:<dBm>
//
// Reference sketch for the hardware owner. Written for the Arduino-ESP32 core 3.x,
// where the receive callback takes esp_now_recv_info_t. On core 2.x the callback
// signature is (const uint8_t *mac, const uint8_t *data, int len) and RSSI is not
// passed; print RSSI:0 in that case.
#include <WiFi.h>
#include <esp_now.h>

static const int PACKET_SIZE = 18;

void onRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  if (len != PACKET_SIZE) return;  // backend also checks CRC
  char line[4 + PACKET_SIZE * 2 + 16];
  int n = sprintf(line, "PKT:");
  for (int i = 0; i < len; i++) n += sprintf(line + n, "%02x", data[i]);
  sprintf(line + n, ",RSSI:%d", info->rx_ctrl ? info->rx_ctrl->rssi : 0);
  Serial.println(line);
}

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);  // ESP-NOW needs the Wi-Fi radio, but no access point
  if (esp_now_init() != ESP_OK) {
    Serial.println("esp_now_init failed");
    return;
  }
  esp_now_register_recv_cb(onRecv);
  Serial.println("gateway ready");
}

void loop() {}
