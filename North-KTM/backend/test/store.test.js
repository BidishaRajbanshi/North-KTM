const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FileStore } = require("../store");

test("file store: insert/get/update/list/count and persistence across restarts", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ss-")), "db.json");
  const s = await new FileStore(file).init();
  await s.insert("alerts", { id: "A1", sewer_id: "S101", severity: "CRITICAL", created_at: "2026-01-01" });
  await s.insert("alerts", { id: "A2", sewer_id: "S102", severity: "WARNING", created_at: "2026-01-02" });
  await s.update("alerts", "A1", { acknowledged: true });
  assert.equal((await s.get("alerts", "A1")).acknowledged, true);
  assert.equal(await s.count("alerts", { severity: "CRITICAL" }), 1);
  assert.deepEqual((await s.list("alerts", { sort: { created_at: -1 } })).map((a) => a.id), ["A2", "A1"]);
  await s.close();

  const s2 = await new FileStore(file).init();
  assert.equal((await s2.get("alerts", "A1")).acknowledged, true);
});

test("file store: returned docs are copies (callers can't corrupt the DB)", async () => {
  const s = await new FileStore(null).init();
  await s.insert("inspections", { id: "I1", status: "PENDING" });
  const d = await s.get("inspections", "I1");
  d.status = "HACKED";
  assert.equal((await s.get("inspections", "I1")).status, "PENDING");
});

test("file store: readings are capped per sewer", async () => {
  const s = await new FileStore(null).init();
  for (let i = 0; i < 320; i++) await s.insert("readings", { id: "R" + i, sewer_id: "S101" });
  assert.equal(await s.count("readings", { sewer_id: "S101" }), 300);
  assert.equal((await s.list("readings"))[0].id, "R20");
});

test("file store: a corrupt file is set aside, not fatal", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ss-")), "db.json");
  fs.writeFileSync(file, "{not json");
  const s = await new FileStore(file).init();
  assert.equal(await s.count("alerts"), 0);
});
