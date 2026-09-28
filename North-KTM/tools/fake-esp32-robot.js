// Fake ESP32 ROBOT: speaks exactly the same HTTP API as firmware/esp32_robot.
// Use it to test ROBOT_DRIVER=esp32 without hardware:
//   node tools/fake-esp32-robot.js            → http://127.0.0.1:8081
//   .env: ROBOT_DRIVER=esp32  ROBOT_URL=http://127.0.0.1:8081
const http = require("http");

function createFakeRobot({ obstacleCm = 150, stopCm = 15, stepCm = 10 } = {}) {
  let pos = 0, state = "IDLE", lastCmd = "none", moving = false;
  const distance = () => (obstacleCm == null ? -1 : Math.max(0, obstacleCm - pos));
  const blocked = () => distance() >= 0 && distance() < stopCm;
  const status = () => ({ state, distance_cm: distance(), blocked: blocked(), moving, battery_pct: null, last_cmd: lastCmd, uptime_ms: Math.round(process.uptime() * 1000), ip: "127.0.0.1" });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (url.pathname === "/status") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(status())); }
    if (url.pathname === "/cmd") {
      const c = String(url.searchParams.get("c") || "").toLowerCase();
      lastCmd = c;
      if (c === "forward") { if (blocked()) state = "OBSTACLE"; else { pos = Math.min(pos + stepCm, obstacleCm == null ? Infinity : obstacleCm - stopCm + 1); state = "MOVING"; } }
      else if (c === "backward") { pos = Math.max(0, pos - stepCm); state = "RETURNING"; }
      else if (c === "left" || c === "right") state = "MOVING";
      else if (c === "stop") state = "IDLE";
      else { res.statusCode = 400; return res.end('{"error":"c must be forward|backward|left|right|stop"}'); }
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(status()));
    }
    res.end("SewerSafe robot (FAKE). Use /status and /cmd?c=...");
  });
  return { server, get pos() { return pos; }, clearObstacle() { obstacleCm = null; } };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8081);
  createFakeRobot().server.listen(port, "0.0.0.0", () => console.log(`fake ESP32 robot on http://127.0.0.1:${port}  (obstacle at 150 cm)`));
}
module.exports = { createFakeRobot };
