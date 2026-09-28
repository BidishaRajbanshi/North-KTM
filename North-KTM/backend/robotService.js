// Robot service: state machine + missions on top of a driver (simulator or ESP32).
// States: IDLE → MOVING ⇄ INSPECTING → (OBSTACLE) → RETURNING → COMPLETED   (ERROR on failure)
const { COMMANDS } = require("./robotDrivers");

const STATES = ["IDLE", "MOVING", "INSPECTING", "OBSTACLE", "RETURNING", "COMPLETED", "ERROR"];

function createRobotService({ driver, id = "R1", stepMs = 700, segmentM = 10, checkpointEveryM = 2.5,
  onEvent = () => {}, readSewer = async () => null, maxDriverFailures = 3 }) {
  let state = "IDLE";
  let mode = "IDLE";             // IDLE | AUTO | MANUAL
  let telemetry = { connected: driver.kind === "sim", position_m: 0, obstacle_cm: null, blocked: false, battery_pct: null };
  let mission = null;
  let lastError = null;
  let abort = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => new Date().toISOString();

  function setState(next, note) {
    if (!STATES.includes(next)) throw new Error("bad state " + next);
    if (next === state) return;
    const prev = state;
    state = next;
    const evt = { robot_id: id, from: prev, to: next, note: note || null, at: now(),
      position_m: telemetry.position_m, mission: mission && mission.inspection_id };
    if (mission) mission.log.push(evt);
    onEvent({ type: "ROBOT_STATE", ...evt });
  }

  async function drive(cmd) {
    let failures = 0;
    for (;;) {
      try {
        telemetry = await driver.send(cmd);
        lastError = null;
        return telemetry;
      } catch (e) {
        failures++;
        lastError = e.message;
        if (failures >= maxDriverFailures) {
          telemetry = { ...telemetry, connected: false };
          throw new Error(`robot not responding: ${e.message}`);
        }
        await sleep(Math.min(300, stepMs));
      }
    }
  }

  /** Manual command from the operator. Taking control during a mission pauses it (MANUAL mode). */
  async function command(cmd) {
    if (!COMMANDS.includes(cmd)) {
      const err = new Error(`command must be one of: ${COMMANDS.join(", ")}`); err.status = 400; throw err;
    }
    if (mode === "AUTO") abort = true;      // operator takes over; the mission ends as ABORTED
    mode = "MANUAL";
    try {
      await drive(cmd);
    } catch (e) {
      setState("ERROR", e.message);
      const err = new Error(e.message); err.status = 502; throw err;
    }
    if (cmd === "stop") setState(state === "ERROR" ? "ERROR" : "IDLE", "operator stop");
    else if (telemetry.blocked && cmd === "forward") setState("OBSTACLE", `obstacle ${telemetry.obstacle_cm} cm ahead`);
    else setState(cmd === "backward" ? "RETURNING" : "MOVING", `manual ${cmd}`);
    onEvent({ type: "ROBOT_COMMAND", robot_id: id, command: cmd, at: now(), position_m: telemetry.position_m });
    return status();
  }

  /** Autonomous inspection run. Resolves with the findings; never throws. */
  function deploy({ sewerId, inspectionId }) {
    if (mode === "AUTO" && mission && !mission.done) {
      const err = new Error(`robot ${id} is already on a mission (${mission.inspection_id})`); err.status = 409; throw err;
    }
    abort = false;
    mode = "AUTO";
    if (driver.reset) driver.reset();
    telemetry = { ...telemetry, position_m: 0 };
    mission = { robot_id: id, sewer_id: sewerId, inspection_id: inspectionId, started_at: now(), log: [],
      checkpoints: [], obstacle: null, done: false, result: null };
    state = "IDLE";
    const promise = run().catch((e) => finish("ERROR", e.message));
    mission.promise = promise;
    return { mission: publicMission(), promise };
  }

  async function snapshot(label) {
    const sewer = await readSewer(mission.sewer_id).catch(() => null);
    const cp = { label, position_m: telemetry.position_m, at: now(),
      gas: sewer ? { methane: sewer.methane, combustible: sewer.combustible, air_quality: sewer.air_quality, oxygen: sewer.oxygen } : null,
      obstacle_cm: telemetry.obstacle_cm };
    mission.checkpoints.push(cp);
    return cp;
  }

  async function run() {
    setState("MOVING", `entering ${mission.sewer_id}`);
    await snapshot("entry");
    let nextCp = checkpointEveryM;
    while (telemetry.position_m < segmentM) {
      if (abort) return finish("IDLE", "mission taken over by operator");
      const before = telemetry.position_m;
      await drive("forward");
      if (telemetry.blocked || telemetry.position_m === before) {
        mission.obstacle = { position_m: telemetry.position_m, distance_cm: telemetry.obstacle_cm, type: telemetry.obstacle_type || "obstacle" };
        setState("OBSTACLE", `${mission.obstacle.type} at ${telemetry.position_m} m`);
        await snapshot("obstacle");
        await sleep(stepMs * 2);
        break;
      }
      if (telemetry.position_m >= nextCp) {
        setState("INSPECTING", `checkpoint ${nextCp} m`);
        await snapshot(`checkpoint ${nextCp} m`);
        await sleep(stepMs * 2);
        nextCp += checkpointEveryM;
        setState("MOVING");
      }
      await sleep(stepMs);
    }
    setState("RETURNING", "heading back to the manhole");
    while (telemetry.position_m > 0) {
      if (abort) return finish("IDLE", "mission taken over by operator");
      await drive("backward");
      await sleep(stepMs / 2);
    }
    await drive("stop");
    return finish("COMPLETED", mission.obstacle ? "returned; blockage found" : "returned; no blockage found");
  }

  function finish(finalState, note) {
    if (!mission || mission.done) return mission && mission.result;
    if (finalState === "ERROR") { lastError = note; }
    if (finalState !== "IDLE") setState(finalState, note);   // on abort the operator already owns the state
    mission.done = true;
    mission.finished_at = now();
    mission.result = {
      status: finalState === "COMPLETED" ? "COMPLETED" : finalState === "ERROR" ? "FAILED" : "ABORTED",
      note,
      reached_m: Math.max(0, ...mission.checkpoints.map((c) => c.position_m)),
      obstacle: mission.obstacle,
      checkpoints: mission.checkpoints,
      log: mission.log,
    };
    mode = finalState === "COMPLETED" || finalState === "ERROR" ? "IDLE" : mode;
    return mission.result;
  }

  function publicMission() {
    if (!mission) return null;
    const { promise, ...m } = mission;
    return m;
  }

  function status() {
    return { robot_id: id, driver: driver.kind, state, mode, telemetry, camera_url: driver.cameraUrl,
      mission: mission && { inspection_id: mission.inspection_id, sewer_id: mission.sewer_id, started_at: mission.started_at,
        done: mission.done, obstacle: mission.obstacle, checkpoints: mission.checkpoints.length },
      last_error: lastError };
  }

  async function reset() {
    abort = true;
    if (mission && mission.promise) await mission.promise.catch(() => {});
    mission = null; mode = "IDLE"; lastError = null;
    if (driver.reset) driver.reset();
    try { telemetry = await driver.telemetry(); } catch { telemetry = { ...telemetry, connected: false }; }
    setState("IDLE", "reset");
    return status();
  }

  async function refresh() {       // poll hardware so the dashboard shows "connected"
    if (mode === "AUTO") return status();
    try { telemetry = await driver.telemetry(); lastError = null; } catch (e) { telemetry = { ...telemetry, connected: false }; lastError = e.message; }
    return status();
  }

  return { command, deploy, status, reset, refresh, STATES, get state() { return state; } };
}

module.exports = { createRobotService, STATES };
