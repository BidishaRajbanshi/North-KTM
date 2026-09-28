// Release payment once the inspectors' challenge window is over.
// Waits automatically if the window is still open.
//   npm run release:local      (or npm run release:testnet)
const { ethers } = require("hardhat");
const fs = require("fs");

const STATUS = ["None", "Open", "Proven", "Disputed", "Paid", "HumanEntry", "Refunded"];

async function main() {
  const d = JSON.parse(fs.readFileSync("deployment.json"));
  const [anyone] = await ethers.getSigners();
  const c = new ethers.Contract(d.contract, d.abi, anyone);
  const id = Number(process.env.JOB || d.jobId);
  const job = await c.jobs(id);
  const status = STATUS[Number(job.status)];

  if (status !== "Proven") {
    console.log(`job #${id} is "${status}", nothing to release.`);
    if (status === "Open") console.log("Run the robot first:  python robot/robot_agent.py --mock");
    if (status === "HumanEntry") console.log("A human entered the manhole, so this job is never paid. Post a new job: npm run job:local");
    return;
  }

  const window = Number(await c.challengeWindow());
  const readyAt = Number(job.provenAt) + window + 1;
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  if (now < readyAt) {
    const wait = readyAt - now;
    console.log(`challenge window still open, waiting ${wait}s...`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }

  const before = await ethers.provider.getBalance(d.contractor);
  const rc = await (await c.release(id)).wait();
  const after = await ethers.provider.getBalance(d.contractor);
  console.log(`job #${id} PAID: contractor +${ethers.formatEther(after - before)} MSTC   tx ${rc.hash}`);
}
main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
