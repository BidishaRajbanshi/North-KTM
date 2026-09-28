// HTTP API + static dashboard. createApp() wires every service; server.js just calls listen().
const express = require("express");
const path = require("path");
const { loadConfig } = require("./config");
const { createStore } = require("./store");
const { createSimDriver, createEsp32Driver } = require("./robotDrivers");
const { createRobotService } = require("./robotService");
const { createChainService } = require("./chain");
const { createNotifier } = require("./notifier");
const { createSensorSim } = require("./sensorSim");
const { createSafetyService, httpErr } = require("./safety");

async function createApp(overrides = {}) {
  const cfg = loadConfig(overrides.config);
  const log = overrides.log || console;
  const store = overrides.store || (await createStore({ mongoUri: cfg.mongoUri, dataFile: cfg.dataFile }));

  const robotDriver = overrides.robotDriver || (cfg.robotDriver === "esp32"
    ? createEsp32Driver({ url: cfg.robotUrl, cameraUrl: cfg.cameraUrl, stepM: cfg.robotStepM })
    : createSimDriver({ stepM: cfg.robotStepM }));
  const robotEvents = [];
  const robot = createRobotService({ driver: robotDriver, stepMs: overrides.robotStepMs ?? cfg.robotStepDelayMs,
    segmentM: cfg.robotSegmentM, checkpointEveryM: cfg.robotCheckpointM,
    onEvent: (e) => { robotEvents.push(e); if (robotEvents.length > 200) robotEvents.shift();
      store.insert("robot_events", { id: `RE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ...e }).catch(() => {}); },
    readSewer: async (id) => { const s = safety && safety.sewers.get(id); return s && s.last_reading; } });

  const chain = overrides.chain || createChainService({ rpc: cfg.chainRpc, deploymentFile: cfg.deploymentFile,
    recorderKey: cfg.recorderKey || process.env.MST_PRIVATE_KEY || "", gatewayKey: cfg.gatewayKey, store, retryMs: cfg.chainRetryMs, log });
  const notifier = createNotifier({ store, webhookUrl: cfg.supervisorWebhook, log });

  let safety;
  const sim = createSensorSim({ sewers: cfg.sewers, intervalMs: cfg.simIntervalMs,
    onReading: (r) => safety.ingest(r, { source: "simulator" }) });
  safety = createSafetyService({ cfg, store, robot, robotDriver, chain, notifier, sim, log });
  await safety.init();

  // ------------------------------------------------------------------ express
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  // CORS: off by default (dashboard is served from this same server). Allow listed origins only.
  if (cfg.corsOrigins.length) {
    app.use((req, res, next) => {
      const o = req.headers.origin;
      if (o && cfg.corsOrigins.includes(o)) {
        res.set({ "Access-Control-Allow-Origin": o, "Vary": "Origin",
          "Access-Control-Allow-Headers": "content-type,x-api-key,x-operator-token", "Access-Control-Allow-Methods": "GET,POST" });
      }
      if (req.method === "OPTIONS") return res.sendStatus(204);
      next();
    });
  }

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const needDevice = (req, res, next) => (!cfg.deviceApiKey || req.get("x-api-key") === cfg.deviceApiKey)
    ? next() : next(httpErr(401, "UNAUTHORIZED", "Missing or wrong x-api-key (DEVICE_API_KEY)"));
  const needOperator = (req, res, next) => (!cfg.operatorToken || req.get("x-operator-token") === cfg.operatorToken)
    ? next() : next(httpErr(401, "UNAUTHORIZED", "Missing or wrong x-operator-token (OPERATOR_TOKEN)"));
  const body = (req, ...keys) => { for (const k of keys) if (req.body == null || req.body[k] === undefined || req.body[k] === "")
    throw httpErr(400, "VALIDATION_ERROR", `${k} is required`); return req.body; };

  // ---------------- health & dashboard
  app.get("/api/health", wrap(async (req, res) => res.json({ ok: true, db: store.kind, robot_driver: robotDriver.kind,
    sensors_simulated: cfg.simulateSensors, operator_auth: !!cfg.operatorToken, device_auth: !!cfg.deviceApiKey,
    chain: await chain.status() })));
  app.get("/api/dashboard", wrap(async (req, res) => res.json(await safety.dashboard())));

  // ---------------- sewers
  app.get("/api/sewers", wrap(async (req, res) => res.json((await safety.dashboard()).sewers)));
  app.get("/api/sewers/:id", wrap(async (req, res) => {
    const id = req.params.id.toUpperCase();
    const s = (await safety.dashboard()).sewers.find((x) => x.id === id);
    if (!s) throw httpErr(404, "NOT_FOUND", `No sewer ${id}`);
    const readings = (await store.list("readings", { filter: { sewer_id: id }, sort: { received_at: -1 }, limit: Math.min(Number(req.query.limit) || 60, 300) })).reverse();
    res.json({ ...s, readings });
  }));

  // ---------------- sensors & risk
  app.post("/api/sensors/data", needDevice, wrap(async (req, res) => {
    const r = await safety.ingest(req.body, { source: req.body && req.body.device_id ? "device" : "api" });
    if (!r.ok) throw httpErr(r.status, r.errors[0].code, r.errors[0].message, r.errors);
    res.status(201).json({ reading_id: r.reading.id, risk: r.risk, human_entry: r.human_entry,
      incident: r.incident ? r.incident.id : null, errors: r.errors, warnings: r.warnings });
  }));
  app.post("/api/risk/analyze", wrap(async (req, res) => {
    const r = safety.analyze(req.body);
    if (!r.ok) throw httpErr(r.status, r.errors[0].code, r.errors[0].message, r.errors);
    res.json({ ...r.risk, reading: r.reading, errors: r.errors, warnings: r.warnings });
  }));

  // ---------------- alerts
  app.get("/api/alerts", wrap(async (req, res) => {
    const filter = {};
    if (req.query.sewer_id) filter.sewer_id = String(req.query.sewer_id).toUpperCase();
    if (req.query.severity) filter.severity = String(req.query.severity).toUpperCase();
    res.json(await store.list("alerts", { filter, sort: { created_at: -1 }, limit: Math.min(Number(req.query.limit) || 50, 500) }));
  }));
  app.post("/api/alerts", needOperator, wrap(async (req, res) => {
    const b = body(req, "sewer_id", "severity", "message");
    const severity = String(b.severity).toUpperCase();
    if (!["INFO", "WARNING", "CRITICAL"].includes(severity)) throw httpErr(400, "VALIDATION_ERROR", "severity must be INFO, WARNING or CRITICAL");
    if (!safety.sewers.has(String(b.sewer_id).toUpperCase())) throw httpErr(404, "NOT_FOUND", `No sewer ${b.sewer_id}`);
    res.status(201).json(await safety.alert({ severity, sewer_id: String(b.sewer_id).toUpperCase(), kind: "MANUAL",
      message: String(b.message).slice(0, 300), action: b.action || "OPERATOR_REVIEW", hazards: b.hazards || [] }));
  }));
  app.post("/api/alerts/:id/ack", needOperator, wrap(async (req, res) => {
    const a = await store.update("alerts", req.params.id, { acknowledged: true, acknowledged_at: new Date().toISOString() });
    if (!a) throw httpErr(404, "NOT_FOUND", `No alert ${req.params.id}`);
    res.json(a);
  }));

  // ---------------- inspections & maintenance
  app.get("/api/inspections", wrap(async (req, res) => {
    const filter = req.query.sewer_id ? { sewer_id: String(req.query.sewer_id).toUpperCase() } : {};
    res.json(await store.list("inspections", { filter, sort: { created_at: -1 }, limit: Math.min(Number(req.query.limit) || 50, 500) }));
  }));
  app.get("/api/inspections/:id", wrap(async (req, res) => {
    const i = await store.get("inspections", req.params.id);
    if (!i) throw httpErr(404, "NOT_FOUND", `No inspection ${req.params.id}`);
    res.json({ ...i, chain_records: await store.list("chain_records", { filter: { inspection_id: i.id }, sort: { created_at: 1 } }) });
  }));
  app.post("/api/inspections", needOperator, wrap(async (req, res) => {
    const b = body(req, "sewer_id");
    res.status(201).json(await safety.manualInspection(b.sewer_id, b.reason));
  }));
  app.post("/api/inspections/:id/deploy", needOperator, wrap(async (req, res) => res.json(await safety.deployRobot(req.params.id))));
  app.get("/api/maintenance", wrap(async (req, res) => res.json(await store.list("maintenance", { sort: { created_at: -1 }, limit: 50 }))));
  app.post("/api/maintenance/:id/complete", needOperator, wrap(async (req, res) => res.json(await safety.completeMaintenance(req.params.id))));

  // ---------------- robot
  app.get("/api/robot/status", wrap(async (req, res) => res.json({ ...(await robot.refresh()), recent_events: robotEvents.slice(-20) })));
  app.post("/api/robot/command", needOperator, wrap(async (req, res) => {
    const b = body(req, "command");
    res.json(await robot.command(String(b.command).toLowerCase()));
  }));
  app.post("/api/robot/reset", needOperator, wrap(async (req, res) => res.json(await robot.reset())));

  // ---------------- blockchain
  app.get("/api/blockchain/status", wrap(async (req, res) => res.json(await chain.status())));
  app.get("/api/blockchain/records", wrap(async (req, res) => res.json(await store.list("chain_records", { sort: { created_at: -1 }, limit: 100 }))));
  app.post("/api/blockchain/record", needOperator, wrap(async (req, res) => {
    const b = body(req, "inspection_id");
    const ins = await store.get("inspections", b.inspection_id);
    if (!ins) throw httpErr(404, "NOT_FOUND", `No inspection ${b.inspection_id}`);
    const rec = await chain.recordInspection(ins);
    res.status(202).json(await safety.waitRecord(rec.id, Number(req.query.wait_ms) || 15000));
  }));
  app.get("/api/blockchain/inspection/:id", wrap(async (req, res) => {
    const ins = await store.get("inspections", req.params.id);
    if (!ins) throw httpErr(404, "NOT_FOUND", `No inspection ${req.params.id}`);
    const records = await store.list("chain_records", { filter: { inspection_id: ins.id }, sort: { created_at: 1 } });
    const v = await chain.verify(ins);
    const pending = records.some((r) => r.status === "PENDING");
    res.json({ inspection_id: ins.id, ...v, status: pending && v.status !== "VERIFIED" ? "PENDING_CONFIRMATION" : v.status, records });
  }));

  // ---------------- demo mode (for judges)
  app.post("/api/demo/critical", needOperator, wrap(async (req, res) => {
    const id = String((req.body && req.body.sewer_id) || "S103").toUpperCase();
    const s = safety.sewers.get(id);
    if (!s) throw httpErr(404, "NOT_FOUND", `No sewer ${id}`);
    if (s.active_inspection) throw httpErr(409, "ALREADY_ACTIVE", `${id} already has an active inspection (${s.active_inspection})`);
    if (robot.status().mode === "AUTO" && !robot.status().mission?.done) throw httpErr(409, "ROBOT_BUSY", "Robot is on a mission. Wait for it to return or reset it.");
    if (sim.isSimulated(id)) sim.forceHazard(id, 60000);
    // rising gas: normal → warning → critical, as a real sensor would report it
    const base = { sewer_id: id, device_id: "demo", water_level: 48, temperature: 31, humidity: 78 };
    const steps = [{ methane: 1400, combustible: 1100, air_quality: 170, oxygen: 20.3 },
                   { methane: 3800, combustible: 3000, air_quality: 260, oxygen: 19.8 },
                   { methane: 8600, combustible: 6900, air_quality: 380, oxygen: 18.4 }];
    let result, opened = null;
    const fitted = cfg.sewers.find((x) => x.id === id).sensors;
    const onlyFitted = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => fitted.includes(k)));   // no values from sensors that aren't installed
    for (const st of steps) {
      result = await safety.ingest({ sewer_id: id, device_id: "demo", ...onlyFitted({ ...base, ...st }), timestamp: new Date().toISOString() }, { source: "demo" });
      if (result.incident) opened = result.incident.id;
      await new Promise((r) => setTimeout(r, 400));
    }
    res.json({ sewer_id: id, risk: result.risk, human_entry: "BLOCKED", inspection_id: opened });
  }));
  app.post("/api/demo/entry-attempt", needOperator, wrap(async (req, res) =>
    res.json(await safety.entryAttempt(String((req.body && req.body.sewer_id) || "S103").toUpperCase(), "person attempted to enter (demo)"))));
  app.post("/api/demo/tamper", needOperator, wrap(async (req, res) => {
    const b = body(req, "inspection_id");
    const ins = await store.get("inspections", b.inspection_id);
    if (!ins) throw httpErr(404, "NOT_FOUND", `No inspection ${b.inspection_id}`);
    // what a cover-up looks like: someone edits the database to downgrade the hazard
    await store.update("inspections", ins.id, { risk_level: "WARNING", risk_score: 35, triggered_hazards: ["MINOR_ODOUR"], tampered_for_demo: true });
    res.json({ inspection_id: ins.id, changed: { risk_level: [ins.risk_level, "WARNING"], risk_score: [ins.risk_score, 35] },
      note: "Database edited. Verify it: the on-chain hash will no longer match." });
  }));
  app.post("/api/demo/reset", needOperator, wrap(async (req, res) => {
    for (const s of cfg.sewers) sim.clearHazard(s.id);
    res.json({ robot: await robot.reset() });
  }));

  // ---------------- dashboard (static) + errors
  app.use(express.static(path.join(cfg.root, "frontend"), { index: "index.html" }));
  app.use("/api", (req, res) => res.status(404).json({ error: { code: "NOT_FOUND", message: `No route ${req.method} ${req.originalUrl}` } }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === "entity.parse.failed" ? 400 : 500);
    const code = err.code && typeof err.code === "string" ? err.code : err.type === "entity.parse.failed" ? "INVALID_JSON" : "INTERNAL_ERROR";
    if (status >= 500) log.error?.("[api]", err);
    res.status(status).json({ error: { code, message: status >= 500 && code === "INTERNAL_ERROR" ? "Internal error" : err.message, details: err.details } });
  });

  let offlineTimer;
  return {
    app, cfg, store, robot, robotDriver, chain, safety, sim,
    async start() {
      await chain.start?.();
      if (cfg.simulateSensors) sim.start();
      offlineTimer = setInterval(() => safety.markOffline(), 5000);
    },
    async stop() {
      sim.stop(); clearInterval(offlineTimer); chain.stop?.();
      await robot.reset().catch(() => {});
      await store.close?.();
    },
  };
}

module.exports = { createApp };
