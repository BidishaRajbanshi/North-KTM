const test = require("node:test");
const assert = require("node:assert/strict");
const { createSimDriver, createEsp32Driver } = require("../robotDrivers");
const { createRobotService } = require("../robotService");

const fast = (opts = {}) => {
  const events = [];
  const svc = createRobotService({ driver: createSimDriver(opts.driver), stepMs: 1, onEvent: (e) => events.push(e),
    readSewer: async () => ({ methane: 8000, combustible: 6000, air_quality: 350, oxygen: 18.4 }), ...opts.svc });
  return { svc, events };
};

test("robot commands: forward/left/right/backward/stop change state and position", async () => {
  const { svc } = fast();
  let s = await svc.command("forward");
  assert.equal(s.state, "MOVING");
  assert.equal(s.telemetry.position_m, 0.5);
  s = await svc.command("right");
  assert.equal(s.telemetry.heading_deg, 15);
  s = await svc.command("backward");
  assert.equal(s.state, "RETURNING");
  s = await svc.command("stop");
  assert.equal(s.state, "IDLE");
});

test("invalid command is rejected with 400", async () => {
  const { svc } = fast();
  await assert.rejects(svc.command("jump"), (e) => e.status === 400);
});

test("deployment mission: MOVING → INSPECTING → OBSTACLE → RETURNING → COMPLETED", async () => {
  const { svc, events } = fast();
  const { promise } = svc.deploy({ sewerId: "S101", inspectionId: "INS-1" });
  const result = await promise;
  const seq = events.filter((e) => e.type === "ROBOT_STATE").map((e) => e.to);
  for (const st of ["MOVING", "INSPECTING", "OBSTACLE", "RETURNING", "COMPLETED"]) assert.ok(seq.includes(st), `missing ${st} in ${seq}`);
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.obstacle.type, "silt and debris blockage");
  assert.ok(result.obstacle.position_m > 6 && result.obstacle.position_m < 6.5);
  assert.ok(result.checkpoints.length >= 3);
  assert.equal(svc.status().telemetry.position_m, 0);          // back at the manhole
});

test("mission with no obstacle travels the full segment", async () => {
  const { svc } = fast({ driver: { obstacles: [] } });
  const r = await svc.deploy({ sewerId: "S101", inspectionId: "INS-2" }).promise;
  assert.equal(r.status, "COMPLETED");
  assert.equal(r.obstacle, null);
  assert.ok(r.reached_m >= 10);
});

test("second deployment while busy is refused with 409", async () => {
  const { svc } = fast({ svc: { stepMs: 5 } });
  const first = svc.deploy({ sewerId: "S101", inspectionId: "A" });
  assert.throws(() => svc.deploy({ sewerId: "S102", inspectionId: "B" }), (e) => e.status === 409);
  await first.promise;
});

test("operator can take over a mission (manual override aborts it)", async () => {
  const { svc } = fast({ svc: { stepMs: 20 } });
  const { promise } = svc.deploy({ sewerId: "S101", inspectionId: "C" });
  await new Promise((r) => setTimeout(r, 30));
  const s = await svc.command("stop");
  const r = await promise;
  assert.equal(r.status, "ABORTED");
  assert.equal(s.mode, "MANUAL");
});

test("driver failure → ERROR state, mission FAILED (never hangs)", async () => {
  const broken = { kind: "esp32", cameraUrl: null, send: async () => { throw new Error("ECONNREFUSED"); }, telemetry: async () => { throw new Error("x"); } };
  const svc = createRobotService({ driver: broken, stepMs: 1 });
  const r = await svc.deploy({ sewerId: "S101", inspectionId: "D" }).promise;
  assert.equal(r.status, "FAILED");
  assert.equal(svc.status().state, "ERROR");
});

test("ESP32 driver speaks the firmware's HTTP API", async () => {
  const calls = [];
  const fakeFetch = async (url) => { calls.push(url); return { ok: true, json: async () => ({ state: "MOVING", distance_cm: 80, blocked: false, battery_pct: 88 }) }; };
  const d = createEsp32Driver({ url: "http://192.168.1.50/", fetchImpl: fakeFetch });
  const t = await d.send("forward");
  assert.equal(calls[0], "http://192.168.1.50/cmd?c=forward");
  assert.equal(t.obstacle_cm, 80);
  assert.equal(t.position_m, 0.1);          // default ESP32 pulse ≈ 10 cm on a table-top model
  await d.telemetry();
  assert.equal(calls[1], "http://192.168.1.50/status");
});

test("sim and ESP32 drivers expose the same interface", () => {
  const core = ["cameraUrl", "kind", "reset", "send", "telemetry"];
  const a = Object.keys(createSimDriver());
  const b = Object.keys(createEsp32Driver({ url: "http://x", fetchImpl: async () => ({}) }));
  for (const k of core) { assert.ok(a.includes(k), "sim missing " + k); assert.ok(b.includes(k), "esp32 missing " + k); }
});
