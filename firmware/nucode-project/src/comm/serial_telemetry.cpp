#include "serial_telemetry.h"
#include "core/log.h"

void SerialTelemetry::print(const ImuPacket& p) {
  LOG("IMU,t_ms=%lu,ax=%d,ay=%d,az=%d,gx=%d,gy=%d,gz=%d\n",
      (unsigned long)p.t_ms, p.ax, p.ay, p.az, p.gx, p.gy, p.gz);
}
void SerialTelemetry::print(const VitalsPacket& p) {
  LOG("VITALS,t_ms=%lu,temp_c_x100=%d,bpm=%u,pulse_raw=%u\n",
      (unsigned long)p.t_ms, p.temp_c_x100, p.bpm, p.pulse_raw);
}
void SerialTelemetry::print(const GpsPacket& p) {
  LOG("GPS,t_ms=%lu,lat_e7=%ld,lon_e7=%ld,alt_cm=%ld,speed_cms=%u,fix=%u,sats=%u\n",
      (unsigned long)p.t_ms, (long)p.lat_e7, (long)p.lon_e7,
      (long)p.alt_cm, p.speed_cms, p.fix, p.sats);
}
void SerialTelemetry::print(const StatusPacket& p) {
  LOG("STATUS,t_ms=%lu,version=%u,flags=0x%02X,tx_dropped=%lu,sample_gaps=%lu\n",
      (unsigned long)p.t_ms, p.version, p.flags,
      (unsigned long)p.tx_dropped, (unsigned long)p.sample_gaps);
}
