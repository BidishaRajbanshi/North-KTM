// SewerSafe — run the WHOLE demo with one command:
//
//     node scripts/demo-all.js
//
// (or double-click START-DEMO.bat on Windows / START-DEMO.command on Mac)
//
// It checks your setup, installs anything missing, starts a local blockchain,
// deploys the contract, runs the robot twice (clean job, then human entry)
// and prints the final result. Nothing here touches the real MST chain.
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);
const WIN = process.platform === "win32";
const NPX = WIN ? "npx.cmd" : "npx";
const NPM = WIN ? "npm.cmd" : "npm";
const HH_EXTRA = process.env.SAFESEWER_HH_CONFIG ? ["--config", process.env.SAFESEWER_HH_CONFIG] : [];

const say = (s = "") => console.log(s);
const head = (s) => say(`\n=== ${s} ${"=".repeat(Math.max(0, 60 - s.length))}`);
const die = (msg) => { say(`\n✖ ${msg}\n`); cleanup(); process.exit(1); };

let chain;
function cleanup() { if (chain && !chain.killed) { try { WIN ? spawnSync("taskkill", ["/pid", String(chain.pid), "/T", "/F"]) : process.kill(-chain.pid); } catch {} } }
process.on("SIGINT", () => { cleanup(); process.exit(130); });

function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: WIN, env: { ...process.env, PYTHONUTF8: "1" } });
  if (r.status !== 0) die(`${label} failed (see messages above).`);
}

// ---------------------------------------------------------------- 1. checks
function findPython() {
  for (const cmd of (WIN ? ["python", "py", "python3"] : ["python3", "python"])) {
    const r = spawnSync(cmd, ["-c", "import sys;print('%d.%d'%sys.version_info[:2])"], { encoding: "utf8", shell: WIN });
    if (r.status === 0) {
      const [maj, min] = r.stdout.trim().split(".").map(Number);
      if (maj === 3 && min >= 10) return { cmd, ver: r.stdout.trim() };
      say(`  found Python ${r.stdout.trim()} via "${cmd}" — need 3.10 or newer`);
    }
  }
  return null;
}

function rpcUp() {
  return new Promise((res) => {
    const req = http.request({ host: "127.0.0.1", port: 8545, method: "POST", headers: { "content-type": "application/json" }, timeout: 1500 },
      (r) => { r.resume(); res(true); });
    req.on("error", () => res(false)); req.on("timeout", () => { req.destroy(); res(false); });
    req.end('{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}');
  });
}

async function main() {
  head("1/7  Checking your computer");
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  say(`  Node.js ${process.versions.node}`);
  if (nodeMajor < 18) die("Node.js is too old. Install the LTS version from https://nodejs.org and try again.");

  const py = findPython();
  if (!py) die("Python 3.10+ not found. Install it from https://www.python.org (Windows: tick \"Add python.exe to PATH\"), restart VS Code, try again.");
  say(`  Python ${py.ver} ("${py.cmd}")`);

  head("2/7  Installing packages (first run only)");
  if (!fs.existsSync(path.join(ROOT, "node_modules", "hardhat"))) {
    say("  npm install ... (1–3 minutes)"); run(NPM, ["install", "--no-audit", "--no-fund"], "npm install");
  } else say("  Node packages already installed");
  const hasPy = spawnSync(py.cmd, ["-c", "import mst_blockchain_sdk, eth_abi, web3"], { shell: WIN }).status === 0;
  if (!hasPy) {
    say("  pip install ... (1–2 minutes)");
    run(py.cmd, ["-m", "pip", "install", "--disable-pip-version-check", "-r", "robot/requirements.txt"], "pip install");
  } else say("  Python packages already installed");

  head("3/7  Checking the contract (8 automated tests)");
  run(NPX, ["hardhat", ...HH_EXTRA, "test"], "Contract tests");

  head("4/7  Starting a local blockchain on your laptop");
  if (await rpcUp()) die("Something is already running on port 8545 (probably an old blockchain window). Close it, or restart VS Code, then try again.");
  chain = spawn(NPX, ["hardhat", ...HH_EXTRA, "node"], { cwd: ROOT, shell: WIN, detached: !WIN, stdio: ["ignore", "pipe", "pipe"] });
  const log = fs.createWriteStream(path.join(ROOT, "chain.log"));
  chain.stdout.pipe(log); chain.stderr.pipe(log);
  for (let i = 0; i < 60 && !(await rpcUp()); i++) await new Promise((r) => setTimeout(r, 1000));
  if (!(await rpcUp())) die("Local blockchain didn't start. See chain.log in the project folder.");
  say("  running at http://127.0.0.1:8545");

  const hh = (script, label) => run(NPX, ["hardhat", ...HH_EXTRA, "run", `scripts/${script}`, "--network", "localhost"], label);
  const robot = (args, label) => run(py.cmd, ["robot/robot_agent.py", "--mock", ...args], label);

  head("5/7  Deploying SewerSafe + posting job #1");
  hh("deploy.js", "Deploy");

  head("6/7  CLEAN JOB: robot works alone → contractor gets paid");
  robot([], "Robot (clean job)");
  hh("release.js", "Release payment");

  head("7/7  HUMAN ENTRY: person goes into the manhole");
  hh("new-job.js", "Post job #2");
  robot(["--scenario", "human"], "Robot (human entry)");

  head("RESULT");
  hh("status.js", "Status");
  say("\n✔ Everything ran. Job #1 was paid; job #2 was blocked and the bond went to the welfare fund.");
  say("  Pitch screen: open dashboard/index.html in your browser.\n");
  cleanup();
  process.exit(0);
}

main().catch((e) => die(e.message || String(e)));
