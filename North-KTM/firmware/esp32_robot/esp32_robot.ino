/*
  SewerSafe — ESP32 ROBOT (small wheeled robot for the miniature sewer model)

  Runs a tiny web server. The SewerSafe backend drives it with:
     GET /cmd?c=forward|backward|left|right|stop   → moves for one short pulse, returns status JSON
     GET /status                                   → {state, distance_cm, blocked, moving, battery_pct, ...}
  Set in .env on the laptop:  ROBOT_DRIVER=esp32   ROBOT_URL=http://<this robot's IP>

  Safety built into the robot itself (not just the server):
   • every command is a short pulse: if the network drops, the motors stop anyway
   • forward is refused when the ultrasonic sensor sees an obstacle closer than STOP_CM
   • while moving forward it keeps checking and stops the moment something is too close

  Board: "ESP32 Dev Module". Works on esp32 Arduino core 2.x and 3.x. No extra libraries.

  WIRING (see firmware/README.md)
    L298N: ENA → GPIO14, IN1 → GPIO27, IN2 → GPIO26, IN3 → GPIO25, IN4 → GPIO33, ENB → GPIO32
           remove the ENA/ENB jumper caps; 12V from a 2S Li-ion pack; L298N GND ↔ ESP32 GND
    HC-SR04: TRIG → GPIO5, ECHO → divider (1kΩ/2kΩ) → GPIO18, VCC 5V
    Headlight LED → GPIO4 (220Ω). Status LED = on-board GPIO2.
    Battery sense (optional): pack+ → 100kΩ → GPIO35 → 33kΩ → GND
*/
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>

// ============================== EDIT THESE ==============================
const char* WIFI_SSID     = "YOUR_WIFI";
const char* WIFI_PASSWORD = "YOUR_PASSWORD";
const char* HOSTNAME      = "sewersafe-robot";   // also reachable as http://sewersafe-robot.local
const int   STOP_CM       = 15;                   // refuse/stop forward closer than this
const uint32_t PULSE_MS   = 400;                  // forward/backward pulse length
const uint32_t TURN_MS    = 250;
const int   SPEED         = 200;                  // 0–255 PWM
const bool  HAS_BATTERY_SENSE = false;
// =======================================================================

const int ENA = 14, IN1 = 27, IN2 = 26, IN3 = 25, IN4 = 33, ENB = 32;
const int TRIG = 5, ECHO = 18, LED_HEAD = 4, LED_STATUS = 2, PIN_BAT = 35;
const int PWM_FREQ = 1000, PWM_BITS = 8;

WebServer server(80);
String state = "IDLE", lastCmd = "none";
bool moving = false, blocked = false, forwardMotion = false;
uint32_t stopAt = 0;
int lastDistance = -1;

// ---------- PWM that compiles on core 2.x (channels) and 3.x (pins)
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  void pwmSetup(int pin, int) { ledcAttach(pin, PWM_FREQ, PWM_BITS); }
  void pwmWrite(int pin, int, int duty) { ledcWrite(pin, duty); }
#else
  void pwmSetup(int pin, int ch) { ledcSetup(ch, PWM_FREQ, PWM_BITS); ledcAttachPin(pin, ch); }
  void pwmWrite(int, int ch, int duty) { ledcWrite(ch, duty); }
#endif

void motors(int left, int right) {           // -1 back, 0 stop, 1 forward
  digitalWrite(IN1, left > 0);  digitalWrite(IN2, left < 0);
  digitalWrite(IN3, right > 0); digitalWrite(IN4, right < 0);
  pwmWrite(ENA, 0, left ? SPEED : 0);
  pwmWrite(ENB, 1, right ? SPEED : 0);
  moving = left || right;
  digitalWrite(LED_HEAD, moving || state == "INSPECTING");
}

int distanceCm() {
  digitalWrite(TRIG, LOW); delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10); digitalWrite(TRIG, LOW);
  unsigned long us = pulseIn(ECHO, HIGH, 25000UL);        // ~4 m max
  lastDistance = us ? (int)(us / 58) : -1;                // -1 = nothing in range
  return lastDistance;
}

int batteryPct() {
  if (!HAS_BATTERY_SENSE) return -1;
  float v = analogReadMilliVolts(PIN_BAT) / 1000.0 * (133.0 / 33.0);   // divider 100k/33k
  return constrain((int)((v - 6.4) / (8.4 - 6.4) * 100), 0, 100);      // 2S Li-ion 6.4–8.4 V
}

void stopMotors(const char* why) {
  motors(0, 0);
  forwardMotion = false;
  if (why) state = why;
}

void sendStatus() {
  int d = lastDistance;
  String j = "{\"state\":\"" + state + "\",\"distance_cm\":" + String(d) + ",\"blocked\":" + (blocked ? "true" : "false")
           + ",\"moving\":" + (moving ? "true" : "false") + ",\"battery_pct\":" + (batteryPct() < 0 ? String("null") : String(batteryPct()))
           + ",\"last_cmd\":\"" + lastCmd + "\",\"uptime_ms\":" + String(millis()) + ",\"ip\":\"" + WiFi.localIP().toString() + "\"}";
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "application/json", j);
}

void handleCmd() {
  String c = server.arg("c");
  c.toLowerCase();
  lastCmd = c;
  int d = distanceCm();
  blocked = d >= 0 && d < STOP_CM;
  if (c == "forward") {
    if (blocked) { stopMotors("OBSTACLE"); }
    else { motors(1, 1); forwardMotion = true; state = "MOVING"; stopAt = millis() + PULSE_MS; }
  } else if (c == "backward") { motors(-1, -1); state = "RETURNING"; stopAt = millis() + PULSE_MS; }
  else if (c == "left")  { motors(-1, 1); state = "MOVING"; stopAt = millis() + TURN_MS; }
  else if (c == "right") { motors(1, -1); state = "MOVING"; stopAt = millis() + TURN_MS; }
  else if (c == "stop")  { stopMotors("IDLE"); }
  else { server.send(400, "application/json", "{\"error\":\"c must be forward|backward|left|right|stop\"}"); return; }
  sendStatus();
}

void setup() {
  Serial.begin(115200);
  int outs[] = {IN1, IN2, IN3, IN4, TRIG, LED_HEAD, LED_STATUS};
  for (int p : outs) pinMode(p, OUTPUT);
  pinMode(ECHO, INPUT);
  pwmSetup(ENA, 0); pwmSetup(ENB, 1);
  stopMotors("IDLE");

  WiFi.mode(WIFI_STA);
  WiFi.setHostname(HOSTNAME);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) { delay(300); Serial.print("."); digitalWrite(LED_STATUS, !digitalRead(LED_STATUS)); }
  Serial.printf("\nRobot ready: http://%s  (ROBOT_URL for .env)\n", WiFi.localIP().toString().c_str());
  digitalWrite(LED_STATUS, HIGH);
  if (MDNS.begin(HOSTNAME)) Serial.printf("also http://%s.local\n", HOSTNAME);

  server.on("/cmd", handleCmd);
  server.on("/status", [] { distanceCm(); blocked = lastDistance >= 0 && lastDistance < STOP_CM; sendStatus(); });
  server.on("/", [] { server.send(200, "text/plain", "SewerSafe robot. Use /status and /cmd?c=forward|backward|left|right|stop"); });
  server.begin();
}

void loop() {
  server.handleClient();
  if (moving && millis() >= stopAt) stopMotors(state == "RETURNING" ? "RETURNING" : "IDLE");  // pulse over
  static uint32_t lastCheck = 0;
  if (forwardMotion && millis() - lastCheck > 50) {                                        // collision guard
    lastCheck = millis();
    int d = distanceCm();
    if (d >= 0 && d < STOP_CM) { blocked = true; stopMotors("OBSTACLE"); }
  }
  if (WiFi.status() != WL_CONNECTED && moving) stopMotors("ERROR");                        // lost network → stop
}
