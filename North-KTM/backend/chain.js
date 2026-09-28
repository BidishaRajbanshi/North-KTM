// Blockchain service (ethers.js v6).
// Database = full detail. Blockchain = key events + a hash of the report.
// Writes go through one queue (no nonce clashes). If the chain is down, records stay
// PENDING in the database and are retried, so the rest of the system keeps working.
const fs = require("fs");
const { ethers } = require("ethers");

// Hardhat's PUBLIC test keys. Used automatically ONLY on a local chain (chainId 31337).
const HARDHAT = {
  city: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  robot: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
};
const LOCAL_CHAIN_ID = 31337n;

const RISK = { SAFE: 0, WARNING: 1, CRITICAL: 2 };
const ROBOT = { NONE: 0, DEPLOYED: 1, COMPLETED: 2, FAILED: 3, ABORTED: 4 };
const INSP = { NONE: 0, OPEN: 1, COMPLETED: 2, FAILED: 3 };
const MAINT = { NONE: 0, NOT_REQUIRED: 1, REQUIRED: 2, COMPLETED: 3 };
const JOB_STATUS = ["None", "Open", "Proven", "Disputed", "Paid", "HumanEntry", "Refunded"];

/** Stable JSON (sorted keys) so the same data always gives the same hash. */
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined)
    .map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v === undefined ? null : v);
}

/** The fields of an inspection that the on-chain hash protects. */
function reportPayload(ins) {
  return {
    id: ins.id, sewer_id: ins.sewer_id, created_at: ins.created_at,
    risk_level: ins.risk_level, risk_score: ins.risk_score, triggered_hazards: ins.triggered_hazards,
    trigger_reading: ins.trigger_reading || null, human_entry: ins.human_entry,
    status: ins.status, findings: ins.findings || null,
    maintenance_status: ins.maintenance_status || "NONE", maintenance: ins.maintenance || null,
    entry_attempts: ins.entry_attempts || [],
    // robot_status is left out on purpose: it changes mid-mission, before the next on-chain write
  };
}
const reportHash = (ins) => ethers.keccak256(ethers.toUtf8Bytes(canonical(reportPayload(ins))));
const idHash = (id) => ethers.id(String(id));

function createChainService({ rpc, deploymentFile, recorderKey, gatewayKey, store, retryMs = 10000, onEvent = () => {}, log = console }) {
  let provider, contract, dep, recorder, gateway, chainId;
  let connected = false;
  let lastError = null;
  let queue = Promise.resolve();
  let retryTimer = null;
  let seq = 0;             // strict FIFO order: records are written in the order they were created

  const now = () => new Date().toISOString();

  async function rpcUp() {
    try {
      const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', signal: AbortSignal.timeout(2500) });
      const j = await res.json();
      return j.result ? BigInt(j.result) : null;
    } catch { return null; }
  }

  async function connect() {
    if (connected) return true;
    if (!fs.existsSync(deploymentFile)) { lastError = "contract not deployed yet (deployment.json missing)"; return false; }
    const id = await rpcUp();
    if (id === null) { lastError = `blockchain not reachable at ${rpc}`; return false; }
    dep = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
    if (dep.chainId && BigInt(dep.chainId) !== id) {
      lastError = `deployment.json is for chain ${dep.chainId} but ${rpc} is chain ${id}. Redeploy.`; return false;
    }
    chainId = id;
    provider = new ethers.JsonRpcProvider(rpc, ethers.Network.from(Number(id)), { staticNetwork: true, polling: false, cacheTimeout: -1 });
    const local = id === LOCAL_CHAIN_ID;
    const rk = recorderKey || (local ? HARDHAT.city : "");
    const gk = gatewayKey || (local ? HARDHAT.robot : "");
    if (!rk) { lastError = "RECORDER_KEY not set (needed on a real network)"; return false; }
    recorder = new ethers.Wallet(rk, provider);
    gateway = gk ? new ethers.Wallet(gk, provider) : null;
    contract = new ethers.Contract(dep.contract, dep.abi, recorder);
    const code = await provider.getCode(dep.contract);
    if (code === "0x") { lastError = `no contract at ${dep.contract}: the chain was restarted. Redeploy.`; return false; }
    if (!(await contract.recorders(recorder.address))) { lastError = `${recorder.address} is not an authorised recorder`; return false; }
    connected = true; lastError = null;
    log.info?.(`[chain] connected: chain ${id}, contract ${dep.contract}, recorder ${recorder.address}`);
    return true;
  }

  const decode = (e) => {
    try { const p = contract.interface.parseError(e.data || e.info?.error?.data); if (p) return p.name; } catch {}
    return e.shortMessage || e.message;
  };
  const retryable = (e) => /ECONNREFUSED|network|timeout|fetch failed|could not detect|NONCE|nonce|socket|503|502/i.test(String(e.message || e));

  /** Add a record to the queue. Returns the chain_records document (PENDING at first). */
  async function enqueue(kind, inspectionId, args, meta = {}) {
    if (seq === 0) seq = Math.max(0, ...(await store.list("chain_records")).map((r) => r.seq || 0));
    const rec = { id: `TX-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, seq: ++seq, kind, inspection_id: inspectionId,
      args, meta, status: "PENDING", attempts: 0, created_at: now(), tx_hash: null, block: null, error: null };
    await store.insert("chain_records", rec);
    queue = queue.then(drain).catch(() => {});
    return rec;
  }

  /** Write every PENDING record, oldest first. Stop at the first one that must be retried,
   *  so a later record can never overtake an earlier one (their order matters on-chain). */
  async function drain() {
    const pending = (await store.list("chain_records", { filter: { status: "PENDING" } })).sort((a, b) => (a.seq || 0) - (b.seq || 0));
    for (const r of pending) {
      const res = await processRecord(r.id);
      if (res && res.status === "PENDING") break;
    }
  }

  async function processRecord(recId) {
    const rec = await store.get("chain_records", recId);
    if (!rec || rec.status !== "PENDING") return rec;
    if (!(await connect())) { await store.update("chain_records", recId, { error: lastError }); return rec; }
    try {
      const tx = await send(rec);
      const rc = await tx.wait();
      const block = await provider.getBlock(rc.blockNumber);
      const done = await store.update("chain_records", recId, { status: "CONFIRMED", tx_hash: rc.hash, block: rc.blockNumber,
        block_time: new Date(Number(block.timestamp) * 1000).toISOString(), confirmed_at: now(), attempts: rec.attempts + 1, error: null,
        result: rec.kind === "POST_JOB" ? { job_id: Number(await contract.jobCount()) } : null });
      onEvent({ type: "CHAIN_CONFIRMED", record: done });
      return done;
    } catch (e) {
      const msg = decode(e);
      if (retryable(e)) { connected = false; lastError = msg; await store.update("chain_records", recId, { attempts: rec.attempts + 1, error: msg }); return rec; }
      const failed = await store.update("chain_records", recId, { status: "FAILED", attempts: rec.attempts + 1, error: msg });
      onEvent({ type: "CHAIN_FAILED", record: failed });
      log.warn?.(`[chain] ${rec.kind} failed: ${msg}`);
      return failed;
    }
  }

  async function send(rec) {
    const a = rec.args;
    switch (rec.kind) {
      case "HAZARD": return contract.recordHazard(idHash(a.inspection_id), a.sewer_id, a.risk, a.risk_score, a.hazards, a.report_hash);
      case "ROBOT_DEPLOYMENT": return contract.recordRobotDeployment(idHash(a.inspection_id), a.robot_id);
      case "INSPECTION": return contract.recordInspection({ inspectionId: idHash(a.inspection_id), sewerId: a.sewer_id, risk: a.risk,
        riskScore: a.risk_score, hazardSummary: a.hazards, robotStatus: a.robot_status, inspectionStatus: a.inspection_status,
        maintenanceStatus: a.maintenance_status, reportHash: a.report_hash });
      case "MAINTENANCE": return contract.recordMaintenanceCompletion(idHash(a.inspection_id), a.report_hash);
      case "POST_JOB": {
        const deadline = Math.floor(Date.now() / 1000) + 24 * 3600;
        return contract.postJob(dep.contractor, ethers.id(a.sewer_id), a.min_duration ?? dep.minDuration ?? 15, deadline, { value: ethers.parseEther(String(a.payment)) });
      }
      case "ROBOT_PROOF": {
        if (!gateway) throw new Error("ROBOT_GATEWAY_KEY not set");
        const proof = { jobId: a.job_id, manholeId: ethers.id(a.sewer_id), evidenceHash: a.evidence_hash,
          startedAt: a.started_at, endedAt: a.ended_at, humanDetected: a.human_detected, maxGasPpm: a.max_gas };
        const digest = await contract.proofDigest(proof);
        const sig = await gateway.signMessage(ethers.getBytes(digest));
        return contract.submitProof(proof, sig);
      }
      case "RELEASE": return contract.release(a.job_id);
      default: throw new Error("unknown record kind " + rec.kind);
    }
  }

  async function retryPending() {
    queue = queue.then(drain).catch(() => {});
    return queue;
  }

  // ------------------------------------------------ public helpers used by the pipeline
  const hz = (ins) => (ins.triggered_hazards || []).join(",").slice(0, 120);
  const api = {
    reportHash, idHash, canonical, reportPayload, RISK, ROBOT, INSP, MAINT,
    connect, retryPending,
    start() { retryTimer = setInterval(() => retryPending().catch(() => {}), retryMs); return connect(); },
    stop() { clearInterval(retryTimer); },
    whenIdle: () => queue,

    recordHazard: (ins) => enqueue("HAZARD", ins.id, { inspection_id: ins.id, sewer_id: ins.sewer_id, risk: RISK[ins.risk_level],
      risk_score: ins.risk_score, hazards: hz(ins), report_hash: reportHash(ins) }),
    recordRobotDeployment: (ins, robotId) => enqueue("ROBOT_DEPLOYMENT", ins.id, { inspection_id: ins.id, robot_id: robotId }),
    recordInspection: (ins) => enqueue("INSPECTION", ins.id, { inspection_id: ins.id, sewer_id: ins.sewer_id, risk: RISK[ins.risk_level],
      risk_score: ins.risk_score, hazards: hz(ins), robot_status: ROBOT[ins.robot_status] ?? 0,
      inspection_status: INSP[ins.status] ?? 1, maintenance_status: MAINT[ins.maintenance_status] ?? 0, report_hash: reportHash(ins) }),
    recordMaintenanceCompletion: (ins) => enqueue("MAINTENANCE", ins.id, { inspection_id: ins.id, report_hash: reportHash(ins) }),

    postJob: (ins, payment) => enqueue("POST_JOB", ins.id, { sewer_id: ins.sewer_id, payment }),
    submitRobotProof: (ins, p) => enqueue("ROBOT_PROOF", ins.id, p),
    release: (ins, jobId) => enqueue("RELEASE", ins.id, { job_id: jobId }),

    async getJob(jobId) {
      if (!(await connect())) return null;
      const j = await contract.jobs(jobId);
      return { job_id: jobId, status: JOB_STATUS[Number(j.status)], payment: ethers.formatEther(j.payment),
        proven_at: Number(j.provenAt), challenge_window_s: Number(await contract.challengeWindow()) };
    },

    /** Compare the database record with what's on-chain. */
    async verify(ins) {
      const local = reportHash(ins);
      if (!(await connect())) return { status: "CHAIN_UNAVAILABLE", local_hash: local, error: lastError };
      const id = idHash(ins.id);
      if (!(await contract.hasInspection(id))) return { status: "NOT_ON_CHAIN", local_hash: local };
      const r = await contract.getInspection(id);
      const onchain = {
        sewer_id: r.sewerId, risk: Object.keys(RISK)[Number(r.risk)], risk_score: Number(r.riskScore),
        robot_status: Object.keys(ROBOT)[Number(r.robotStatus)], inspection_status: Object.keys(INSP)[Number(r.inspectionStatus)],
        maintenance_status: Object.keys(MAINT)[Number(r.maintenanceStatus)], hazard_summary: r.hazardSummary, robot_id: r.robotId,
        report_hash: r.reportHash, version: Number(r.version),
        created_at: new Date(Number(r.createdAt) * 1000).toISOString(), updated_at: new Date(Number(r.updatedAt) * 1000).toISOString(),
      };
      return { status: onchain.report_hash === local ? "VERIFIED" : "MISMATCH", local_hash: local, onchain_hash: onchain.report_hash,
        onchain, contract: dep.contract, chain_id: Number(chainId) };
    },

    async status() {
      const pending = await store.count("chain_records", { status: "PENDING" });
      return { connected, chain_id: chainId ? Number(chainId) : null, network: dep && dep.network, rpc,
        contract: dep && dep.contract, recorder: recorder && recorder.address, pending, error: lastError,
        explorer: dep && dep.network === "mstTestnet" ? "https://mstscan.com" : null };
    },
  };
  return api;
}

module.exports = { createChainService, reportHash, canonical, idHash, HARDHAT };
