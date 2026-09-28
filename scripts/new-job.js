// Post another job (reuse between demo runs).  npx hardhat run scripts/new-job.js --network mstTestnet
const { ethers } = require("hardhat");
const fs = require("fs");

async function main() {
  const d = JSON.parse(fs.readFileSync("deployment.json"));
  const [city] = await ethers.getSigners();
  const c = new ethers.Contract(d.contract, d.abi, city);
  const deadline = Math.floor(Date.now() / 1000) + 24 * 3600;
  await (await c.postJob(d.contractor, ethers.id(d.manholeTag), d.minDuration, deadline,
    { value: ethers.parseEther(process.env.PAYMENT || "1") })).wait();
  d.jobId = Number(await c.jobCount());
  fs.writeFileSync("deployment.json", JSON.stringify(d, null, 2));
  console.log(`job #${d.jobId} posted`);
}
main().catch((e) => { console.error(e); process.exit(1); });
