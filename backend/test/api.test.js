const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, until } = require("./helpers");

const now = () => new Date().toISOString();
const normal = (id = "S103") => ({ sewer_id: id, timestamp: now(), methane: 150, combustible: 120, air_quality: 60, oxygen: 20.8, water_level: 30, temperature: 29, humidity: 70 });
const critical = (id = "S103") => ({ ...normal(id), methane: 8600, combustible: 6900, air_quality: 380, oxygen: 18.4 });

test("API basics: health, sewers, sewer detail, 404s in the standard error shape", async () => {
  const t = await startTestServer();
  try {
    assert.equal((await t.call("GET", "/api/health")).body.ok, true);
    const sewers = (await t.call("GET", "/api/sewers")).body;
    assert.equal(sewers.length, 6);
    assert.ok(sewers.every((s) => s.status === "OFFLINE" && s.entry === "BLOCKED"), "no data yet = offline + blocked");
    assert.equal((await t.call("GET", "/api/sewers/s101")).body.id, "S101");
    const nf = await t.call("GET", "/api/sewers/S999");
    assert.equal(nf.status, 404);
    assert.equal(nf.body.error.code, "NOT_FOUND");
    assert.equal((await t.call("GET", "/api/nope")).status, 404);
  } finally { await t.close(); }
});

test("POST /api/sensors/data validates input", async () => {
  const t = await startTestServer();
  try {
    const ok = await t.call("POST", "/api/sensors/data", normal());
    assert.equal(ok.status, 201);
    assert.equal(ok.body.risk.risk_level, "SAFE");
    assert.equal(ok.body.human_entry, "ROBOT_FIRST");
    assert.equal((await t.call("POST", "/api/sensors/data", { ...normal(), sewer_id: "S999" })).status, 404);
    const stale = await t.call("POST", "/api/sensors/data", { ...normal(), timestamp: new Date(Date.now() - 3600e3).toISOString() });
    assert.equal(stale.status, 422);
    assert.equal(stale.body.error.code, "STALE_READING");
    const badJson = await t.call("POST", "/api/sensors/data", "{oops");
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, "INVALID_JSON");
    const partial = await t.call("POST", "/api/sensors/data", { ...normal(), oxygen: "garbage" });
    assert.equal(partial.status, 201);
    assert.ok(partial.body.risk.triggered_hazards.includes("SENSOR_FAULT"));
  } finally { await t.close(); }
});

test("device API key is enforced when DEVICE_API_KEY is set", async () => {
  const t = await startTestServer({ config: { deviceApiKey: "esp32-secret" } });
  try {
    assert.equal((await t.call("POST", "/api/sensors/data", normal())).status, 401);
    assert.equal((await t.call("POST", "/api/sensors/data", normal(), { "x-api-key": "esp32-secret" })).status, 201);
  } finally { await t.close(); }
});

test("operator token is enforced on control endpoints when OPERATOR_TOKEN is set", async () => {
  const t = await startTestServer({ config: { operatorToken: "op-123" } });
  try {
    assert.equal((await t.call("POST", "/api/robot/command", { command: "forward" })).status, 401);
    assert.equal((await t.call("POST", "/api/robot/command", { command: "forward" }, { "x-operator-token": "op-123" })).status, 200);
  } finally { await t.close(); }
});

test("POST /api/risk/analyze is stateless", async () => {
  const t = await startTestServer();
  try {
    const r = await t.call("POST", "/api/risk/analyze", critical());
    assert.equal(r.body.risk_level, "CRITICAL");
    assert.equal(r.body.recommended_action, "BLOCK_HUMAN_ENTRY_AND_DEPLOY_ROBOT");
    assert.equal((await t.call("GET", "/api/inspections")).body.length, 0, "analyze must not create records");
  } finally { await t.close(); }
});

test("WARNING creates one warning alert (not one per reading)", async () => {
  const t = await startTestServer();
  try {
    for (let i = 0; i < 3; i++) await t.call("POST", "/api/sensors/data", { ...normal(), methane: 2500 });
    const alerts = (await t.call("GET", "/api/alerts?severity=WARNING")).body;
    assert.equal(alerts.length, 1);
    assert.equal((await t.call("GET", "/api/inspections")).body.length, 0);
  } finally { await t.close(); }
});

test("robot API: status, valid and invalid commands", async () => {
  const t = await startTestServer();
  try {
    assert.equal((await t.call("GET", "/api/robot/status")).body.state, "IDLE");
    const fwd = await t.call("POST", "/api/robot/command", { command: "forward" });
    assert.equal(fwd.body.state, "MOVING");
    assert.equal((await t.call("POST", "/api/robot/command", { command: "fly" })).status, 400);
    assert.equal((await t.call("POST", "/api/robot/command", {})).status, 400);
    assert.equal((await t.call("POST", "/api/robot/command", { command: "stop" })).body.state, "IDLE");
  } finally { await t.close(); }
});

test("alerts API: create (validated), list, acknowledge", async () => {
  const t = await startTestServer();
  try {
    assert.equal((await t.call("POST", "/api/alerts", { sewer_id: "S101" })).status, 400);
    assert.equal((await t.call("POST", "/api/alerts", { sewer_id: "S101", severity: "LOUD", message: "x" })).status, 400);
    const a = await t.call("POST", "/api/alerts", { sewer_id: "S101", severity: "warning", message: "Cover reported damaged" });
    assert.equal(a.status, 201);
    assert.equal((await t.call("POST", `/api/alerts/${a.body.id}/ack`)).body.acknowledged, true);
    assert.equal((await t.call("GET", "/api/alerts?sewer_id=S101")).body.length, 1);
  } finally { await t.close(); }
});

test("CRITICAL → HUMAN ENTRY BLOCKED → alert → robot → inspection → DB → blockchain (fake chain)", async () => {
  const t = await startTestServer();
  try {
    const r = await t.call("POST", "/api/sensors/data", critical());
    assert.equal(r.body.risk.risk_level, "CRITICAL");
    assert.equal(r.body.human_entry, "BLOCKED");
    const insId = r.body.incident;
    assert.ok(insId, "inspection opened");

    const alerts = (await t.call("GET", "/api/alerts?severity=CRITICAL")).body;
    assert.match(alerts[0].message, /HUMAN ENTRY BLOCKED/);
    assert.equal((await t.store.list("notifications")).length, 1, "supervisor notified");

    const done = await until(async () => { const i = (await t.call("GET", `/api/inspections/${insId}`)).body; return i.status !== "OPEN" && i; });
    assert.equal(done.status, "COMPLETED");
    assert.equal(done.robot_status, "COMPLETED");
    assert.ok(done.findings.obstacle, "robot found the blockage");
    assert.equal(done.maintenance_status, "REQUIRED");
    const kinds = done.chain_records.map((c) => c.kind);
    for (const k of ["HAZARD", "ROBOT_DEPLOYMENT", "INSPECTION", "POST_JOB"]) assert.ok(kinds.includes(k), `missing ${k} in ${kinds}`);

    const v = await t.call("GET", `/api/blockchain/inspection/${insId}`);
    assert.equal(v.body.status, "VERIFIED");

    // the same sewer staying critical doesn't open a second incident while one is active
    const again = await t.call("POST", "/api/sensors/data", critical());
    assert.equal(again.body.incident, null);
  } finally { await t.close(); }
});

test("tampering with the database is detected by verification", async () => {
  const t = await startTestServer();
  try {
    const insId = (await t.call("POST", "/api/sensors/data", critical())).body.incident;
    await until(async () => (await t.call("GET", `/api/inspections/${insId}`)).body.status !== "OPEN");
    assert.equal((await t.call("GET", `/api/blockchain/inspection/${insId}`)).body.status, "VERIFIED");
    await t.call("POST", "/api/demo/tamper", { inspection_id: insId });
    assert.equal((await t.call("GET", `/api/blockchain/inspection/${insId}`)).body.status, "MISMATCH");
  } finally { await t.close(); }
});

test("maintenance is paid through escrow only after a robot run proves the blockage is cleared", async () => {
  const t = await startTestServer();
  try {
    const insId = (await t.call("POST", "/api/sensors/data", critical())).body.incident;
    const m = await until(async () => { const l = (await t.call("GET", "/api/maintenance")).body; return l[0] && l[0].escrow.job_id && l[0]; });
    assert.equal(m.inspection_id, insId);
    assert.equal((await t.call("POST", `/api/maintenance/${m.id}/complete`)).status, 200);
    const fin = await until(async () => { const x = (await t.call("GET", "/api/maintenance")).body[0]; return x.status === "COMPLETED" && x.escrow.status === "PAID" && x; });
    assert.ok(fin.evidence_hash);
    assert.equal((await t.call("GET", `/api/inspections/${insId}`)).body.maintenance_status, "COMPLETED");
    assert.equal((await t.call("POST", `/api/maintenance/${m.id}/complete`)).status, 409);
  } finally { await t.close(); }
});

test("entry attempt while blocked: critical alert + escrow job forfeited", async () => {
  const t = await startTestServer();
  try {
    (await t.call("POST", "/api/sensors/data", critical()));
    await until(async () => { const l = (await t.call("GET", "/api/maintenance")).body; return l[0] && l[0].escrow.job_id; });
    const r = await t.call("POST", "/api/demo/entry-attempt", { sewer_id: "S103" });
    assert.equal(r.body.alert.kind, "ENTRY_ATTEMPT");
    assert.equal(r.body.forfeited_jobs.length, 1);
    const m = await until(async () => { const x = (await t.call("GET", "/api/maintenance")).body[0]; return x.escrow.status === "SLASHED" && x; });
    assert.equal(m.status, "CANCELLED_HUMAN_ENTRY");
  } finally { await t.close(); }
});

test("cover opened (tilt) on a blocked manhole raises an entry-attempt alert", async () => {
  const t = await startTestServer({ robotStepMs: 20 });
  try {
    await t.call("POST", "/api/sensors/data", { ...critical("S101"), tilt: 2 });
    await t.call("POST", "/api/sensors/data", { ...critical("S101"), tilt: 75 });
    const alerts = (await t.call("GET", "/api/alerts?sewer_id=S101")).body;
    assert.ok(alerts.some((a) => a.kind === "ENTRY_ATTEMPT"));
  } finally { await t.close(); }
});

test("demo endpoint runs the whole critical scenario", async () => {
  const t = await startTestServer();
  try {
    const r = await t.call("POST", "/api/demo/critical", { sewer_id: "S105" });
    assert.equal(r.body.risk.risk_level, "CRITICAL");
    assert.equal(r.body.human_entry, "BLOCKED");
    const ins = await until(async () => { const i = (await t.call("GET", `/api/inspections/${r.body.inspection_id}`)).body; return i.status === "COMPLETED" && i; });
    assert.ok(ins.chain_records.length >= 3);
    const d = (await t.call("GET", "/api/dashboard")).body;
    assert.ok(d.overview.total === 6 && d.alerts.length >= 1 && d.inspections.length === 1);
    assert.equal((await t.call("POST", "/api/demo/critical", { sewer_id: "S999" })).status, 404);
  } finally { await t.close(); }
});
