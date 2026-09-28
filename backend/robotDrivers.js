// Robot drivers. Both expose the SAME interface, so the robot service can't tell them apart:
//   await driver.send(cmd)     cmd ∈ forward | backward | left | right | stop   → telemetry
//   await driver.telemetry()                                                  → telemetry
//   driver.kind, driver.cameraUrl
// telemetry = { connected, position_m, obstacle_cm, blocked, battery_pct, heading_deg }

const COMMANDS = ["forward", "backward", "left", "right", "stop"];
const STEP_M = 0.5;          // one "forward" pulse moves ~0.5 m (sim) — tune for your chassis
const STOP_CM = 15;          // firmware refuses to drive forward closer than this to an obstacle

/** Simulated robot in a straight pipe with an obstacle. Behaves like the ESP32 firmware. */
function createSimDriver({ obstacles = [{ at_m: 6.5, type: "silt and debris blockage" }], battery = 96, stepM = STEP_M } = {}) {
  const s = { position_m: 0, heading_deg: 0, battery_pct: battery };
  const nextObstacle = () => obstacles.filter((o) => o.at_m > s.position_m).sort((a, b) => a.at_m - b.at_m)[0];

  function telemetry() {
    const o = nextObstacle();
    const obstacle_cm = o ? Math.round((o.at_m - s.position_m) * 100) : null;
    return { connected: true, position_m: Math.round(s.position_m * 100) / 100, heading_deg: s.heading_deg,
      obstacle_cm: obstacle_cm !== null && obstacle_cm <= 200 ? obstacle_cm : null,
      obstacle_type: o && obstacle_cm <= 200 ? o.type : null,
      blocked: obstacle_cm !== null && obstacle_cm <= STOP_CM, battery_pct: Math.round(s.battery_pct) };
  }

  return {
    kind: "sim",
    cameraUrl: null,
    async send(cmd) {
      if (!COMMANDS.includes(cmd)) throw new Error(`unknown command ${cmd}`);
      if (cmd === "forward") {
        const o = nextObstacle();
        const limit = o ? o.at_m - STOP_CM / 100 : Infinity;
        s.position_m = Math.min(s.position_m + stepM, limit);
      }
      if (cmd === "backward") s.position_m = Math.max(0, s.position_m - stepM);
      if (cmd === "left") s.heading_deg = (s.heading_deg + 345) % 360;
      if (cmd === "right") s.heading_deg = (s.heading_deg + 15) % 360;
      if (cmd !== "stop") s.battery_pct = Math.max(0, s.battery_pct - 0.15);
      return telemetry();
    },
    async telemetry() { return telemetry(); },
    reset() { s.position_m = 0; s.heading_deg = 0; },
    /** Simulate the blockage being cleared (maintenance done). */
    clearObstacles() { obstacles = []; },
    restoreObstacles(list = [{ at_m: 6.5, type: "silt and debris blockage" }]) { obstacles = list; },
  };
}

/** Real ESP32 robot running firmware/esp32_robot. Talks HTTP on the local Wi-Fi. */
function createEsp32Driver({ url, cameraUrl = "", timeoutMs = 2500, fetchImpl = globalThis.fetch, stepM = 0.1 }) {
  if (!url) throw new Error("ROBOT_URL is not set (e.g. http://192.168.1.50)");
  const base = url.replace(/\/$/, "");
  let position_m = 0;                              // no wheel encoders: estimate from pulses

  async function get(pathname) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(base + pathname, { signal: ctl.signal });
      if (!res.ok) throw new Error(`robot HTTP ${res.status}`);
      return await res.json();
    } finally { clearTimeout(t); }
  }
  const norm = (j) => ({ connected: true, position_m: Math.round(position_m * 100) / 100, heading_deg: 0,
    obstacle_cm: typeof j.distance_cm === "number" && j.distance_cm >= 0 && j.distance_cm <= 200 ? j.distance_cm : null,
    obstacle_type: null, blocked: !!j.blocked, battery_pct: typeof j.battery_pct === "number" ? j.battery_pct : null });

  return {
    kind: "esp32",
    stepM,
    cameraUrl: cameraUrl || null,
    async send(cmd) {
      if (!COMMANDS.includes(cmd)) throw new Error(`unknown command ${cmd}`);
      const j = await get(`/cmd?c=${cmd}`);
      // no wheel encoders: position is estimated by counting pulses (rounded to whole cm)
      if (cmd === "forward" && !j.blocked) position_m = Math.round((position_m + stepM) * 100) / 100;
      if (cmd === "backward") position_m = Math.max(0, Math.round((position_m - stepM) * 100) / 100);
      return norm(j);
    },
    async telemetry() { return norm(await get("/status")); },
    reset() { position_m = 0; },
  };
}

module.exports = { createSimDriver, createEsp32Driver, COMMANDS, STEP_M, STOP_CM };
