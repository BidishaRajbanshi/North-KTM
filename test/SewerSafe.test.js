const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const MANHOLE = ethers.id("BBMP-JAYANAGAR-MH-0417");

describe("SewerSafe", () => {
  let c, city, contractor, robot, rogueRobot, welfare, inspector, anyone;

  async function sign(signer, proof) {
    const digest = await c.proofDigest(proof);
    return signer.signMessage(ethers.getBytes(digest));
  }

  async function newJob(minDur = 600) {
    const deadline = (await time.latest()) + 86400;
    await c.connect(city).postJob(contractor.address, MANHOLE, minDur, deadline, { value: E(10) });
    return await c.jobCount();
  }

  function proof(jobId, over = {}) {
    return {
      jobId, manholeId: MANHOLE, evidenceHash: ethers.id("bundle-" + Math.random()),
      startedAt: 1_000, endedAt: 2_000, humanDetected: false, maxGasPpm: 85, ...over,
    };
  }

  beforeEach(async () => {
    [city, contractor, robot, rogueRobot, welfare, inspector, anyone] = await ethers.getSigners();
    const F = await ethers.getContractFactory("SewerSafe");
    c = await F.connect(city).deploy(welfare.address, 60, E(5));
    await c.registerRobot(robot.address, contractor.address);
    await c.setInspector(inspector.address, true);
    await c.connect(contractor).depositBond({ value: E(5) });
  });

  it("pays the contractor after a valid robot proof + challenge window", async () => {
    const id = await newJob();
    const p = proof(id);
    await expect(c.connect(anyone).submitProof(p, await sign(robot, p)))
      .to.emit(c, "ProofAccepted");
    await expect(c.release(id)).to.be.revertedWithCustomError(c, "WindowOpen");
    await time.increase(61);
    await expect(c.release(id)).to.changeEtherBalance(contractor, E(10));
    expect(await c.safeJobs()).to.equal(1n);
  });

  it("rejects a proof signed by an unregistered device", async () => {
    const id = await newJob();
    const p = proof(id);
    await expect(c.submitProof(p, await sign(rogueRobot, p)))
      .to.be.revertedWithCustomError(c, "BadSigner");
  });

  it("rejects a tampered proof (signature no longer matches)", async () => {
    const id = await newJob();
    const p = proof(id);
    const sig = await sign(robot, p);
    const tampered = { ...p, humanDetected: false, maxGasPpm: 5, endedAt: 3_000 };
    await expect(c.submitProof(tampered, sig)).to.be.revertedWithCustomError(c, "BadSigner");
  });

  it("rejects the wrong manhole and too-short runs", async () => {
    const id = await newJob();
    const p1 = proof(id, { manholeId: ethers.id("OTHER") });
    await expect(c.submitProof(p1, await sign(robot, p1))).to.be.revertedWithCustomError(c, "WrongManhole");
    const p2 = proof(id, { endedAt: 1_100 });
    await expect(c.submitProof(p2, await sign(robot, p2))).to.be.revertedWithCustomError(c, "TooShort");
  });

  it("blocks replay of the same evidence on a second job", async () => {
    const id1 = await newJob();
    const p = proof(id1);
    await c.submitProof(p, await sign(robot, p));
    const id2 = await newJob();
    const p2 = { ...p, jobId: id2 };
    await expect(c.submitProof(p2, await sign(robot, p2))).to.be.revertedWithCustomError(c, "EvidenceReused");
  });

  it("HUMAN ENTRY: records it, refunds the city, slashes bond to welfare fund", async () => {
    const id = await newJob();
    const p = proof(id, { humanDetected: true, endedAt: 1_050 });
    const tx = c.submitProof(p, await sign(robot, p));
    await expect(tx).to.emit(c, "HumanEntryDetected");
    await expect(tx).to.changeEtherBalances([welfare, city], [E(5), E(10)]);
    const j = await c.jobs(id);
    expect(j.status).to.equal(5n); // HumanEntry
    expect(await c.humanEntries()).to.equal(1n);
    expect(await c.bond(contractor.address)).to.equal(0n);
    // and the contractor can no longer take jobs until they re-bond
    const dl = (await time.latest()) + 86400;
    await expect(c.postJob(contractor.address, MANHOLE, 600, dl, { value: E(1) }))
      .to.be.revertedWithCustomError(c, "InsufficientBond");
  });

  it("inspector dispute → municipality refund", async () => {
    const id = await newJob();
    const p = proof(id);
    await c.submitProof(p, await sign(robot, p));
    await c.connect(inspector).dispute(id, "footage shows a different manhole");
    await expect(c.release(id)).to.be.revertedWithCustomError(c, "BadStatus");
    await expect(c.resolve(id, false)).to.changeEtherBalance(city, E(10));
  });

  it("no proof by deadline → city reclaims", async () => {
    const id = await newJob();
    await time.increase(86401);
    await expect(c.connect(anyone).reclaim(id)).to.changeEtherBalance(city, E(10));
  });
});
