# NU40 HUD 센서 펌웨어

NU40 DK에서 NU-IMU, TMP36, 아날로그 Pulse Sensor, UART NMEA GPS를 읽어 PC로 BLE notify 전송합니다. GPS는 기본 활성화되어 있습니다.

## 배선

NU40 제조사 Arduino variant를 프로젝트에 포함했습니다. `board = adafruit_feather_nrf52840`은 기존에 업로드에 성공한 플래시/부트로더 구성을 유지하기 위한 기반이며, 실제 핀 정의는 `variants/nu40dk_nrf52840`입니다. Arduino 핀 번호와 nRF 포트 번호를 Feather 핀맵으로 해석하지 마세요.

| 부품 신호 | NU40 연결 | 비고 |
|---|---|---|
| TMP36 VOUT | A0 = P0.02 | `PIN_TMP36` |
| TMP36 +VS | 3.3V | 센서 가까이에 +VS–GND 100nF 바이패스 권장 |
| TMP36 GND | GND | TO-92 패키지 핀 1=+VS, 2=VOUT, 3=GND. 데이터시트 bottom view로 확인 |
| Pulse Sensor S | A1 = P0.03 | `PIN_PULSE` |
| Pulse Sensor + / − | 3.3V / GND | 실제 구입 센서의 단자 표기를 확인 |
| NU-IMU | Qwiic 커넥터 | SDA=P0.26, SCL=P0.27, 3.3V, GND |
| GPS TX | P1.01 (Arduino 33, Serial1 RX) | 수신만 할 때 이 신호와 GND 사용 |
| GPS RX | P1.02 (Arduino 34, Serial1 TX) | 선택 연결; 현재 펌웨어는 설정 명령을 보내지 않음 |
| GPS GND | GND | 모든 센서 공통 접지 |
| GPS VCC | 모듈 사양 확인 후 연결 | 모듈 모델 미확인; 전원 전압은 UART 신호 전압과 다를 수 있음 |

아날로그 입력과 UART/I2C 신호는 3.3V 수준으로 연결합니다. ADC의 3.6V 변환 범위는 핀에 3.6V나 5V를 인가해도 된다는 뜻이 아닙니다. TMP36은 제품 데이터시트의 핀 번호로 연결하고, 평평한 면만 보고 핀 방향을 추정하지 마세요.

NU-IMU 상품 상세 이미지에는 LSM6DS3TR 표기가 있습니다. 드라이버는 TR-C의 WHO_AM_I=0x6A와 설정 레지스터 read-back을 확인하며 I2C 0x6A/0x6B를 탐색합니다. 실제 출고된 센서가 다른 ID이면 로그를 남기고 IMU를 비활성화합니다.

GPS는 **UART NMEA GGA/RMC, 9600 baud**를 기본값으로 사용합니다. 실제 모델/보레이트는 아직 확인되지 않았습니다. `src/config.h`의 `GPS_BAUD`를 모듈에 맞추세요. UBX 바이너리 전용 출력은 이 파서로 읽을 수 없습니다.

## 빌드와 업로드

프로젝트 폴더에서 실행합니다. 래퍼는 설치되어 있으면 VS Code의 PlatformIO 가상환경을 우선 사용합니다.

```sh
sh tools/pio.sh run -e nucode_nu40
sh tools/pio.sh device list
sh tools/pio.sh run -e nucode_nu40 -t upload --upload-port /dev/ttyACM0
sh tools/pio.sh device monitor -p /dev/ttyACM0 -b 9600
```

실제 포트 이름이 다르면 바꾸세요. Windows는 `COMx`, macOS는 `/dev/cu.usbmodem...`을 명시합니다. 기본 Linux 업로드 포트 패턴은 `/dev/ttyACM*`로 제한하여 `/dev/ttyS0` 오탐을 방지합니다. 여러 보드가 연결되어 있으면 반드시 명시적인 포트를 사용하세요. 포트 자체가 없으면 데이터 USB 케이블과 부트로더 진입을 확인해야 합니다.

## 시리얼 디버깅 (9600 baud)

USB 시리얼 모니터를 9600 baud로 열면 BLE 연결 여부와 관계없이 모든 종류의 전송 데이터를 출력합니다. IMU는 유효한 새 측정마다 약 50Hz, VITALS는 5Hz, GPS와 STATUS는 각각 1Hz입니다. 심박 내부 500Hz 샘플 전체가 아닌 BLE 패킷과 같은 시점의 raw 값을 출력합니다.

```text
IMU,t_ms=1000,ax=0,ay=0,az=8197,gx=0,gy=0,gz=0
VITALS,t_ms=1000,temp_c_x100=2500,bpm=60,pulse_raw=1800
GPS,t_ms=1000,lat_e7=0,lon_e7=0,alt_cm=0,speed_cms=0,fix=0,sats=0
STATUS,t_ms=1000,version=1,flags=0x2F,tx_dropped=0,sample_gaps=0
```

위 값은 출력 형식 예시입니다. IMU 축 값은 raw이며 변환 계수는 아래 패킷 표를 따릅니다. `temp_c_x100=2500`은 25.00°C, `-32768`은 무효입니다. GPS 좌표는 도×1e7입니다. IMU 미연결 시 IMU 행은 나오지 않고 STATUS의 bit0이 0입니다.

`Serial`은 TinyUSB USB CDC이므로 9600은 포트 설정값이며 실제 USB 처리량이 UART 9600bps로 제한되지는 않습니다. GPS용 `Serial1`과는 별개입니다. 모니터가 닫혔거나 USB 버퍼가 가득 차면 로그를 생략하여 센서 수집이 멈추지 않게 합니다. 출력은 기본 활성화이며 `CFG_DEBUG=0`이면 꺼집니다.

## PC 수신

Python 3.10 이상과 BLE 어댑터가 필요합니다. Linux는 실행 환경에서 BlueZ/D-Bus에 접근할 수 있어야 합니다.

```sh
python3 -m venv .venv
.venv/bin/pip install -r tools/requirements.txt
.venv/bin/python tools/ble_receiver.py
.venv/bin/python tools/ble_receiver.py --jsonl capture.jsonl
```

동일한 보드가 여러 개면 `--address ADDRESS`로 지정합니다. 콘솔은 최신 값을 1초마다 출력하고, JSONL에는 수신한 모든 패킷과 PC 수신 시각을 저장합니다. 3초 이상 갱신되지 않은 센서 값은 표시에서 제거합니다. 장치 미발견/연결 해제/5초 무응답 시 재탐색하며 Ctrl+C로 종료합니다. 잘못된 패킷이나 알 수 없는 프로토콜 버전은 오류로 종료합니다.

이전 코드가 Nordic UART Service UUID를 재사용하던 문제를 해결하면서 UUID가 변경되었습니다. 반드시 새 펌웨어와 새 수신기를 함께 사용하세요. 서비스 UUID는 `76b90001-7c4d-4f21-9b63-136a2d8e507c`, 각 특성은 앞부분의 마지막 숫자가 2/3/4/5입니다.

## 구조와 동작

- `src/main.cpp`: 초기화, IMU/GPS 수집 및 패킷 발행 조정.
- `src/config.h`: 핀, 보레이트, 샘플링/발행 주기.
- `src/sensors/analog_sensors.*`: 별도 FreeRTOS 태스크에서 ADC를 단독 소유. 목표 평균 500Hz 심박 수집, 온도 100Hz 수집/16회 평균, 큐로 일관된 스냅샷 전달.
- `src/sensors/pulse_sensor.*`: 실제 경과 시간으로 BPM 계산. 20ms 초과 샘플 공백 또는 2.5초 무박동 시 결과 초기화.
- `src/sensors/tmp36.*`: 12bit/3.6V 기준 ADC → 섭씨 변환. -40~125°C 밖의 값 또는 초기 평균 미완성은 무효.
- `src/sensors/imu.*`: ±4g, ±500dps, 기본 내부 ODR 52Hz 저전력 모드 (`IMU_LOW_POWER=false`일 때 104Hz 고성능), 약 50Hz로 최신 데이터 전송. 연속 3회 통신 오류 또는 1초간 새 데이터 없음 시 오프라인, 2초마다 재초기화.
- `src/comm/i2c_bus.*`: open-drain 소프트웨어 I2C, 거래당 5ms 시간 제한(절전 대기의 RTOS tick만큼 초과 가능), STOP 해제 검사, 재초기화 시 9클록 복구. 클록이 고정된 동안 RTOS 대기로 CPU를 양보합니다. 코어 Wire의 무제한 하드웨어 대기문으로 인한 멈춤을 피하기 위한 별도 드라이버. 단일 마스터/짧은 Qwiic 배선용이며 외부 풀업은 센서 보드의 풀업 구성을 확인.
- `src/sensors/nmea_parser.*`: Arduino에 의존하지 않는 GPS 파서. 체크섬, 길이, 좌표/단위/숫자 범위 검사, 3초 위치 만료, 속도 독립 만료, 무효 RMC 처리.
- `src/comm/ble_link.*`: 별도 태스크와 8개 패킷 큐. 포화 시 새 패킷을 버리고 계수하여 센서 수집을 계속함. 500ms 넘게 대기한 패킷과 이전 연결의 패킷도 폐기. 재연결 시 다시 구독 필요.
- `src/protocol/*`, `tools/protocol.py`: 바이너리 포맷과 PC 디코딩.

심박 수집은 RTOS의 1024Hz tick을 2/3 tick 간격으로 분배해 평균 500Hz로 예약합니다. 1000초 기준 누적 tick 오차가 없는지 호스트 테스트로 검사하지만, 인터럽트/태스크 지연이 있으므로 정확한 2ms 하드웨어 타이머 샘플링은 아닙니다. 4ms를 초과한 샘플 간격은 `sample_gaps`에 기록합니다. 실제 신호에서 노이즈·움직임·착용 상태에 따른 보정이 필요합니다. 떠 있는 ADC 입력을 소프트웨어만으로 확실하게 감지할 수는 없습니다. TMP36 출력은 센서 자체의 온도이며 이를 곧바로 심부 체온으로 해석하면 안 됩니다.

## 패킷 v1

모두 little-endian, 패딩 없음, 최대 20바이트로 기본 ATT MTU 23에서도 한 번의 notify에 들어갑니다. `t_ms`는 보드의 32bit millis로 약 49.7일마다 순환하며 재부팅하면 0부터 시작합니다.

| 특성 | 크기 / 주기 | Python 포맷 | 내용 |
|---|---|---|---|
| IMU (`...02`) | 16B / 50Hz 목표 | `<I6h` | t_ms, ax/ay/az, gx/gy/gz. 가속도 ×0.000122 g, 각속도 ×0.0175 dps |
| Vitals (`...03`) | 10B / 5Hz | `<IhHH` | 수집 t_ms, °C×100, BPM, ADC raw. 온도 -32768=무효, BPM 0=미측정 |
| GPS (`...04`) | 20B / 1Hz | `<IiiiHBB` | t_ms, 위도×1e7, 경도×1e7, 고도 cm, 속도 cm/s, fix, 위성 수 |
| Status (`...05`) | 16B / 1Hz + read | `<IHHII` | t_ms, version=1, flags, tx_dropped, sample_gaps |

Status flags: bit0 IMU 온라인, bit1 아날로그 수집 최신, bit2 온도 범위 유효, bit3 BPM 존재, bit4 GPS fix, bit5 GPS 활성화. GPS fix=0이면 좌표/고도/속도/위성 수를 0으로 보내며 수신기는 위치를 `null`로 표시합니다. 속도 필드 0은 정지 또는 속도 미수신/만료일 수 있습니다. 위성 위치는 GGA 기준이며 RMC만 보내는 모듈은 GGA 출력도 켜야 합니다.

`tx_dropped`는 큐 포화/오래된 패킷/notify 실패의 누적값입니다. 연결되지 않았거나 구독되지 않아 전송하지 않은 값은 포함하지 않습니다. BLE notify는 PC 애플리케이션까지의 전달 확인 응답이나 영구 보관을 제공하지 않습니다. 현재 개발용 서비스는 암호화/페어링을 요구하지 않습니다.

## 전력 설정과 측정

`src/config.h`에서 전력에 영향을 주는 값을 한곳에 관리합니다. 기본 설정은 다음과 같습니다.

- IMU: 52Hz 저전력 모드. 범위와 패킷 단위는 유지합니다. 잡음 특성은 고성능 모드와 달라서 실제 자세/움직임 측정으로 검증해야 합니다.
- BLE: MTU 23, event length 7.5ms, HVN queue 8개. 기존 최대 대역폭 설정 대신 20바이트 이하의 데이터에 맞춥니다.
- BLE 연결 간격: 30~50ms 요청. PC가 최종 간격을 결정하며, 이벤트당 여러 패킷을 전송합니다.
- 송신 출력: 0dBm. 거리/패킷 손실 시험을 통해 더 낮출 수 있는지 확인해야 합니다.
- 광고: 처음 10초는 100ms, 이후 1초 간격. 기존보다 검색 시간이 길어질 수 있습니다.
- 자동 연결 LED 끔, 메인 루프 유휴 대기 5ms. 심박 수집 태스크는 매 tick을 확인하던 방식에서 평균 500회/초 깨우기로 변경했습니다.
- 요청된 9600 USB 시리얼 출력은 유지합니다. 모니터가 닫혀 있으면 텍스트 포맷 작업도 생략합니다.

이 수치는 설정값이며 전류 절감 실측값은 아닙니다. GPS 전원/절전 명령은 모델이 확인되지 않아 변경하지 않았습니다. 보드 전원 LED, 센서 LED, GPS 안테나/수신기, USB 연결도 시스템 소비 전류에 영향을 줍니다. 자세한 검증 항목과 남은 작업은 [전력·안정성 검증](docs/power-validation.md)을 참조하세요.

## 검증

```sh
sh tools/test.sh
sh tools/pio.sh run -e nucode_nu40
```

호스트 테스트는 C++ 컴파일러와 ASan/UBSan을 사용합니다. GPS 손상 체크섬, 과도한 길이, 좌표 오류, fix/속도 만료, millis 순환, 무작위 바이트 후 복구, 심박 합성 신호/샘플 공백, 온도 변환, I2C 정상 읽기·쓰기/반복 START/NACK/고정된 SDA·SCL/STOP 실패 후 복구, Python 패킷 길이/UUID 일치를 검사합니다.

실물 검증은 별도입니다. 센서 연결 후 다음을 확인하세요.

1. 부팅 로그의 WHO_AM_I=0x6A와 Status의 IMU 온라인 비트.
2. 정지 IMU 가속도 크기가 약 1g인지, 회전 시 자이로가 변하는지.
3. TMP36 상온 출력과 기준 온도계 비교, 손가락 접촉 후 BPM의 안정화.
4. GPS 개활지 수신 후 fix=1, GPS 분리 후 3초 안에 fix=0.
5. PC 연결 해제/재연결, 센서 분리/재연결, 지속 운용 시 drops/gaps 확인.

빌드 및 호스트 테스트 통과만으로 배선, 무선 품질, 측정 정확도나 장시간 무중단 동작을 보증하지 않습니다.

## 확인한 자료

- [NU-IMU 상품 상세 이미지: LSM6DS3TR 표기](https://nucode.store/web/upload/NNEditor/20260917/NU-IMU20SENSOR01-1.jpg)
- [NU40 DK 제조사 문서](https://nucode.gitbook.io/nuseries/dks/nu-40-dk)
- [NU40 제조사 Arduino variant](https://github.com/Nucode01/Adafruit_nRF52_Arduino/tree/master/variants/nu40dk_nrf52840) — 반영 커밋은 `variants/nu40dk_nrf52840/SOURCE.txt` 참조.
- [ST LSM6DS3TR-C 데이터시트](https://www.st.com/resource/en/datasheet/lsm6ds3tr-c.pdf)
- [Analog Devices TMP35/36/37 데이터시트](https://www.analog.com/media/en/technical-documentation/data-sheets/TMP35_36_37.pdf)
- [Bleak API 문서](https://bleak.readthedocs.io/en/latest/api/client.html)
