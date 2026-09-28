// Print the contract's current state: jobs, balances, city record.
//   npm run status:local      (or npm run status:testnet)
const { ethers } = require("hardhat");
const fs = require("fs");

const STATUS = ["None", "Open", "Proven", "Disputed", "Paid", "HumanEntry", "Refunded"];
const f = (w) => ethers.formatEther(w) + " MSTC";

async function main() {
  const d = JSON.parse(fs.readFileSync("deployment.json"));
  const c = new ethers.Contract(d.contract, d.abi, ethers.provider);
  const n = Number(await c.jobCount());
  console.log(`SewerSafe ${d.contract} on ${d.network}\n`);
  for (let i = 1; i <= n; i++) {
    const j = await c.jobs(i);
    console.log(`job #${i}  ${STATUS[Number(j.status)].padEnd(10)}  escrow ${f(j.payment).padEnd(12)}  peak H2S ${j.maxGasPpm} ppm`);
  }
  console.log(`\ncontractor bond   ${f(await c.bond(d.contractor))}`);
  console.log(`welfare fund      ${f(await ethers.provider.getBalance(d.welfare))}`);
  console.log(`safe jobs paid    ${await c.safeJobs()}`);
  console.log(`human entries     ${await c.humanEntries()}`);
}
main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
