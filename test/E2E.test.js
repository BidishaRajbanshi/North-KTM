// END-TO-END: the whole system against a REAL blockchain (Hardhat network), no fakes.
//   CRITICAL SENSOR → CRITICAL RISK → HUMAN ENTRY BLOCKED → ALERT → ROBOT DEPLOYED
//   → INSPECTION → DATABASE RECORD → BLOCKCHAIN RECORD → VERIFIED
// plus: tamper detection, escrow payment after robot-verified maintenance, and slashing on human entry.
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../backend/app");
const { createStore } = require("../backend/store");
const { createChainService } = require("../backend/chain");

const quiet = { info() {}, warn() {}, error() {} };

// Expose the in-process Hardhat chain over HTTP so the backend talks to it exactly as it would to a real node.
function startRpcBridge() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const one = async (m) => {
        try { return { jsonrpc: "2.0", id: m.id, result: await hre.network.provider.request({ method: m.method, params: m.params }) }; }
        catch (e) { return { jsonrpc: "2.0", id: m.id, error: { code: e.code || -32000, message: e.message, data: e.data } }; }
      };
      const msg = JSON.parse(body);
      const out = Array.isArray(msg) ? await Promise.all(msg.map(one)) : await one(msg);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const until = async (fn, ms, label) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + label);
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe("END-TO-END (real chain): sensor → risk → block → alert → robot → inspection → DB → blockchain", function () {
  this.timeout(180000);
  let bridge, server, ctx, contract, contractor, welfare, call;

  before(async () => {
    const [city, contractorSigner, robotGateway] = await ethers.getSigners();
    contractor = contractorSigner;
    welfare = ethers.Wallet.createRandom().address;
    contract = await (await ethers.getContractFactory("SewerSafe", city)).deploy(welfare, 2, ethers.parseEther("0.5"));
    await contract.waitForDeployment();
    await (await contract.registerRobot(robotGateway.address, contractor.address)).wait();
    await (await contract.connect(contractor).depositBond({ value: ethers.parseEther("1.0") })).wait();

    const depFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ss-e2e-")), "deployment.json");
    fs.writeFileSync(depFile, JSON.stringify({ network: "hardhat", chainId: 31337, contract: await contract.getAddress(),
      contractor: contractor.address, minDuration: 1, challengeWindow: 2, abi: JSON.parse(contract.interface.formatJson()) }));

    bridge = await startRpcBridge();
    const store = await createStore({});                                          // in-memory DB
    const chain = createChainService({ rpc: `http://127.0.0.1:${bridge.address().port}`, deploymentFile: depFile, store,
      retryMs: 500, log: quiet });
    ctx = await createApp({ store, chain, robotStepMs: 5, log: quiet, config: { simulateSensors: false } });
    await ctx.start();
    server = await new Promise((r) => { const s = ctx.app.listen(0, "127.0.0.1", () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    call = async (m, p, b) => (await fetch(base + p, { method: m, headers: { "content-type": "application/json" },
      body: b && JSON.stringify(b) })).json();
  });

  after(async () => { if (server) server.close(); if (ctx) await ctx.stop(); if (bridge) bridge.close(); });

  let insId;

  it("critical path ends with a VERIFIED on-chain record", async () => {
    // 1. CRITICAL SENSOR
    const res = await call("POST", "/api/sensors/data", { sewer_id: "S103", timestamp: new Date().toISOString(), methane: 8600,
      combustible: 6900, air_quality: 380, oxygen: 18.4, water_level: 48, temperature: 31, humidity: 78 });
    // 2. CRITICAL RISK → 3. HUMAN ENTRY BLOCKED
    expect(res.risk.risk_level).to.equal("CRITICAL");
    expect(res.risk.recommended_action).to.equal("BLOCK_HUMAN_ENTRY_AND_DEPLOY_ROBOT");
    expect(res.human_entry).to.equal("BLOCKED");
    insId = res.incident;
    expect(insId).to.be.a("string");
    // 4. ALERT (+ supervisor notified)
    const alerts = await call("GET", "/api/alerts?severity=CRITICAL");
    expect(alerts[0].message).to.match(/HUMAN ENTRY BLOCKED/);
    expect(await ctx.store.count("notifications")).to.equal(1);
    // 5. ROBOT DEPLOYED → 6. INSPECTION → 7. DATABASE RECORD
    const ins = await until(async () => { const i = await call("GET", `/api/inspections/${insId}`); return i.status === "COMPLETED" && i; }, 60000, "inspection");
    expect(ins.robot_status).to.equal("COMPLETED");
    expect(ins.findings.obstacle.type).to.equal("silt and debris blockage");
    // 8. BLOCKCHAIN RECORD: every write confirmed on the real chain
    await until(async () => { const i = await call("GET", `/api/inspections/${insId}`);
      return i.chain_records.length >= 4 && i.chain_records.every((r) => r.status === "CONFIRMED"); }, 60000, "confirmations");
    const onchain = await contract.getInspection(ethers.id(insId));
    expect(onchain.sewerId).to.equal("S103");
    expect(onchain.risk).to.equal(2n);               // CRITICAL
    expect(onchain.robotStatus).to.equal(2n);        // COMPLETED
    expect(onchain.inspectionStatus).to.equal(2n);   // COMPLETED
    expect(onchain.maintenanceStatus).to.equal(2n);  // REQUIRED
    expect(onchain.robotId).to.equal("R1");
    // 9. VERIFIED: database hash == on-chain hash
    const v = await call("GET", `/api/blockchain/inspection/${insId}`);
    expect(v.status).to.equal("VERIFIED");
    expect(v.onchain_hash).to.equal(v.local_hash);
  });

  it("pays the contractor from escrow only after a robot-verified maintenance run", async () => {
    const m = await until(async () => { const l = await call("GET", "/api/maintenance"); return l[0] && l[0].escrow.status === "ESCROWED" && l[0]; }, 60000, "escrow job");
    const before = await ethers.provider.getBalance(contractor.address);
    await call("POST", `/api/maintenance/${m.id}/complete`);
    const done = await until(async () => { const x = (await call("GET", "/api/maintenance"))[0]; return x.escrow.status === "PAID" && x; }, 90000, "payment");
    expect((await ethers.provider.getBalance(contractor.address)) - before).to.equal(ethers.parseEther("1"));
    expect((await contract.jobs(done.escrow.job_id)).status).to.equal(4n);            // Paid
    expect((await contract.getInspection(ethers.id(insId))).maintenanceStatus).to.equal(3n);   // COMPLETED
    await until(async () => (await call("GET", `/api/blockchain/inspection/${insId}`)).status === "VERIFIED", 30000, "verify after maintenance");
  });

  it("detects a tampered database record", async () => {
    await call("POST", "/api/demo/tamper", { inspection_id: insId });
    expect((await call("GET", `/api/blockchain/inspection/${insId}`)).status).to.equal("MISMATCH");
  });

  it("slashes the contractor's bond when a person enters a blocked manhole", async () => {
    await call("POST", "/api/sensors/data", { sewer_id: "S105", timestamp: new Date().toISOString(), methane: 9000, combustible: 7000,
      air_quality: 390, oxygen: 18.2, water_level: 50, temperature: 30, humidity: 76 });
    const m = await until(async () => { const l = (await call("GET", "/api/maintenance")).filter((x) => x.sewer_id === "S105");
      return l[0] && l[0].escrow.status === "ESCROWED" && l[0]; }, 60000, "S105 escrow");
    const bondBefore = await contract.bond(contractor.address);
    const r = await call("POST", "/api/demo/entry-attempt", { sewer_id: "S105" });
    expect(r.forfeited_jobs).to.deep.equal([m.id]);
    await until(async () => (await call("GET", "/api/maintenance")).find((y) => y.id === m.id).escrow.status === "SLASHED", 60000, "slash");
    expect(await contract.bond(contractor.address)).to.equal(bondBefore - ethers.parseEther("0.5"));
    expect(await ethers.provider.getBalance(welfare)).to.equal(ethers.parseEther("0.5"));
    expect((await contract.jobs(m.escrow.job_id)).status).to.equal(5n);               // HumanEntry
    const ins = await call("GET", `/api/inspections/${m.inspection_id}`);
    expect(ins.entry_attempts.length).to.equal(1);
    await until(async () => (await call("GET", `/api/blockchain/inspection/${m.inspection_id}`)).status === "VERIFIED", 30000, "re-verify");
  });
});
