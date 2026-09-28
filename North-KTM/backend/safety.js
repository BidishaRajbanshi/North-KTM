// The safety pipeline:  SENSE → DECIDE → ACT → TRUST
//   reading → validate → risk → (CRITICAL) block entry → alert → notify → robot → inspection → DB → blockchain
const { validateReading } = require("./validation");
const { analyzeRisk } = require("./risk");
const { ethers } = require("ethers");

const pad = (n, w = 4) => String(n).padStart(w, "0");

function createSafetyService({ cfg, store, robot, robotDriver, chain, notifier, sim, log = console, now = () => new Date() }) {
  const sewers = new Map();          // live state per sewer (also persisted)
  let seq = 0;
  const iso = () => now().toISOString();
  const newId = (prefix) => { const d = now(); seq = (seq + 1) % 10000;
    return `${prefix}-${d.toISOString().slice(0, 10).replace(/-/g, "")}-${pad(d.getUTCHours() * 100 + d.getUTCMinutes())}${pad(seq)}`; };

  async function init() {
    for (const s of cfg.sewers) {
      const saved = await store.get("sewers", s.id);
      const state = { id: s.id, name: s.name, location: s.location, depth_m: s.depth_m, device: s.device, sensors: s.sensors,
        status: "OFFLINE", risk: null, entry: "BLOCKED", last_reading: null, last_update: null,
        active_inspection: null, ...(saved ? { last_reading: saved.last_reading, last_update: saved.last_update, risk: saved.risk,
          active_inspection: saved.active_inspection } : {}) };
      sewers.set(s.id, state);
      await store.upsert("sewers", state);
    }
    // any mission interrupted by a restart can't resume; close it honestly
    for (const ins of await store.list("inspections", { filter: { status: "OPEN" } })) {
      if (ins.robot_status === "DEPLOYED") {
        await store.update("inspections", ins.id, { robot_status: "ABORTED", status: "FAILED", findings: { note: "server restarted during mission" } });
        const s = sewers.get(ins.sewer_id); if (s) s.active_inspection = null;
      }
    }
  }

  // ---------------------------------------------------------------- alerts & notifications
  async function alert({ severity, sewer_id, hazards = [], action, message, inspection_id = null, kind = "HAZARD" }) {
    const a = { id: newId("ALT"), severity, sewer_id, hazards, action, message, kind, inspection_id,
      created_at: iso(), acknowledged: false };
    await store.insert("alerts", a);
    if (severity === "CRITICAL") await notifier.notify(a);
    return a;
  }

  // ---------------------------------------------------------------- SENSE + DECIDE
  async function ingest(raw, { source = "device" } = {}) {
    const v = validateReading(raw, { sewers: cfg.sewers, thresholds: cfg.thresholds, now: now() });
    if (!v.ok) return v;
    const sewer = sewers.get(v.reading.sewer_id);
    const conf = cfg.sewers.find((s) => s.id === sewer.id);
    const risk = analyzeRisk(v.reading, cfg.thresholds, conf);
    const reading = { id: newId("RD"), ...v.reading, source, risk_level: risk.risk_level, risk_score: risk.risk_score };
    await store.insert("readings", reading);

    const prev = sewer.risk ? sewer.risk.risk_level : null;
    const prevFault = sewer.risk ? sewer.risk.triggered_hazards.includes("SENSOR_FAULT") : false;
    Object.assign(sewer, { status: risk.risk_level, risk, last_reading: reading, last_update: reading.received_at });
    sewer.entry = sewer.active_inspection ? "BLOCKED" : risk.human_entry;
    await store.upsert("sewers", sewer);

    // one incident per critical episode: reopen only after the sewer has dropped below CRITICAL
    if (risk.risk_level !== "CRITICAL") sewer.critical_episode = false;
    let incident = null;
    if (risk.risk_level === "CRITICAL" && !sewer.active_inspection && !sewer.critical_episode) {
      incident = await openIncident(sewer, reading, risk, "AUTOMATIC");
    } else if (risk.risk_level === "WARNING" && prev !== "WARNING" && prev !== "CRITICAL" && !sewer.active_inspection) {
      await alert({ severity: "WARNING", sewer_id: sewer.id, hazards: risk.triggered_hazards, action: risk.recommended_action,
        message: `${sewer.id}: ${risk.triggered_hazards.join(", ")}. Entry restricted; robot inspection recommended.` });
    }
    if (risk.triggered_hazards.includes("SENSOR_FAULT") && !prevFault) {
      await alert({ severity: "WARNING", sewer_id: sewer.id, kind: "SENSOR_FAULT", action: "NO_ENTRY_UNTIL_SENSORS_RESTORED",
        hazards: ["SENSOR_FAULT"], message: `${sewer.id}: no data from ${v.missing_sensors.join(", ")}. Treat as unsafe.` });
    }
    if (risk.cover_open && sewer.entry === "BLOCKED") await entryAttempt(sewer.id, "manhole cover opened (tilt sensor)");

    return { ...v, reading, risk, sewer_status: sewer.status, human_entry: sewer.entry, incident };
  }

  // ---------------------------------------------------------------- ACT
  async function openIncident(sewer, reading, risk, trigger) {
    const ins = { id: newId("INS"), sewer_id: sewer.id, sewer_name: sewer.name, location: sewer.location, created_at: iso(),
      trigger, risk_level: risk.risk_level, risk_score: risk.risk_score, triggered_hazards: risk.triggered_hazards,
      recommended_action: risk.recommended_action,
      trigger_reading: reading && { methane: reading.methane, combustible: reading.combustible, air_quality: reading.air_quality,
        h2s: reading.h2s, oxygen: reading.oxygen, water_level: reading.water_level, temperature: reading.temperature, timestamp: reading.timestamp },
      human_entry: "BLOCKED", status: "OPEN", robot_status: "NONE", robot_id: null, findings: null,
      maintenance_status: "NONE", maintenance: null, entry_attempts: [], completed_at: null };
    await store.insert("inspections", ins);
    sewer.active_inspection = ins.id;
    sewer.critical_episode = risk.risk_level === "CRITICAL";
    sewer.entry = "BLOCKED";
    await store.upsert("sewers", sewer);

    await alert({ severity: "CRITICAL", sewer_id: sewer.id, hazards: risk.triggered_hazards, action: risk.recommended_action,
      inspection_id: ins.id, message: `${sewer.id} CRITICAL (score ${risk.risk_score}): HUMAN ENTRY BLOCKED. Robot deployment started.` });
    await chain.recordHazard(ins);
    await deployRobot(ins.id);
    return store.get("inspections", ins.id);
  }

  async function deployRobot(inspectionId) {
    const ins = await store.get("inspections", inspectionId);
    if (!ins) throw httpErr(404, "NOT_FOUND", `No inspection ${inspectionId}`);
    let started;
    try {
      started = robot.deploy({ sewerId: ins.sewer_id, inspectionId: ins.id });
    } catch (e) {
      if (e.status === 409) {
        await store.update("inspections", ins.id, { robot_status: "QUEUED" });
        await alert({ severity: "WARNING", sewer_id: ins.sewer_id, inspection_id: ins.id, kind: "ROBOT",
          action: "DEPLOY_WHEN_AVAILABLE", message: `Robot busy: ${ins.id} waiting. Entry stays blocked.` });
        return store.get("inspections", ins.id);
      }
      throw e;
    }
    const robotId = robot.status().robot_id;
    const deployedAt = iso();
    await store.update("inspections", ins.id, { robot_status: "DEPLOYED", robot_id: robotId, robot_deployed_at: deployedAt });
    await chain.recordRobotDeployment(ins, robotId);
    ins._mission = started.promise.then((result) => missionDone(ins.id, result)).catch((e) => log.error?.("[mission]", e));
    missions.set(ins.id, ins._mission);
    return store.get("inspections", ins.id);
  }

  async function missionDone(inspectionId, result) {
    const ins = await store.get("inspections", inspectionId);
    const robotStatus = result.status === "COMPLETED" ? "COMPLETED" : result.status === "FAILED" ? "FAILED" : "ABORTED";
    const needsMaint = !!result.obstacle;
    const findings = { note: result.note, reached_m: result.reached_m, obstacle: result.obstacle,
      checkpoints: result.checkpoints.map((c) => ({ label: c.label, position_m: c.position_m, at: c.at, gas: c.gas })) };
    const patch = { robot_status: robotStatus, findings, completed_at: iso(),
      status: robotStatus === "COMPLETED" ? "COMPLETED" : "FAILED",
      maintenance_status: robotStatus !== "COMPLETED" ? "NONE" : needsMaint ? "REQUIRED" : "NOT_REQUIRED" };
    await store.update("inspections", inspectionId, patch);
    await store.insert("robot_events", { id: newId("RBT"), type: "MISSION_RESULT", inspection_id: inspectionId, ...result, log: undefined, at: iso() });
    const updated = await store.get("inspections", inspectionId);
    await chain.recordInspection(updated);

    const sewer = sewers.get(ins.sewer_id);
    if (sewer && sewer.active_inspection === inspectionId) {
      sewer.active_inspection = null;
      sewer.entry = sewer.risk ? sewer.risk.human_entry : "BLOCKED";
      await store.upsert("sewers", sewer);
    }
    if (robotStatus !== "COMPLETED") {
      await alert({ severity: "WARNING", sewer_id: ins.sewer_id, inspection_id: inspectionId, kind: "ROBOT",
        action: "CHECK_ROBOT", message: `Robot mission ${robotStatus.toLowerCase()}: ${result.note}. Entry stays blocked.` });
    }
    if (needsMaint && robotStatus === "COMPLETED") await openMaintenance(updated);
    return updated;
  }

  // ---------------------------------------------------------------- maintenance paid via robot-verified escrow
  async function openMaintenance(ins) {
    const o = ins.findings.obstacle;
    const m = { id: newId("MNT"), inspection_id: ins.id, sewer_id: ins.sewer_id, created_at: iso(), status: "OPEN",
      task: `Clear ${o.type} at ${o.position_m} m using a jetting machine or cleaning robot. No manual entry.`,
      escrow: { payment_mstc: cfg.maintenancePayment || "1", job_id: null, status: "POSTING", tx: null }, completed_at: null };
    await store.insert("maintenance", m);
    const rec = await chain.postJob(ins, m.escrow.payment_mstc);
    waitRecord(rec.id).then(async (done) => {
      const cur = await store.get("maintenance", m.id);
      const job = done && done.status === "CONFIRMED" ? done.result.job_id : null;
      await store.update("maintenance", m.id, { escrow: { ...cur.escrow, job_id: job, status: job ? "ESCROWED" : "NOT_POSTED", tx: done && done.tx_hash } });
    });
    return m;
  }

  async function completeMaintenance(maintId) {
    const m = await store.get("maintenance", maintId);
    if (!m) throw httpErr(404, "NOT_FOUND", `No maintenance ${maintId}`);
    if (m.status !== "OPEN") throw httpErr(409, "BAD_STATE", `Maintenance is ${m.status}`);
    await store.update("maintenance", maintId, { status: "IN_PROGRESS", started_at: iso() });
    if (robotDriver.clearObstacles) robotDriver.clearObstacles();       // simulator: the jetting run clears the blockage
    let run;
    try { run = robot.deploy({ sewerId: m.sewer_id, inspectionId: maintId }); }
    catch (e) { await store.update("maintenance", maintId, { status: "OPEN" }); throw e; }
    const startedAt = Math.floor(Date.now() / 1000);
    run.promise.then(async (result) => {
      const endedAt = Math.ceil(Date.now() / 1000);
      if (robotDriver.restoreObstacles) robotDriver.restoreObstacles();
      const cur = await store.get("maintenance", maintId);
      if (cur.status !== "IN_PROGRESS") return;                          // e.g. a human entry cancelled it meanwhile
      if (result.status !== "COMPLETED" || result.obstacle) {
        await store.update("maintenance", maintId, { status: "OPEN", last_attempt: { at: iso(), note: result.note } });
        return;
      }
      const evidence = ethers.keccak256(ethers.toUtf8Bytes(chain.canonical({ maint: maintId, result: { ...result, log: undefined } })));
      const sewer = sewers.get(m.sewer_id);
      const maxGas = Math.round(Math.max(0, ...result.checkpoints.map((c) => (c.gas && c.gas.methane) || 0)));   // peak methane seen
      const summary = { robot_run: { reached_m: result.reached_m, checkpoints: result.checkpoints.length, ended_at: iso() },
        evidence_hash: evidence };
      const ins = await store.get("inspections", m.inspection_id);
      if (cur.escrow.job_id) {
        const proof = await chain.submitRobotProof(ins, { job_id: cur.escrow.job_id, sewer_id: m.sewer_id, evidence_hash: evidence,
          started_at: startedAt, ended_at: Math.max(endedAt, startedAt + 1), human_detected: false, max_gas: Math.min(maxGas, 4294967295) });
        const p = await waitRecord(proof.id);
        if (p && p.status === "CONFIRMED") {
          await store.update("maintenance", maintId, { escrow: { ...cur.escrow, status: "PROOF_ACCEPTED", proof_tx: p.tx_hash } });
          const job = await chain.getJob(cur.escrow.job_id);
          const waitS = job ? job.challenge_window_s + 2 : 12;
          setTimeout(async () => {
            const rel = await chain.release(ins, cur.escrow.job_id);
            const r = await waitRecord(rel.id);
            const c2 = await store.get("maintenance", maintId);
            await store.update("maintenance", maintId, { escrow: { ...c2.escrow, status: r && r.status === "CONFIRMED" ? "PAID" : "RELEASE_PENDING", release_tx: r && r.tx_hash } });
          }, waitS * 1000);
        } else {
          await store.update("maintenance", maintId, { escrow: { ...cur.escrow, status: "PROOF_REJECTED", error: p && p.error } });
        }
      }
      await store.update("maintenance", maintId, { status: "COMPLETED", completed_at: iso(), ...summary });
      const done = await store.update("inspections", m.inspection_id, { maintenance_status: "COMPLETED",
        maintenance: { id: maintId, completed_at: iso(), evidence_hash: evidence } });
      await chain.recordMaintenanceCompletion(done);
      if (sewer) await store.upsert("sewers", sewer);
    }).catch((e) => log.error?.("[maintenance]", e));
    missions.set(maintId, run.promise);
    return store.get("maintenance", maintId);
  }

  // ---------------------------------------------------------------- human entry attempt while blocked
  async function entryAttempt(sewerId, reason = "entry attempt reported") {
    const sewer = sewers.get(sewerId);
    if (!sewer) throw httpErr(404, "NOT_FOUND", `No sewer ${sewerId}`);
    const a = await alert({ severity: "CRITICAL", sewer_id: sewerId, kind: "ENTRY_ATTEMPT", hazards: ["HUMAN_ENTRY_ATTEMPT"],
      action: "STOP_ENTRY_IMMEDIATELY", message: `${sewerId}: ${reason} while HUMAN ENTRY is ${sewer.entry}. Supervisor notified.` });
    // any open, escrowed maintenance job on this sewer is forfeited: the contractor sent a person in
    const open = (await store.list("maintenance", { filter: { sewer_id: sewerId } }))
      .filter((m) => ["OPEN", "IN_PROGRESS"].includes(m.status) && m.escrow && m.escrow.job_id);
    const ins = sewer.active_inspection ? await store.get("inspections", sewer.active_inspection)
      : (await store.list("inspections", { filter: { sewer_id: sewerId }, sort: { created_at: -1 }, limit: 1 }))[0];
    if (ins) {
      const attempts = [...(ins.entry_attempts || []), { at: iso(), reason, alert_id: a.id }];
      const upd = await store.update("inspections", ins.id, { entry_attempts: attempts });
      await chain.recordInspection(upd);
    }
    for (const m of open) {
      const t = Math.floor(Date.now() / 1000);
      const rec = await chain.submitRobotProof(ins || { id: m.inspection_id, sewer_id: sewerId }, { job_id: m.escrow.job_id, sewer_id: sewerId,
        evidence_hash: ethers.id(`entry:${a.id}`), started_at: t - 1, ended_at: t, human_detected: true, max_gas: 0 });
      await store.update("maintenance", m.id, { status: "CANCELLED_HUMAN_ENTRY", escrow: { ...m.escrow, status: "SLASHING", entry_tx_record: rec.id } });
      waitRecord(rec.id).then(async (r) => {
        const cur = await store.get("maintenance", m.id);
        await store.update("maintenance", m.id, { escrow: { ...cur.escrow, status: r && r.status === "CONFIRMED" ? "SLASHED" : "SLASH_PENDING", entry_tx: r && r.tx_hash } });
      });
    }
    return { alert: a, forfeited_jobs: open.map((m) => m.id) };
  }

  // ---------------------------------------------------------------- helpers
  const missions = new Map();
  async function waitRecord(id, timeoutMs = 45000) {
    const t0 = Date.now();
    for (;;) {
      const r = await store.get("chain_records", id);
      if (!r || r.status !== "PENDING" || Date.now() - t0 > timeoutMs) return r;
      await new Promise((res) => setTimeout(res, 250));
    }
  }

  function markOffline() {
    const limit = cfg.thresholds.offline_after_seconds * 1000;
    for (const s of sewers.values()) {
      const age = s.last_update ? now() - new Date(s.last_update) : Infinity;
      if (age > limit && s.status !== "OFFLINE") {
        s.status = "OFFLINE";
        s.entry = "BLOCKED";           // no data = no entry
        store.upsert("sewers", s).catch(() => {});
      }
    }
  }

  async function manualInspection(sewerId, reason = "operator request") {
    const sewer = sewers.get(String(sewerId || "").toUpperCase());
    if (!sewer) throw httpErr(404, "NOT_FOUND", `No sewer ${sewerId}`);
    if (sewer.active_inspection) throw httpErr(409, "ALREADY_ACTIVE", `${sewer.id} already has ${sewer.active_inspection}`);
    const risk = sewer.risk || { risk_level: "WARNING", risk_score: 0, triggered_hazards: ["NO_DATA"], recommended_action: "INSPECT_WITH_ROBOT" };
    return openIncident(sewer, sewer.last_reading, { ...risk, risk_level: risk.risk_level }, `MANUAL: ${reason}`.slice(0, 120));
  }

  async function dashboard() {
    markOffline();
    const list = [...sewers.values()];
    const count = (st) => list.filter((s) => s.status === st).length;
    const [alerts, inspections, maintenance, chainStatus, records] = await Promise.all([
      store.list("alerts", { sort: { created_at: -1 }, limit: 30 }),
      store.list("inspections", { sort: { created_at: -1 }, limit: 30 }),
      store.list("maintenance", { sort: { created_at: -1 }, limit: 20 }),
      chain.status(),
      store.list("chain_records", { sort: { created_at: -1 }, limit: 40 }),
    ]);
    const rs = robot.status();
    return {
      generated_at: iso(),
      overview: { total: list.length, safe: count("SAFE"), warning: count("WARNING"), critical: count("CRITICAL"), offline: count("OFFLINE"),
        active_robots: rs.mode === "AUTO" || ["MOVING", "INSPECTING", "OBSTACLE", "RETURNING"].includes(rs.state) ? 1 : 0, total_robots: 1,
        pending_inspections: inspections.filter((i) => i.status === "OPEN").length,
        entry_blocked: list.filter((s) => s.entry === "BLOCKED").length,
        unacknowledged_alerts: alerts.filter((a) => !a.acknowledged).length },
      sewers: list.map(({ risk, last_reading, ...s }) => ({ ...s, risk_level: risk ? risk.risk_level : null, risk_score: risk ? risk.risk_score : null,
        hazards: risk ? risk.triggered_hazards : [], recommended_action: risk ? risk.recommended_action : "NO_ENTRY_UNTIL_DATA", reading: last_reading })),
      robot: rs, alerts, inspections, maintenance, chain: chainStatus, chain_records: records,
      thresholds: cfg.thresholds,
    };
  }

  return { init, ingest, openIncident, deployRobot, completeMaintenance, entryAttempt, manualInspection, dashboard, alert,
    waitRecord, markOffline, sewers, missions, analyze: (raw) => {
      const v = validateReading(raw, { sewers: cfg.sewers, thresholds: cfg.thresholds, now: now() });
      if (!v.ok) return v;
      return { ...v, risk: analyzeRisk(v.reading, cfg.thresholds, cfg.sewers.find((s) => s.id === v.reading.sewer_id)) };
    } };
}

function httpErr(status, code, message, details) { const e = new Error(message); e.status = status; e.code = code; e.details = details; return e; }

module.exports = { createSafetyService, httpErr };
