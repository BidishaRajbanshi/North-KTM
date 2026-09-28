// Test helpers: a fake blockchain with the same interface as backend/chain.js, and a tiny HTTP client.
const { reportHash, canonical } = require("../chain");

function createFakeChain(store) {
  const onchain = new Map();       // inspection id -> last report hash
  let jobs = 0;
  const confirm = async (kind, ins, args, apply) => {
    const rec = { id: `TX-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind, inspection_id: ins.id, args,
      status: "CONFIRMED", tx_hash: "0x" + Math.random().toString(16).slice(2).padEnd(64, "0"), block: 1, created_at: new Date().toISOString(), result: null };
    if (apply) rec.result = apply();
    await store.insert("chain_records", rec);
    return rec;
  };
  return {
    canonical,
    recordHazard: (ins) => confirm("HAZARD", ins, {}, () => { onchain.set(ins.id, reportHash(ins)); }),
    recordRobotDeployment: (ins, id) => confirm("ROBOT_DEPLOYMENT", ins, { robot_id: id }),
    recordInspection: (ins) => confirm("INSPECTION", ins, {}, () => { onchain.set(ins.id, reportHash(ins)); }),
    recordMaintenanceCompletion: (ins) => confirm("MAINTENANCE", ins, {}, () => { onchain.set(ins.id, reportHash(ins)); }),
    postJob: (ins) => confirm("POST_JOB", ins, {}, () => ({ job_id: ++jobs })),
    submitRobotProof: (ins, p) => confirm("ROBOT_PROOF", ins, p),
    release: (ins, jobId) => confirm("RELEASE", ins, { job_id: jobId }),
    getJob: async (id) => ({ job_id: id, status: "Proven", challenge_window_s: 0 }),
    async verify(ins) {
      const local = reportHash(ins);
      if (!onchain.has(ins.id)) return { status: "NOT_ON_CHAIN", local_hash: local };
      return { status: onchain.get(ins.id) === local ? "VERIFIED" : "MISMATCH", local_hash: local, onchain_hash: onchain.get(ins.id) };
    },
    status: async () => ({ connected: true, chain_id: 31337, contract: "0xFAKE", pending: 0 }),
    start: async () => true, stop() {},
  };
}

async function startTestServer(opts = {}) {
  const { createApp } = require("../app");
  const { createStore } = require("../store");
  const store = await createStore({});                         // memory
  const chain = opts.chain || createFakeChain(store);
  const ctx = await createApp({ store, chain, robotStepMs: opts.robotStepMs ?? 1, log: { info() {}, warn() {}, error() {} },
    config: { simulateSensors: false, deploymentFile: "/nonexistent", ...(opts.config || {}) }, robotDriver: opts.robotDriver });
  await ctx.start();
  const server = await new Promise((r) => { const s = ctx.app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { ctx, base, call, store, chain, async close() { server.close(); await ctx.stop(); } };
}

const until = async (fn, ms = 5000) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 20)); }
};

module.exports = { createFakeChain, startTestServer, until };
