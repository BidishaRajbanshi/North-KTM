// SewerSafe — start EVERYTHING with one command:   npm start   (or double-click START-DEMO)
//
//  1. checks Node.js           2. installs packages (first run)
//  3. starts a local blockchain on this laptop and deploys the contract
//     (skipped when .env points CHAIN_RPC at a real network such as MST testnet)
//  4. starts the backend + dashboard, opens the browser
// Press Ctrl+C to stop everything.
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);
const WIN = process.platform === "win32";
const NPX = WIN ? "npx.cmd" : "npx";
const NPM = WIN ? "npm.cmd" : "npm";
const HH = process.env.SAFESEWER_HH_CONFIG ? ["--config", process.env.SAFESEWER_HH_CONFIG] : [];
const say = (s = "") => console.log(s);
const head = (s) => say(`\n=== ${s} ${"=".repeat(Math.max(0, 58 - s.length))}`);
const children = [];
let stopping = false;

function stopAll(code = 0) {
  if (stopping) return; stopping = true;
  for (const c of children) { try { WIN ? spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"]) : process.kill(-c.pid); } catch {} }
  process.exit(code);
}
process.on("SIGINT", () => { say("\nStopping SewerSafe..."); stopAll(0); });
process.on("SIGTERM", () => stopAll(0));
process.on("SIGHUP", () => stopAll(0));                // terminal window closed
const die = (m) => { say(`\n✖ ${m}\n`); stopAll(1); };

function rpcUp(url) {
  return new Promise((res) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname, method: "POST", headers: { "content-type": "application/json" }, timeout: 1500 },
      (r) => { r.resume(); res(true); });
    req.on("error", () => res(false)); req.on("timeout", () => { req.destroy(); res(false); });
    req.end('{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}');
  });
}
const httpUp = (url) => new Promise((res) => { http.get(url, (r) => { r.resume(); res(r.statusCode < 500); }).on("error", () => res(false)); });
const wait = async (fn, s, what) => { for (let i = 0; i < s; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 1000)); } die(`${what} didn't start. See the log file in the project folder.`); };

function openBrowser(url) {
  const cmd = WIN ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try { spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).unref(); } catch {}
}

(async () => {
  head("1/4  Checking your computer");
  const major = Number(process.versions.node.split(".")[0]);
  say(`  Node.js ${process.versions.node}`);
  if (major < 18) die("Node.js 18 or newer is needed. Install the LTS version from https://nodejs.org");

  head("2/4  Packages");
  const needed = ["hardhat", "express", "ethers", "dotenv"];
  if (needed.some((m) => !fs.existsSync(path.join(ROOT, "node_modules", m)))) {
    say("  Installing (first run, 1-3 minutes, needs internet)...");
    const r = spawnSync(NPM, ["install", "--no-audit", "--no-fund"], { stdio: "inherit", shell: WIN });
    if (r.status !== 0) die("npm install failed (see above). Check your internet connection and try again.");
  } else say("  Already installed");

  require("dotenv").config({ path: path.join(ROOT, ".env") });
  const rpc = process.env.CHAIN_RPC || "http://127.0.0.1:8545";
  const port = Number(process.env.PORT || 4000);
  const local = /127\.0\.0\.1|localhost/.test(rpc);

  if (await httpUp(`http://127.0.0.1:${port}/api/health`)) die(`Something is already running on port ${port} (an old SewerSafe window?). Close it and try again.`);

  if (local) {
    head("3/4  Local blockchain + contract");
    if (await rpcUp(rpc)) die("Port 8545 is already in use (an old blockchain window?). Close it, or restart the computer, and try again.");
    const log = fs.openSync(path.join(ROOT, "chain.log"), "w");
    const chain = spawn(NPX, ["hardhat", ...HH, "node", "--hostname", "0.0.0.0"], { cwd: ROOT, shell: WIN, detached: !WIN, stdio: ["ignore", log, log] });
    children.push(chain);
    await wait(() => rpcUp(rpc), 90, "The local blockchain");
    say("  Blockchain running on this laptop (port 8545)");
    const dep = spawnSync(NPX, ["hardhat", ...HH, "run", "scripts/deploy.js", "--network", "localhost"], { cwd: ROOT, shell: WIN, encoding: "utf8" });
    if (dep.status !== 0) { say(dep.stdout + dep.stderr); die("Contract deployment failed (see above)."); }
    say("  " + (dep.stdout.split("\n").find((l) => l.startsWith("SewerSafe")) || "contract deployed").trim());
    // fresh chain → old records point at a contract that no longer exists; archive them
    const db = path.join(ROOT, "data", "sewersafe-db.json");
    if (fs.existsSync(db)) { const a = db.replace(/\.json$/, `-archive-${Date.now()}.json`); fs.renameSync(db, a); say(`  Previous session's data archived to data/${path.basename(a)}`); }
  } else {
    head("3/4  Using the network in .env");
    say(`  CHAIN_RPC=${rpc}`);
    if (!fs.existsSync(path.join(ROOT, "deployment.json"))) die("deployment.json missing. Deploy first: npm run deploy:testnet");
  }

  head("4/4  Backend + dashboard");
  const srv = spawn(process.execPath, [path.join(ROOT, "backend", "server.js")], { cwd: ROOT, detached: !WIN, stdio: ["ignore", "inherit", "inherit"] });
  children.push(srv);
  srv.on("exit", (code) => { if (!stopping) die(`The backend stopped (exit code ${code}). See the messages above.`); });
  await wait(() => httpUp(`http://127.0.0.1:${port}/api/health`), 30, "The backend");
  const url = `http://localhost:${port}`;
  say(`\n✔ SewerSafe is running.  Dashboard: ${url}`);
  say("  Press \"Simulate critical hazard\" on the dashboard to run the full demo.");
  say("  Keep this window open. Press Ctrl+C to stop everything.\n");
  if (!process.env.NO_BROWSER) openBrowser(url);
})().catch((e) => die(e.message));
