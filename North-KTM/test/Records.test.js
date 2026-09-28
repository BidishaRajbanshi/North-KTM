const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const ID = ethers.id("INS-2026-0001");
const H1 = ethers.id("report-v1");
const H2 = ethers.id("report-v2");

describe("SewerSafe inspection records", () => {
  let c, city, stranger, backend;

  beforeEach(async () => {
    [city, stranger, backend] = await ethers.getSigners();
    const F = await ethers.getContractFactory("SewerSafe");
    c = await F.connect(city).deploy(city.address, 60, E(0.5));
  });

  it("recordHazard opens a record; getInspection returns it", async () => {
    await expect(c.recordHazard(ID, "S101", 2, 92, "HIGH_METHANE,LOW_OXYGEN", H1))
      .to.emit(c, "HazardRecorded").withArgs(ID, "S101", 2, 92, "HIGH_METHANE,LOW_OXYGEN", H1);
    const r = await c.getInspection(ID);
    expect(r.sewerId).to.equal("S101");
    expect(r.risk).to.equal(2);
    expect(r.riskScore).to.equal(92);
    expect(r.inspectionStatus).to.equal(1);  // OPEN
    expect(r.reportHash).to.equal(H1);
    expect(await c.recordCount()).to.equal(1n);
  });

  it("full lifecycle: hazard → robot deployment → inspection → maintenance", async () => {
    await c.recordHazard(ID, "S101", 2, 92, "HIGH_METHANE", H1);
    await expect(c.recordRobotDeployment(ID, "R1")).to.emit(c, "RobotDeploymentRecorded").withArgs(ID, "S101", "R1");
    await expect(c.recordInspection({ inspectionId: ID, sewerId: "S101", risk: 2, riskScore: 92, hazardSummary: "HIGH_METHANE",
      robotStatus: 2, inspectionStatus: 2, maintenanceStatus: 2, reportHash: H2 })).to.emit(c, "InspectionRecorded");
    await expect(c.recordMaintenanceCompletion(ID, ethers.id("report-v3"))).to.emit(c, "MaintenanceCompleted");
    const r = await c.getInspection(ID);
    expect(r.robotId).to.equal("R1");
    expect(r.robotStatus).to.equal(2);        // COMPLETED
    expect(r.inspectionStatus).to.equal(2);   // COMPLETED
    expect(r.maintenanceStatus).to.equal(3);  // COMPLETED
    expect(r.version).to.equal(4);
    expect(r.updatedAt).to.be.gte(r.createdAt);
  });

  it("only authorised recorders can write", async () => {
    await expect(c.connect(stranger).recordHazard(ID, "S101", 2, 90, "X", H1)).to.be.revertedWithCustomError(c, "NotRecorder");
    await expect(c.connect(stranger).setRecorder(stranger.address, true)).to.be.revertedWithCustomError(c, "NotMunicipality");
    await c.setRecorder(backend.address, true);
    await expect(c.connect(backend).recordHazard(ID, "S101", 2, 90, "X", H1)).to.emit(c, "HazardRecorded");
    await c.setRecorder(backend.address, false);
    await expect(c.connect(backend).recordRobotDeployment(ID, "R1")).to.be.revertedWithCustomError(c, "NotRecorder");
  });

  it("rejects bad values and unknown records", async () => {
    await expect(c.recordHazard(ID, "S101", 3, 90, "X", H1)).to.be.revertedWithCustomError(c, "BadValue");
    await expect(c.recordHazard(ID, "S101", 2, 101, "X", H1)).to.be.revertedWithCustomError(c, "BadValue");
    await expect(c.recordHazard(ID, "", 2, 50, "X", H1)).to.be.revertedWithCustomError(c, "BadValue");
    await expect(c.recordRobotDeployment(ID, "R1")).to.be.revertedWithCustomError(c, "UnknownRecord");
    await expect(c.recordMaintenanceCompletion(ID, H1)).to.be.revertedWithCustomError(c, "UnknownRecord");
    await expect(c.getInspection(ID)).to.be.revertedWithCustomError(c, "UnknownRecord");
    expect(await c.hasInspection(ID)).to.equal(false);
  });

  it("an inspection can't be moved to a different sewer", async () => {
    await c.recordHazard(ID, "S101", 2, 90, "X", H1);
    await expect(c.recordHazard(ID, "S999", 2, 90, "X", H1)).to.be.revertedWithCustomError(c, "BadValue");
  });

  it("escrow still works alongside records (bond + job)", async () => {
    await c.depositBond({ value: E(0.5) });
    const dl = Math.floor(Date.now() / 1000) + 86400;
    await expect(c.postJob(city.address, ethers.id("S101"), 10, dl, { value: E(1) })).to.emit(c, "JobPosted");
  });
});
