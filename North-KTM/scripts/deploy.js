// Deploys SewerSafe and sets up a demo: registers the robot, bonds the contractor, posts one job.
//
// LOCAL (no wallet needed):   npm run chain      (terminal 1, leave running)
//                             npm run deploy:local
//
// MST TESTNET: fill .env (MST_PRIVATE_KEY, CONTRACTOR_KEY, ROBOT_ADDRESS), then
//                             npm run deploy:testnet
//
// Writes deployment.json, which the robot script reads.
const { ethers, network } = require("hardhat");
const fs = require("fs");

const LOCAL = network.name === "localhost" || network.name === "hardhat";
// Hardhat's built-in test account #2. Its key is public; use it ONLY on the local chain.
const LOCAL_ROBOT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const CFG = {
  bond: process.env.BOND || "0.5",             // MSTC contractor must lock
  payment: process.env.PAYMENT || "1",         // MSTC escrowed per job
  challengeWindow: Number(process.env.WINDOW || (LOCAL ? 10 : 60)),   // seconds inspectors can dispute
  minDuration: Number(process.env.MIN_DURATION || (LOCAL ? 15 : 10)), // seconds robot must run (sim maintenance run ≈ 20 s)
  manholeTag: process.env.MANHOLE_TAG || "BBMP-JAYANAGAR-MH-0417",
};

async function main() {
  const signers = await ethers.getSigners();
  const city = signers[0];
  if (!city) throw new Error("No deployer key. Put MST_PRIVATE_KEY in .env (see .env.example)");
  const contractor = LOCAL
    ? signers[1]
    : process.env.CONTRACTOR_KEY && new ethers.Wallet(process.env.CONTRACTOR_KEY, ethers.provider);
  const robot = LOCAL ? LOCAL_ROBOT : process.env.ROBOT_ADDRESS;
  if (!contractor) throw new Error("Put CONTRACTOR_KEY in .env");
  if (!robot) throw new Error("Put ROBOT_ADDRESS in .env (run: python robot/robot_agent.py --new-key)");

  // Welfare fund: for the demo, a fresh address anyone can inspect on the explorer.
  const welfare = process.env.WELFARE_ADDRESS || ethers.Wallet.createRandom().address;

  console.log(`network      ${network.name}`);
  console.log(`municipality ${city.address}`);
  console.log(`contractor   ${contractor.address}`);
  console.log(`robot        ${robot}`);

  const F = await ethers.getContractFactory("SewerSafe", city);
  const c = await F.deploy(welfare, CFG.challengeWindow, ethers.parseEther(CFG.bond));
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`SewerSafe    ${addr}`);

  await (await c.registerRobot(robot, contractor.address)).wait();
  // Locally, lock several bonds' worth so repeated demos (each entry attempt slashes one) keep working.
  const deposit = process.env.BOND_DEPOSIT || (LOCAL ? "5" : CFG.bond);
  await (await c.connect(contractor).depositBond({ value: ethers.parseEther(deposit) })).wait();

  const manholeId = ethers.id(CFG.manholeTag);
  const deadline = Math.floor(Date.now() / 1000) + 24 * 3600;
  await (await c.postJob(contractor.address, manholeId, CFG.minDuration, deadline,
    { value: ethers.parseEther(CFG.payment) })).wait();
  const jobId = Number(await c.jobCount());
  console.log(`job #${jobId} posted for manhole ${CFG.manholeTag}`);

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    rpc: network.config.url || "http://127.0.0.1:8545",
    contract: addr,
    municipality: city.address,
    contractor: contractor.address,
    robot, welfare, jobId,
    manholeTag: CFG.manholeTag,
    minDuration: CFG.minDuration,
    challengeWindow: CFG.challengeWindow,
    abi: JSON.parse(c.interface.formatJson()),
  };
  fs.writeFileSync("deployment.json", JSON.stringify(out, null, 2));
  console.log("wrote deployment.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
