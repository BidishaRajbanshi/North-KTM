// The ESP32 path over real HTTP: backend with ROBOT_DRIVER=esp32 driving a server that speaks
// the firmware's exact protocol, and a sensor reading in the firmware's exact JSON.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, until } = require("./helpers");
const { createEsp32Driver } = require("../robotDrivers");
const { createFakeRobot } = require("../../tools/fake-esp32-robot");

test("ESP32 path: firmware-format reading → CRITICAL → robot mission over HTTP → obstacle found", async () => {
  const fake = createFakeRobot({ obstacleCm: 120, stepCm: 10 });
  await new Promise((r) => fake.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${fake.server.address().port}`;
  const t = await startTestServer({ robotStepMs: 2, robotDriver: createEsp32Driver({ url, stepM: 0.1 }),
    config: { robotSegmentM: 2, robotCheckpointM: 0.5 } });
  try {
    // exactly what esp32_sensor_node.ino sends (no oxygen sensor fitted, tilt from MPU6050)
    const firmwareBody = { sewer_id: "S101", device_id: "esp32-node-1", timestamp: new Date().toISOString(),
      methane: 8900.4, combustible: 6600.2, air_quality: 391.7, water_level: 51.8, temperature: 28.9, humidity: 72.3, tilt: 1.9 };
    const r = await t.call("POST", "/api/sensors/data", firmwareBody);
    assert.equal(r.status, 201);
    assert.equal(r.body.risk.risk_level, "CRITICAL");
    assert.ok(!r.body.risk.triggered_hazards.includes("SENSOR_FAULT"), "no O2 fitted on S101 must not be a fault");
    const ins = await until(async () => { const i = (await t.call("GET", `/api/inspections/${r.body.incident}`)).body; return i.status !== "OPEN" && i; }, 10000);
    assert.equal(ins.status, "COMPLETED");
    assert.equal(ins.robot_status, "COMPLETED");
    assert.ok(ins.findings.obstacle, "robot stopped at the obstacle");
    assert.ok(ins.findings.obstacle.position_m >= 1.0 && ins.findings.obstacle.position_m <= 1.2, `obstacle at ${ins.findings.obstacle.position_m} m`);
    // no wheel encoders: return is by pulse count, so allow one pulse of error (documented limitation)
    assert.ok(fake.pos <= 10, `robot back within one pulse of the manhole (at ${fake.pos} cm)`);
  } finally { await t.close(); fake.server.close(); }
});

test("ESP32 path: robot offline → mission FAILED, entry stays BLOCKED, warning alert", async () => {
  const t = await startTestServer({ robotStepMs: 2, robotDriver: createEsp32Driver({ url: "http://127.0.0.1:9", timeoutMs: 300 }) });
  try {
    const r = await t.call("POST", "/api/sensors/data", { sewer_id: "S101", methane: 9000, combustible: 7000, air_quality: 390, water_level: 40, temperature: 29, humidity: 70, tilt: 1 });
    const ins = await until(async () => { const i = (await t.call("GET", `/api/inspections/${r.body.incident}`)).body; return i.status !== "OPEN" && i; }, 10000);
    assert.equal(ins.status, "FAILED");
    assert.equal(ins.robot_status, "FAILED");
    const s = (await t.call("GET", "/api/sewers/S101")).body;
    assert.equal(s.entry, "BLOCKED");
    const alerts = (await t.call("GET", "/api/alerts?sewer_id=S101")).body;
    assert.ok(alerts.some((a) => a.kind === "ROBOT" && /failed/.test(a.message)));
  } finally { await t.close(); }
});
