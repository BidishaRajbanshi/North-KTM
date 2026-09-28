// SewerSafe operator dashboard. Plain JS, no build step. Polls the backend once a second.
"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const short = (h, n = 8) => (h && h.length > 2 * n + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h || "—");
const ago = (iso) => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : new Date(iso).toLocaleString();
};
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");
const pill = (v) => `<span class="pill ${esc(v)}">${esc(String(v ?? "—").replace(/_/g, " "))}</span>`;

const S = { data: null, selected: null, expanded: null, verify: {}, demo: null, robotEvents: [], trend: null, busy: false, health: null };

// ------------------------------------------------------------------ API
function token() { try { return localStorage.getItem("ss-op-token") || ""; } catch { return ""; } }
async function api(method, path, body) {
  const headers = { "content-type": "application/json" };
  const t = $("opToken").value || token();
  if (t) headers["x-operator-token"] = t;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j.error && j.error.message) || `HTTP ${res.status}`);
  return j;
}
function toast(msg, ms = 3200) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ------------------------------------------------------------------ polling
async function poll() {
  try {
    const [d, r] = await Promise.all([api("GET", "/api/dashboard"), api("GET", "/api/robot/status")]);
    S.data = d; S.robotEvents = r.recent_events || [];
    render();
    autoVerify();
  } catch (e) {
    $("updated").textContent = "Backend not reachable: " + e.message;
  } finally {
    setTimeout(poll, 1000);
  }
}

async function autoVerify() {
  const d = S.data; if (!d) return;
  for (const ins of d.inspections.slice(0, 8)) {
    const recs = d.chain_records.filter((r) => r.inspection_id === ins.id);
    const sig = ins.status + ins.maintenance_status + (ins.entry_attempts || []).length + recs.map((r) => r.status).join("") + (ins.tampered_for_demo ? "T" : "");
    if (S.verify[ins.id] && S.verify[ins.id].sig === sig && Date.now() - S.verify[ins.id].at < 15000) continue;
    if (S.verify[ins.id] && S.verify[ins.id].inflight) continue;
    S.verify[ins.id] = { ...(S.verify[ins.id] || {}), inflight: true };
    api("GET", `/api/blockchain/inspection/${ins.id}`)
      .then((v) => { S.verify[ins.id] = { ...v, sig, at: Date.now() }; })
      .catch((e) => { S.verify[ins.id] = { status: "CHAIN_UNAVAILABLE", error: e.message, sig, at: Date.now() }; });
  }
}

// ------------------------------------------------------------------ render
function render() {
  const d = S.data;
  $("updated").textContent = "Updated " + time(d.generated_at);
  renderChips(d); renderBanner(d); renderSteps(d); renderTiles(d); renderMonitor(d);
  renderRobot(d); renderAlerts(d); renderMaint(d); renderHistory(d); renderChain(d);
  if (!$("demoSewer").options.length) {
    $("demoSewer").innerHTML = d.sewers.filter((s) => s.device === "simulated")
      .map((s) => `<option value="${esc(s.id)}"${s.id === "S103" ? " selected" : ""}>${esc(s.id)} · ${esc(s.location.split(",")[0])}</option>`).join("");
  }
}

function renderChips(d) {
  const c = d.chain;
  const h = S.health || {};
  $("sysChips").innerHTML = [
    `<span class="chip">DB: ${esc(h.db || "…")}</span>`,
    `<span class="chip ${d.robot.telemetry.connected ? "ok" : "bad"}">Robot: ${esc(d.robot.driver)}${d.robot.telemetry.connected ? "" : " (offline)"}</span>`,
    `<span class="chip ${c.connected ? "ok" : "bad"}">Chain: ${c.connected ? "chain " + c.chain_id : "not connected"}${c.pending ? " · " + c.pending + " pending" : ""}</span>`,
    `<span class="chip">Sensors: ${h.sensors_simulated ? "sim + ESP32" : "ESP32 only"}</span>`,
  ].join("");
}

function renderBanner(d) {
  const blocked = d.sewers.filter((s) => s.status === "CRITICAL" || s.active_inspection);
  const b = $("blockBanner");
  if (!blocked.length) { b.hidden = true; return; }
  const s = blocked.sort((a, c) => (c.risk_score || 0) - (a.risk_score || 0))[0];
  const ins = d.inspections.find((i) => i.id === s.active_inspection) || d.inspections.find((i) => i.sewer_id === s.id);
  const robot = d.robot.mission && d.robot.mission.sewer_id === s.id && !d.robot.mission.done ? `Robot R1 ${d.robot.state.toLowerCase()} at ${d.robot.telemetry.position_m} m` :
    ins && ins.robot_status !== "NONE" ? `Robot inspection ${ins.robot_status.toLowerCase()}` : "Robot deployment pending";
  b.hidden = false;
  b.innerHTML = `<div class="big-line"><span class="pulse" aria-hidden="true"></span>HUMAN ENTRY BLOCKED · ${esc(s.id)}</div>
    <div class="sub">${esc(s.name)}, ${esc(s.location)} · ${esc(s.status)}${s.risk_score != null ? " " + s.risk_score + "/100" : ""} · ${esc((s.hazards || []).join(", ").replace(/_/g, " ") || "hazard")} · ${esc(robot)}${blocked.length > 1 ? ` · ${blocked.length - 1} more blocked` : ""}</div>`;
}

const STEPS = ["Dangerous gas simulated", "Risk engine: CRITICAL", "Dashboard status changes", "HUMAN ENTRY BLOCKED", "Alert + supervisor notified",
  "Robot deployed", "Robot enters sewer", "Camera view live", "Inspection completes", "Database record saved", "Blockchain event recorded", "Record verified on-chain"];
function renderSteps(d) {
  const el = $("demoSteps");
  if (!S.demo) { el.hidden = true; return; }
  const ins = d.inspections.find((i) => i.id === S.demo.inspection_id) || d.inspections.find((i) => i.sewer_id === S.demo.sewer_id && i.created_at >= S.demo.at);
  const sw = d.sewers.find((s) => s.id === S.demo.sewer_id);
  const recs = ins ? d.chain_records.filter((r) => r.inspection_id === ins.id) : [];
  const v = ins && S.verify[ins.id];
  if (ins && d.robot.mission && d.robot.mission.inspection_id === ins.id && d.robot.telemetry.position_m > 0) S.demo.entered = true;
  const done = [
    !!(sw && sw.reading && sw.reading.methane > 1000) || !!ins,
    !!ins, !!ins, !!ins && ins.human_entry === "BLOCKED",
    !!ins && d.alerts.some((a) => a.inspection_id === ins.id && a.severity === "CRITICAL"),
    !!ins && ins.robot_status !== "NONE",
    !!S.demo.entered || (ins && ["COMPLETED", "FAILED"].includes(ins.status)),
    !!S.demo.entered || (ins && ins.status === "COMPLETED"),
    !!ins && ins.status === "COMPLETED",
    !!ins && ins.status === "COMPLETED" && !!ins.findings,
    recs.some((r) => r.kind === "INSPECTION" && r.status === "CONFIRMED"),
    false,
  ];
  done[11] = done[10] && !!v && v.status === "VERIFIED";   // verified only counts once the finished inspection is on-chain
  el.hidden = false;
  el.innerHTML = STEPS.map((t, i) => `<span class="st${done[i] ? " done" : ""}"><i></i>${i + 1}. ${esc(t)}</span>`).join("");
}

function renderTiles(d) {
  const o = d.overview;
  const t = [["Monitored sewers", o.total, ""], ["Safe", o.safe, "safe"], ["Warning", o.warning, "warn"], ["Critical", o.critical, "crit" + (o.critical ? " lit" : "")],
    ["Entry blocked", o.entry_blocked, o.entry_blocked ? "crit" : ""], ["Active robots", `${o.active_robots}/${o.total_robots}`, ""],
    ["Pending inspections", o.pending_inspections, o.pending_inspections ? "warn" : ""], ["Offline", o.offline, ""]];
  $("tiles").innerHTML = t.map(([l, v, c]) => `<div class="tile ${c}"><span>${esc(l)}</span><b>${esc(v)}</b></div>`).join("");
}

function cls(v, warn, crit, low) {
  if (v == null) return "na";
  if (low) return v <= crit ? "hi" : v <= warn ? "mid" : "";
  return v >= crit ? "hi" : v >= warn ? "mid" : "";
}
function renderMonitor(d) {
  const t = d.thresholds;
  $("monBody").innerHTML = d.sewers.map((s) => {
    const r = s.reading || {};
    const f = (v, dp = 0) => (v == null ? "—" : Number(v).toFixed(dp));
    const score = s.risk_score ?? 0;
    const barColor = s.status === "CRITICAL" ? "var(--crit)" : s.status === "WARNING" ? "var(--warn)" : "var(--safe)";
    return `<tr data-sewer="${esc(s.id)}" class="${S.selected === s.id ? "sel " : ""}${s.status === "CRITICAL" ? "row-crit" : s.status === "WARNING" ? "row-warn" : ""}">
      <td><span class="id">${esc(s.id)}</span><span class="loc">${esc(s.location.split(",")[0])}${s.device === "esp32" ? " · ESP32" : ""}</span></td>
      <td>${pill(s.status)}</td><td>${pill(s.entry)}</td>
      <td class="num">${s.risk_score == null ? "—" : score}<span class="bar"><i style="width:${score}%;background:${barColor}"></i></span></td>
      <td class="num ${cls(r.methane, t.methane_ppm.warning, t.methane_ppm.critical)}">${f(r.methane)}</td>
      <td class="num ${cls(r.combustible, t.combustible_ppm.warning, t.combustible_ppm.critical)}">${f(r.combustible)}</td>
      <td class="num ${cls(r.air_quality, t.air_quality_index.warning, t.air_quality_index.critical)}">${f(r.air_quality)}</td>
      <td class="num ${cls(r.oxygen, t.oxygen_pct.low_warning, t.oxygen_pct.low_critical, true)}">${f(r.oxygen, 1)}</td>
      <td class="num ${cls(r.water_level, t.water_level_pct.warning, t.water_level_pct.critical)}">${f(r.water_level)}</td>
      <td class="num ${cls(r.temperature, t.temperature_c.warning, t.temperature_c.critical)}">${f(r.temperature, 1)}</td>
      <td class="num">${f(r.humidity)}</td>
      <td class="muted small">${esc(ago(s.last_update))}</td></tr>`;
  }).join("");
  if (S.selected) renderDetail(d);
}

async function loadTrend() {
  if (!S.selected) return;
  try { S.trend = await api("GET", `/api/sewers/${S.selected}?limit=90`); renderDetail(S.data); } catch {}
  setTimeout(loadTrend, 3000);
}
function renderDetail(d) {
  const s = d.sewers.find((x) => x.id === S.selected);
  if (!s) return;
  $("detail").hidden = false;
  $("detailTitle").textContent = `${s.id} · ${s.name}`;
  $("detailSub").textContent = `${s.location} · depth ${s.depth_m} m · sensors: ${s.sensors.join(", ")}`;
  $("detailAction").textContent = `Recommended: ${String(s.recommended_action || "").replace(/_/g, " ")}`;
  $("bInspect").disabled = !!s.active_inspection;
  drawTrend(S.trend && S.trend.id === s.id ? S.trend.readings : [], d.thresholds);
}
function drawTrend(rows, t) {
  const c = $("trend"), dpr = devicePixelRatio || 1, w = c.clientWidth || 600, h = 150;
  c.width = w * dpr; c.height = h * dpr;
  const x = c.getContext("2d"); x.scale(dpr, dpr);
  const pad = { l: 46, r: 40, t: 8, b: 18 };
  x.fillStyle = css("--sunk"); x.fillRect(0, 0, w, h);
  x.font = '11px "IBM Plex Mono",monospace';
  const maxM = Math.max(t.methane_ppm.critical * 1.4, ...rows.map((r) => r.methane || 0)) * 1.05;
  const X = (i) => pad.l + (w - pad.l - pad.r) * (rows.length > 1 ? i / (rows.length - 1) : 0);
  const Ym = (v) => pad.t + (h - pad.t - pad.b) * (1 - v / maxM);
  const Yo = (v) => pad.t + (h - pad.t - pad.b) * (1 - (v - 15) / 8);        // 15%..23%
  x.strokeStyle = css("--line"); x.lineWidth = 1; x.fillStyle = css("--muted");
  for (const v of [0, maxM / 2, maxM]) { x.beginPath(); x.moveTo(pad.l, Ym(v)); x.lineTo(w - pad.r, Ym(v)); x.stroke(); x.fillText(Math.round(v), 4, Ym(v) + 4); }
  for (const v of [15, 19.5, 23]) x.fillText(v + "%", w - pad.r + 4, Yo(v) + 4);
  x.setLineDash([4, 4]); x.strokeStyle = css("--muted");
  for (const y of [Ym(t.methane_ppm.warning), Ym(t.methane_ppm.critical), Yo(t.oxygen_pct.low_critical)]) { x.beginPath(); x.moveTo(pad.l, y); x.lineTo(w - pad.r, y); x.stroke(); }
  x.setLineDash([]);
  if (!rows.length) { x.fillText("waiting for readings…", pad.l + 8, h / 2); return; }
  const line = (key, Y, col) => {
    x.beginPath(); let started = false;
    rows.forEach((r, i) => { if (r[key] == null) return; started ? x.lineTo(X(i), Y(r[key])) : x.moveTo(X(i), Y(r[key])); started = true; });
    x.strokeStyle = col; x.lineWidth = 2; x.stroke();
    const last = [...rows].reverse().find((r) => r[key] != null);
    if (last) { x.beginPath(); x.arc(X(rows.lastIndexOf(last)), Y(last[key]), 3.5, 0, 7); x.fillStyle = col; x.fill(); }
  };
  line("methane", Ym, css("--crit"));
  line("oxygen", Yo, css("--accent"));
  x.fillStyle = css("--muted"); x.fillText("last " + rows.length + " readings →", pad.l + 4, h - 4);
}

// ------------------------------------------------------------------ robot
function renderRobot(d) {
  const r = d.robot, t = r.telemetry;
  const st = $("robotState"); st.textContent = r.state; st.className = "state-chip " + r.state;
  $("rMode").textContent = r.mode;
  $("rPos").textContent = t.position_m != null ? t.position_m.toFixed(1) + " m" : "—";
  $("rObs").textContent = t.obstacle_cm != null ? t.obstacle_cm + " cm" : "clear";
  $("rBat").textContent = t.battery_pct != null ? t.battery_pct + "%" : "—";
  if (r.camera_url) { $("camImg").hidden = false; $("camCanvas").hidden = true; if ($("camImg").src !== r.camera_url) $("camImg").src = r.camera_url; $("camTag").textContent = "LIVE · ESP32-CAM"; }
  else { $("camImg").hidden = true; $("camCanvas").hidden = false; $("camTag").textContent = "MOCK CAMERA (no ESP32-CAM set)"; }
  const evs = S.robotEvents.slice(-12).reverse();
  $("mission").innerHTML = (r.mission ? `<div><b>Mission ${esc(r.mission.inspection_id)}</b> · ${esc(r.mission.sewer_id)} · ${r.mission.done ? "done" : "running"}${r.mission.obstacle ? " · obstacle at " + r.mission.obstacle.position_m + " m" : ""}</div>` : "")
    + (evs.length ? evs.map((e) => `<div>${esc(time(e.at))} ${e.type === "ROBOT_COMMAND" ? "cmd " + esc(e.command) : esc(e.from) + " → <b>" + esc(e.to) + "</b>"}${e.note ? " · " + esc(e.note) : ""}</div>`).join("") : "<div>No robot activity yet.</div>");
  CAM.target = t; CAM.state = r.state; CAM.sewer = r.mission ? r.mission.sewer_id : null;
}

async function robotCmd(cmd) {
  try { await api("POST", "/api/robot/command", { command: cmd }); } catch (e) { toast("Robot: " + e.message); }
}

// Mock camera: a pipe interior drawn from the robot's real telemetry (position, obstacle distance).
const CAM = { target: null, pos: 0, state: "IDLE", sewer: null, t0: performance.now() };
function drawCam(now) {
  const c = $("camCanvas");
  if (!c.hidden) {
    const x = c.getContext("2d"), W = c.width, H = c.height, cx = W / 2, cy = H * 0.47;
    const tel = CAM.target || { position_m: 0, obstacle_cm: null };
    CAM.pos += ((tel.position_m || 0) - CAM.pos) * 0.12;
    const docked = CAM.state === "IDLE" && (tel.position_m || 0) === 0;
    x.fillStyle = "#040605"; x.fillRect(0, 0, W, H);
    // pipe rings receding into the dark; they slide as the robot moves
    for (let i = 14; i >= 0; i--) {
      const z = i + 1 - ((CAM.pos * 2) % 1);
      const s = 1 / (0.35 + z * 0.35);
      const rx = W * 0.62 * s, ry = H * 0.66 * s;
      const light = Math.max(0, Math.min(1, 1.25 - z * 0.12));
      x.strokeStyle = `rgba(${150 * light + 20},${140 * light + 20},${110 * light + 15},${0.9 * light})`;
      x.lineWidth = Math.max(1, 5 * s);
      x.beginPath(); x.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); x.stroke();
    }
    // wastewater along the bottom
    const g = x.createLinearGradient(0, H * 0.62, 0, H);
    g.addColorStop(0, "rgba(40,55,35,0.2)"); g.addColorStop(1, "rgba(55,70,40,0.85)");
    x.fillStyle = g; x.beginPath(); x.moveTo(0, H); x.lineTo(W * 0.18, H * 0.66); x.lineTo(W * 0.82, H * 0.66); x.lineTo(W, H); x.fill();
    // obstacle: debris that grows as the robot closes in
    if (tel.obstacle_cm != null) {
      const k = Math.max(0.12, 1 - tel.obstacle_cm / 200);
      x.fillStyle = "rgba(92,74,50,0.95)";
      x.beginPath(); x.ellipse(cx, cy + H * 0.2 * k, W * 0.28 * k, H * 0.2 * k, 0, Math.PI, 0); x.fill();
      x.fillStyle = "rgba(60,48,32,0.95)";
      for (let i = 0; i < 7; i++) { x.beginPath(); x.arc(cx + (i - 3) * 22 * k, cy + H * 0.14 * k + (i % 2) * 8 * k, 12 * k, 0, 7); x.fill(); }
    }
    // headlight vignette
    const v = x.createRadialGradient(cx, cy, H * 0.1, cx, cy, W * 0.7);
    v.addColorStop(0, "rgba(255,245,210,0.10)"); v.addColorStop(1, "rgba(0,0,0,0.75)");
    x.fillStyle = v; x.fillRect(0, 0, W, H);
    // HUD
    x.fillStyle = "#cfe9dd"; x.font = '15px "IBM Plex Mono",monospace';
    const tsec = ((now - CAM.t0) / 1000) | 0;
    x.fillText(`R1 CAM  ${CAM.sewer || "—"}  ${CAM.state}`, 16, 26);
    x.fillText(`DIST ${CAM.pos.toFixed(1)} m   OBST ${tel.obstacle_cm != null ? tel.obstacle_cm + " cm" : "--"}`, 16, H - 16);
    if (Math.floor(tsec) % 2 === 0) { x.fillStyle = "#ff4b3e"; x.beginPath(); x.arc(W - 22, 22, 6, 0, 7); x.fill(); }
    if (docked) { x.fillStyle = "rgba(0,0,0,.55)"; x.fillRect(0, H / 2 - 22, W, 44); x.fillStyle = "#e7f4ee"; x.fillText("Robot docked at the manhole. Waiting for deployment.", 20, H / 2 + 5); }
  }
  requestAnimationFrame(drawCam);
}

// ------------------------------------------------------------------ alerts / maintenance / history / chain
function renderAlerts(d) {
  const un = d.alerts.filter((a) => !a.acknowledged).length;
  $("alertCount").textContent = `${un} unacknowledged`;
  $("alerts").innerHTML = d.alerts.length ? d.alerts.slice(0, 25).map((a) => `<li class="${a.acknowledged ? "ack" : ""}">
    <span class="stripe sev-${esc(a.severity)}"></span>
    <div><div class="msg">${esc(a.message)}</div>
      <div class="meta">${esc(a.severity)} · ${esc(a.sewer_id)} · ${esc((a.hazards || []).join(", ") || a.kind)} · ${esc(time(a.created_at))} · action: ${esc(String(a.action || "").replace(/_/g, " "))}</div></div>
    ${a.acknowledged ? '<span class="muted small">ack</span>' : `<button class="btn quiet" data-ack="${esc(a.id)}">Ack</button>`}</li>`).join("")
    : '<li class="empty">No alerts. All monitored sewers are within thresholds.</li>';
}

function renderMaint(d) {
  $("maint").innerHTML = d.maintenance.length ? d.maintenance.map((m) => `<li>
    <span class="stripe sev-${m.status === "COMPLETED" ? "INFO" : m.status === "CANCELLED_HUMAN_ENTRY" ? "CRITICAL" : "WARNING"}"></span>
    <div><div class="msg">${esc(m.task)}</div>
      <div class="meta">${esc(m.id)} · ${esc(m.sewer_id)} · ${pill(m.status)} escrow ${esc(m.escrow.payment_mstc)} MSTC ${pill(m.escrow.status)}${m.escrow.job_id ? " job #" + m.escrow.job_id : ""}</div></div>
    ${m.status === "OPEN" ? `<button class="btn accent" data-maint="${esc(m.id)}" ${m.escrow.job_id ? "" : "disabled"}>Run cleaning robot</button>` : "<span></span>"}</li>`).join("")
    : '<li class="empty">No maintenance yet. When a robot finds a blockage, the job is posted here with payment held in escrow.</li>';
}

function renderHistory(d) {
  $("histBody").innerHTML = d.inspections.length ? d.inspections.map((i) => {
    const v = S.verify[i.id];
    const row = `<tr data-ins="${esc(i.id)}" class="${i.risk_level === "CRITICAL" ? "row-crit" : ""}">
      <td><span class="id">${esc(i.id)}</span></td><td>${esc(i.sewer_id)}</td><td>${esc(time(i.created_at))}</td>
      <td>${pill(i.risk_level)} <span class="mono small">${esc(i.risk_score)}</span></td><td>${pill(i.robot_status)}</td><td>${pill(i.status)}</td>
      <td>${pill(i.maintenance_status)}</td><td>${v ? pill(v.status) : '<span class="muted small">checking…</span>'}</td></tr>`;
    if (S.expanded !== i.id) return row;
    const recs = d.chain_records.filter((r) => r.inspection_id === i.id).reverse();
    const f = i.findings || {};
    return row + `<tr class="expand"><td colspan="8"><div class="findings">
      <div><b>Hazards:</b> ${esc((i.triggered_hazards || []).join(", "))} · <b>Action:</b> ${esc(String(i.recommended_action || "").replace(/_/g, " "))} · <b>Trigger:</b> ${esc(i.trigger)}</div>
      <div><b>Robot findings:</b> ${esc(f.note || "mission running")}${f.obstacle ? ` · ${esc(f.obstacle.type)} at ${f.obstacle.position_m} m` : ""}${f.checkpoints ? ` · ${f.checkpoints.length} checkpoints, reached ${f.reached_m} m` : ""}</div>
      ${(i.entry_attempts || []).length ? `<div class="hi"><b>Entry attempts while blocked:</b> ${i.entry_attempts.map((e) => esc(time(e.at) + " " + e.reason)).join("; ")}</div>` : ""}
      ${i.tampered_for_demo ? '<div class="hi"><b>This database record was edited (demo tamper).</b></div>' : ""}
      <div><b>Verification:</b> ${v ? pill(v.status) : "…"} database hash <code>${esc(short(v && v.local_hash))}</code> · on-chain hash <code>${esc(short(v && v.onchain_hash))}</code></div>
      <div><b>On-chain events:</b> ${recs.map((r) => `${esc(r.kind)} ${pill(r.status)} <code>${esc(short(r.tx_hash, 6))}</code>`).join(" · ") || "none"}</div>
      <div><button class="btn" data-verify="${esc(i.id)}">Verify now</button> <button class="btn quiet" data-rerecord="${esc(i.id)}">Re-record on chain</button></div>
    </div></td></tr>`;
  }).join("") : '<tr><td colspan="8" class="empty">No inspections yet. Press "Simulate critical hazard" to run the full scenario.</td></tr>';
}

function renderChain(d) {
  const c = d.chain;
  $("chainSub").textContent = c.connected ? `Connected to chain ${c.chain_id}` : "Not connected: records wait as PENDING and retry automatically";
  $("chainStatus").innerHTML = `<span>Contract <b>${esc(c.contract || "not deployed")}</b></span><span>Recorder <b>${esc(short(c.recorder, 6))}</b></span>
    <span>Pending <b>${esc(c.pending)}</b></span>${c.error ? `<span class="hi">${esc(c.error)}</span>` : ""}`;
  const link = (h) => (h && c.explorer ? `<a href="${esc(c.explorer)}/tx/${esc(h)}" target="_blank" rel="noopener">${esc(short(h))}</a>` : esc(short(h)));
  $("txBody").innerHTML = d.chain_records.length ? d.chain_records.slice(0, 25).map((r) => `<tr>
    <td>${esc(r.kind.replace(/_/g, " "))}</td><td class="mono small">${esc(r.inspection_id)}</td><td class="hash">${link(r.tx_hash)}</td>
    <td class="num">${esc(r.block ?? "—")}</td><td>${esc(time(r.block_time || r.created_at))}</td><td>${pill(r.status)}${r.error && r.status !== "CONFIRMED" ? ` <span class="muted small">${esc(r.error.slice(0, 60))}</span>` : ""}</td></tr>`).join("")
    : '<tr><td colspan="6" class="empty">No on-chain records yet.</td></tr>';
}

// ------------------------------------------------------------------ actions
function wire() {
  try { $("opToken").value = token(); } catch {}
  $("opToken").addEventListener("change", () => { try { localStorage.setItem("ss-op-token", $("opToken").value); } catch {} });

  $("bCritical").onclick = async () => {
    const id = $("demoSewer").value || "S103";
    $("bCritical").disabled = true;
    try {
      const r = await api("POST", "/api/demo/critical", { sewer_id: id });
      S.demo = { sewer_id: id, inspection_id: r.inspection_id, at: new Date(Date.now() - 5000).toISOString() };
      S.selected = id; loadTrend();
      toast(`${id} CRITICAL: human entry blocked, robot deployed`);
    } catch (e) { toast(e.message, 5000); }
    finally { setTimeout(() => ($("bCritical").disabled = false), 1500); }
  };
  $("bEntry").onclick = async () => {
    const id = (S.demo && S.demo.sewer_id) || $("demoSewer").value;
    try { const r = await api("POST", "/api/demo/entry-attempt", { sewer_id: id });
      toast(`Entry attempt at ${id}: supervisor alerted${r.forfeited_jobs.length ? ", contractor bond slashed on-chain" : ""}`, 5000); }
    catch (e) { toast(e.message); }
  };
  $("bTamper").onclick = async () => {
    const ins = S.data && S.data.inspections.find((i) => i.status === "COMPLETED" && !i.tampered_for_demo);
    if (!ins) return toast("Run a critical hazard first; tamper needs a completed inspection.");
    try { await api("POST", "/api/demo/tamper", { inspection_id: ins.id }); delete S.verify[ins.id]; S.expanded = ins.id;
      toast(`${ins.id} edited in the database. Watch verification turn MISMATCH.`, 5000); }
    catch (e) { toast(e.message); }
  };
  $("bReset").onclick = async () => { try { await api("POST", "/api/demo/reset"); S.demo = null; toast("Robot reset"); } catch (e) { toast(e.message); } };
  $("bInspect").onclick = async () => {
    try { await api("POST", "/api/inspections", { sewer_id: S.selected, reason: "operator request from dashboard" }); toast("Robot inspection started"); }
    catch (e) { toast(e.message); }
  };

  document.addEventListener("click", async (ev) => {
    const el = ev.target.closest("[data-cmd],[data-ack],[data-maint],[data-verify],[data-rerecord],tr[data-sewer],tr[data-ins]");
    if (!el) return;
    if (el.dataset.cmd) return robotCmd(el.dataset.cmd);
    if (el.dataset.ack) { try { await api("POST", `/api/alerts/${el.dataset.ack}/ack`); } catch (e) { toast(e.message); } return; }
    if (el.dataset.maint) {
      try { await api("POST", `/api/maintenance/${el.dataset.maint}/complete`); toast("Cleaning robot sent. Payment releases after its proof and the inspector window."); }
      catch (e) { toast(e.message); } return;
    }
    if (el.dataset.verify) { delete S.verify[el.dataset.verify]; autoVerify(); return; }
    if (el.dataset.rerecord) { try { await api("POST", "/api/blockchain/record", { inspection_id: el.dataset.rerecord }); delete S.verify[el.dataset.rerecord]; toast("Current record written to the chain"); } catch (e) { toast(e.message); } return; }
    if (el.dataset.sewer) { S.selected = el.dataset.sewer; S.trend = null; renderMonitor(S.data); loadTrend(); return; }
    if (el.dataset.ins) { S.expanded = S.expanded === el.dataset.ins ? null : el.dataset.ins; renderHistory(S.data); }
  });

  document.addEventListener("keydown", (e) => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    const map = { ArrowUp: "forward", ArrowDown: "backward", ArrowLeft: "left", ArrowRight: "right", " ": "stop" };
    if (map[e.key]) { e.preventDefault(); robotCmd(map[e.key]); }
  });
}

(async function boot() {
  wire();
  try { S.health = await api("GET", "/api/health"); } catch {}
  requestAnimationFrame(drawCam);
  poll();
})();
