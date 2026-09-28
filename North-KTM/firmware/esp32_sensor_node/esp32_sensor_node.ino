/*
  SewerSafe — ESP32 SENSOR NODE (goes on the miniature sewer model)

  Reads gas / water / temperature / tilt sensors every 2 s and POSTs them to the
  SewerSafe backend. Also sounds a LOCAL alarm when gas is high, even if Wi-Fi or the
  server is down: the site must never depend on the network to warn people.

  PROTOTYPE ONLY. MQ sensors are uncalibrated indicators, not certified gas detectors.
  Test on a miniature model. Never use this to decide that a real sewer is safe to enter.

  Board: "ESP32 Dev Module" (Arduino IDE, esp32 core 2.x or 3.x)
  Libraries (Library Manager): "DHT sensor library" (Adafruit), "Adafruit Unified Sensor",
                               "Adafruit MPU6050", "ArduinoJson" (v7)

  WIRING (see firmware/README.md for the full table)
    MQ-4  (methane)      AO → divider → GPIO34     MQ-2 (combustible) AO → divider → GPIO32
    MQ-135 (air quality) AO → divider → GPIO35     Water-level sensor  S  → GPIO36 (VP)
    DHT22 data → GPIO4 (10k pull-up to 3.3V)       MPU6050 SDA → GPIO21, SCL → GPIO22
    Red LED → GPIO25 (220Ω)   Buzzer (active) → GPIO26   Status LED = on-board GPIO2
    Divider for every MQ AO (5V max): AO → 10kΩ → GPIO, GPIO → 20kΩ → GND  (max 3.33 V)
    Only ADC1 pins (32–39) are used: ADC2 pins stop working while Wi-Fi is on.
*/
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <Wire.h>
#include <DHT.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <math.h>
#include "time.h"

// ============================== EDIT THESE ==============================
const char* WIFI_SSID     = "YOUR_WIFI";
const char* WIFI_PASSWORD = "YOUR_PASSWORD";
const char* SERVER_URL    = "http://192.168.1.23:4000/api/sensors/data";  // laptop IP printed by `npm start`
const char* SEWER_ID      = "S101";
const char* DEVICE_ID     = "esp32-node-1";
const char* API_KEY       = "";            // same as DEVICE_API_KEY in .env (leave "" if not set)
const uint32_t SEND_EVERY_MS = 2000;

// Which parts are fitted. A fitted sensor that reads nothing is reported as missing (null).
const bool HAS_MQ4 = true, HAS_MQ2 = true, HAS_MQ135 = true, HAS_WATER = true, HAS_DHT = true, HAS_MPU = true;

// Local alarm threshold (works without network). Keep in step with config/thresholds.json.
const float LOCAL_ALARM_METHANE_PPM = 5000;
// =======================================================================

// Pins
const int PIN_MQ4 = 34, PIN_MQ135 = 35, PIN_MQ2 = 32, PIN_WATER = 36, PIN_DHT = 4;
const int PIN_RED = 25, PIN_BUZZER = 26, PIN_STATUS = 2;

// MQ electrical constants. RL is the load resistor ON YOUR MODULE (check it: often 1k, sometimes 10k).
const float VC = 5.0;            // heater/circuit supply
const float RL_KOHM = 1.0;
const float DIVIDER = 1.5;       // 10k/20k divider: sensor voltage = pin voltage × 1.5

// Power-law fits ppm = A · (Rs/R0)^B from the MQ datasheet curves (as used by the MQUnifiedsensor
// library). Verify against your module's datasheet. Clean-air Rs/R0 ratios are from the datasheets.
const float MQ4_A = 1012.7, MQ4_B = -2.786, MQ4_CLEAN = 4.4;   // CH4
const float MQ2_A = 574.25, MQ2_B = -2.222, MQ2_CLEAN = 9.83;  // LPG/combustible
const float MQ135_CLEAN = 3.6;

// Water sensor: millivolts when the strip is fully wet. Measure yours and set it.
const float WATER_FULL_MV = 1600;

DHT dht(PIN_DHT, DHT22);
Adafruit_MPU6050 mpu;
Preferences prefs;
bool mpuOk = false;
float R0_mq4 = 0, R0_mq2 = 0, R0_mq135 = 0;
uint32_t lastSend = 0;
String lastRisk = "UNKNOWN";

// ------------------------------------------------------------ helpers
float pinMilliVolts(int pin) {                       // averaged, calibrated ADC reading
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) sum += analogReadMilliVolts(pin);
  return sum / 16.0;
}

// A floating or shorted input reads ~0 or ~full scale. Add a 100k pull-down on each analog
// input so an unplugged sensor reads 0 and is reported as missing instead of as a value.
bool looksDisconnected(float mv) { return mv < 30 || mv > 3250; }

float rsKohm(int pin, bool* ok) {
  float mv = pinMilliVolts(pin);
  *ok = !looksDisconnected(mv);
  float vout = (mv / 1000.0) * DIVIDER;
  if (vout < 0.01) vout = 0.01;
  return RL_KOHM * (VC - vout) / vout;
}

void calibrate() {
  // Run in CLEAN AIR after 5+ minutes of heater warm-up. Stores R0 in flash.
  Serial.println("Calibrating MQ sensors in clean air (20 s)...");
  float a = 0, b = 0, c = 0; bool ok;
  for (int i = 0; i < 40; i++) { a += rsKohm(PIN_MQ4, &ok); b += rsKohm(PIN_MQ2, &ok); c += rsKohm(PIN_MQ135, &ok); delay(500); }
  R0_mq4 = (a / 40) / MQ4_CLEAN; R0_mq2 = (b / 40) / MQ2_CLEAN; R0_mq135 = (c / 40) / MQ135_CLEAN;
  prefs.putFloat("r0_mq4", R0_mq4); prefs.putFloat("r0_mq2", R0_mq2); prefs.putFloat("r0_mq135", R0_mq135);
  Serial.printf("R0: MQ-4 %.2f k  MQ-2 %.2f k  MQ-135 %.2f k (saved)\n", R0_mq4, R0_mq2, R0_mq135);
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("Wi-Fi: connecting to %s", WIFI_SSID);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(250); Serial.print("."); digitalWrite(PIN_STATUS, i % 2); }
  Serial.println(WiFi.status() == WL_CONNECTED ? String(" OK ") + WiFi.localIP().toString() : String(" failed (will retry)"));
}

bool isoNow(char* out, size_t n) {                  // only if NTP time is available
  struct tm t;
  if (!getLocalTime(&t, 50)) return false;
  strftime(out, n, "%Y-%m-%dT%H:%M:%SZ", &t);
  return true;
}

void setAlarm(bool on) {
  digitalWrite(PIN_RED, on);
  digitalWrite(PIN_BUZZER, on);
}

// ------------------------------------------------------------ setup / loop
void setup() {
  Serial.begin(115200);
  pinMode(PIN_RED, OUTPUT); pinMode(PIN_BUZZER, OUTPUT); pinMode(PIN_STATUS, OUTPUT);
  analogReadResolution(12);
  // default attenuation already covers ~0–3.1 V on core 2.x and 3.x (enum names differ between them)
  if (HAS_DHT) dht.begin();
  if (HAS_MPU) { Wire.begin(21, 22); mpuOk = mpu.begin(); Serial.println(mpuOk ? "MPU6050 OK" : "MPU6050 not found"); }

  prefs.begin("sewersafe", false);
  R0_mq4 = prefs.getFloat("r0_mq4", 0); R0_mq2 = prefs.getFloat("r0_mq2", 0); R0_mq135 = prefs.getFloat("r0_mq135", 0);
  Serial.println("Send 'c' on the Serial Monitor (115200) to calibrate MQ sensors in clean air.");
  if (R0_mq4 <= 0 || R0_mq2 <= 0 || R0_mq135 <= 0) {
    Serial.println("No calibration stored: warming up 60 s, then calibrating. Keep sensors in clean air.");
    for (int i = 0; i < 60; i++) { delay(1000); digitalWrite(PIN_STATUS, i % 2); }
    calibrate();
  }
  connectWifi();
  configTime(0, 0, "pool.ntp.org", "time.google.com"); // UTC; if there's no internet, the server stamps the time
}

void loop() {
  if (Serial.available() && Serial.read() == 'c') calibrate();
  if (millis() - lastSend < SEND_EVERY_MS) return;
  lastSend = millis();

  JsonDocument doc;
  doc["sewer_id"] = SEWER_ID;
  doc["device_id"] = DEVICE_ID;
  char ts[32];
  if (isoNow(ts, sizeof ts)) doc["timestamp"] = ts;

  bool ok;
  float methane = NAN, combustible = NAN, airIdx = NAN;
  if (HAS_MQ4)   { float rs = rsKohm(PIN_MQ4, &ok);   if (ok && R0_mq4 > 0) methane = MQ4_A * pow(rs / R0_mq4, MQ4_B); }
  if (HAS_MQ2)   { float rs = rsKohm(PIN_MQ2, &ok);   if (ok && R0_mq2 > 0) combustible = MQ2_A * pow(rs / R0_mq2, MQ2_B); }
  if (HAS_MQ135) { float rs = rsKohm(PIN_MQ135, &ok); if (ok && R0_mq135 > 0) {
      // relative index: 0 in clean air, rising as Rs falls (more pollutants). Not a certified AQI.
      float ratio = rs / R0_mq135;
      airIdx = constrain((MQ135_CLEAN - ratio) / MQ135_CLEAN * 500.0, 0, 500); } }

  auto put = [&](const char* k, float v, float lo, float hi) { if (isnan(v) || v < lo || v > hi) doc[k] = nullptr; else doc[k] = roundf(v * 10) / 10; };
  put("methane", methane, 0, 100000);
  put("combustible", combustible, 0, 100000);
  put("air_quality", airIdx, 0, 1000);

  if (HAS_WATER) { float mv = pinMilliVolts(PIN_WATER); put("water_level", constrain(mv / WATER_FULL_MV * 100.0, 0, 100), 0, 100); }
  if (HAS_DHT)   { put("temperature", dht.readTemperature(), -20, 100); put("humidity", dht.readHumidity(), 0, 100); }
  if (HAS_MPU && mpuOk) {
    sensors_event_t a, g, t; mpu.getEvent(&a, &g, &t);
    float mag = sqrtf(a.acceleration.x * a.acceleration.x + a.acceleration.y * a.acceleration.y + a.acceleration.z * a.acceleration.z);
    float tilt = mag > 0.1 ? acosf(constrain(a.acceleration.z / mag, -1.0f, 1.0f)) * 180.0 / PI : NAN;   // 0° = cover flat
    put("tilt", tilt, 0, 180);
  } else if (HAS_MPU) doc["tilt"] = nullptr;

  // LOCAL safety first: alarm without waiting for the server
  bool localDanger = !isnan(methane) && methane >= LOCAL_ALARM_METHANE_PPM;

  String body; serializeJson(doc, body);
  Serial.println(body);

  connectWifi();
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.setTimeout(3000);
    http.begin(SERVER_URL);
    http.addHeader("Content-Type", "application/json");
    if (strlen(API_KEY)) http.addHeader("x-api-key", API_KEY);
    int code = http.POST(body);
    if (code > 0) {
      String resp = http.getString();
      JsonDocument r;
      if (!deserializeJson(r, resp) && r["risk"]["risk_level"].is<const char*>()) lastRisk = r["risk"]["risk_level"].as<const char*>();
      Serial.printf("  → %d  risk %s  entry %s\n", code, lastRisk.c_str(), r["human_entry"] | "?");
    } else {
      Serial.printf("  → send failed: %s\n", http.errorToString(code).c_str());
      lastRisk = "UNKNOWN";
    }
    http.end();
  }
  setAlarm(localDanger || lastRisk == "CRITICAL");
  digitalWrite(PIN_STATUS, WiFi.status() == WL_CONNECTED);
}
