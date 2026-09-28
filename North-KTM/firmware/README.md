# SewerSafe firmware (ESP32)

Two sketches for the **miniature sewer model**. Never use them to judge whether a real sewer is safe to enter.

| Sketch | Board | What it does |
|---|---|---|
| `esp32_sensor_node/` | ESP32 Dev Module | Reads gas, water, temperature, humidity and cover tilt every 2 s and POSTs them to the backend. Sounds a local alarm even when Wi-Fi is down. |
| `esp32_robot/` | ESP32 Dev Module | Small wheeled robot with a web API (`/cmd`, `/status`). Every move is a short pulse, and it refuses to drive into an obstacle. |
| ESP32-CAM | AI-Thinker ESP32-CAM | Stock **CameraWebServer** example; its stream shows on the dashboard. |

> **Not compiled here.** The sandbox these were written in couldn't download the ESP32 toolchain, so the sketches have been checked by hand against the esp32 Arduino core 2.x and 3.x APIs, not compiled. Compile both at home before the event, and paste any error back to Claude. The backend side of the protocol *is* tested: `tools/fake-esp32-robot.js` and `tools/fake-esp32-sensor.js` speak the exact same HTTP/JSON, and the test suite drives them.

---

## 1. Arduino IDE setup (once)

1. Install **Arduino IDE 2** (arduino.cc/en/software).
2. **File → Preferences → Additional boards manager URLs:**
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
3. **Tools → Board → Boards Manager →** search **esp32** (by Espressif) → Install.
4. **Sketch → Include Library → Manage Libraries →** install:
   - `DHT sensor library` (Adafruit), and accept "install all" for `Adafruit Unified Sensor`
   - `Adafruit MPU6050`
   - `ArduinoJson` (version 7)
5. Plug in the ESP32 with a **data** USB cable (charge-only cables are a common trap). **Tools → Board → ESP32 Dev Module**, then **Tools → Port** → the new COM port.
   No port appears on Windows? Install the CP210x or CH340 USB driver, depending on the chip on your board.

---

## 2. Sensor node

### Parts

ESP32 Dev board · MQ-4 (methane) · MQ-2 (combustible) · MQ-135 (air quality) · resistive water-level sensor · DHT22 · MPU6050 · red LED + 220 Ω · active buzzer · resistors: 3× 10 kΩ, 3× 20 kΩ, 4× 100 kΩ, 1× 10 kΩ (DHT pull-up) · breadboard · 5 V supply able to give 1 A (the three MQ heaters draw ~150 mA each).

### Wiring

| Part | Part pin | ESP32 pin | Notes |
|---|---|---|---|
| MQ-4 | AO | **GPIO34** via divider | AO → 10 kΩ → GPIO34, GPIO34 → 20 kΩ → GND |
| MQ-135 | AO | **GPIO35** via divider | same divider |
| MQ-2 | AO | **GPIO32** via divider | same divider |
| All MQ | VCC / GND | 5V / GND | heaters need 5 V |
| Water sensor | S | **GPIO36** (VP) | + to 3.3 V, − to GND |
| DHT22 | DATA | **GPIO4** | 10 kΩ from DATA to 3.3 V |
| MPU6050 | SDA / SCL | **GPIO21 / GPIO22** | VCC 3.3 V. Mount it on the model's manhole cover |
| Red LED | + | **GPIO25** | through 220 Ω |
| Buzzer (active) | + | **GPIO26** | |
| 100 kΩ pull-downs | | GPIO34, 35, 32, 36 → GND | an unplugged sensor then reads 0 and is sent as `null` (missing), not as a fake value |

Only ADC1 pins (GPIO32–39) are used on purpose: ADC2 pins stop working while Wi-Fi is on.

### Flash and run

1. Open `esp32_sensor_node/esp32_sensor_node.ino` and edit the top block: `WIFI_SSID`, `WIFI_PASSWORD`, `SERVER_URL` (the laptop IP that `npm start` prints) and `API_KEY` if you set `DEVICE_API_KEY`.
2. The ESP32 needs **2.4 GHz** Wi-Fi. A phone hotspot works; turn on its "maximize compatibility" option on iPhone.
3. Upload. Open **Serial Monitor at 115200**.
4. First boot: it warms the MQ heaters for 60 s, then calibrates in **clean air**. Keep it away from gas during this. Send `c` in the Serial Monitor to recalibrate later. For stable values, leave new MQ sensors powered for a few hours first.
5. Each line shows the JSON sent and the server's answer: `→ 201 risk SAFE entry ROBOT_FIRST`.

**Demo gas source:** hold an *unlit* butane lighter near the MQ-2/MQ-4 and press the gas button for a second. Do it outdoors or near an open window, away from flames. The reading climbs, the dashboard goes CRITICAL, and the local buzzer sounds.
**Cover-open demo:** lift the model's manhole cover (tilt > 30°) while it's blocked. The dashboard raises an entry-attempt alert.

`config/sewers.json` lists S101's sensors. If you fit an oxygen sensor, add `"oxygen"` there; if you leave a sensor out, remove it from the list. An installed sensor that sends nothing is treated as a fault, never as safe.

---

## 3. Robot

### Parts

ESP32 Dev board · 2WD chassis with 2 geared DC motors · L298N driver · HC-SR04 ultrasonic · 2× 18650 cells + holder (7.4 V) · white LED + 220 Ω · resistors 1 kΩ + 2 kΩ (echo divider), optional 100 kΩ + 33 kΩ (battery sense).

### Wiring

| From | To | Notes |
|---|---|---|
| L298N ENA | **GPIO14** | remove the ENA jumper cap |
| L298N IN1 / IN2 | **GPIO27 / GPIO26** | left motor |
| L298N IN3 / IN4 | **GPIO25 / GPIO33** | right motor |
| L298N ENB | **GPIO32** | remove the ENB jumper cap |
| L298N 12V / GND | battery + / battery − | |
| L298N GND | ESP32 GND | **shared ground is required** |
| L298N 5V out | ESP32 VIN | only if the 5V-EN jumper is on; else power the ESP32 by USB power bank |
| HC-SR04 VCC / GND | 5V / GND | |
| HC-SR04 TRIG | **GPIO5** | |
| HC-SR04 ECHO | **GPIO18** via divider | ECHO → 1 kΩ → GPIO18, GPIO18 → 2 kΩ → GND |
| Headlight LED | **GPIO4** | through 220 Ω |
| Battery sense (optional) | **GPIO35** | pack + → 100 kΩ → GPIO35 → 33 kΩ → GND; set `HAS_BATTERY_SENSE = true` |

If a wheel spins the wrong way, swap that motor's two wires on the L298N.

### Flash and connect

1. Edit `WIFI_SSID` / `WIFI_PASSWORD` in `esp32_robot/esp32_robot.ino` and upload.
2. The Serial Monitor prints `Robot ready: http://192.168.x.y`.
3. Test from a browser on the same Wi-Fi: `http://192.168.x.y/status`, then `http://192.168.x.y/cmd?c=forward`.
4. In the laptop's `.env`:
   ```
   ROBOT_DRIVER=esp32
   ROBOT_URL=http://192.168.x.y
   ```
   Restart the backend. The dashboard chip shows `Robot: esp32`.

Mission geometry for a table-top model defaults to a 2 m pipe, 10 cm per pulse and a checkpoint every 50 cm. Tune these with `ROBOT_SEGMENT_M`, `ROBOT_STEP_M` and `ROBOT_CHECKPOINT_M`.

**Known limit:** without wheel encoders, the robot's position is estimated by counting pulses, so it may stop a few cm short of the start on the way back. Wheel encoders are the fix (listed under future work).

---

## 4. ESP32-CAM (optional live video)

1. **Tools → Board → AI Thinker ESP32-CAM**. It has no USB, so use an FTDI/USB-serial adapter or an ESP32-CAM-MB programmer board.
2. **File → Examples → ESP32 → Camera → CameraWebServer.** In the sketch, uncomment `#define CAMERA_MODEL_AI_THINKER` (comment the others) and set your Wi-Fi.
3. Upload. With an FTDI adapter, hold GPIO0 to GND while resetting to enter flash mode, then remove it and reset to run.
4. The Serial Monitor prints `Camera Ready! Use 'http://192.168.x.z' to connect`.
5. In `.env`: `CAMERA_URL=http://192.168.x.z:81/stream`. Restart the backend.

Mount it on the robot facing forward. Without it, the dashboard shows a mock camera drawn from the robot's real telemetry.

---

## 5. No hardware yet? Use the fakes

```
node tools/fake-esp32-robot.js                  # robot on http://127.0.0.1:8081
node tools/fake-esp32-sensor.js --danger        # S101 methane climbs to CRITICAL
node tools/fake-esp32-sensor.js --danger --open # …then the cover is lifted (entry attempt)
node tools/fake-esp32-sensor.js --unplug methane
```
With `.env`: `ROBOT_DRIVER=esp32` and `ROBOT_URL=http://127.0.0.1:8081`.
