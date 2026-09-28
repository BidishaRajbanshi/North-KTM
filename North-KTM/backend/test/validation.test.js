const test = require("node:test");
const assert = require("node:assert/strict");
const { validateReading } = require("../validation");
const { loadConfig } = require("../config");

const cfg = loadConfig();
const now = new Date("2026-09-28T12:00:00Z");
const ctx = { sewers: cfg.sewers, thresholds: cfg.thresholds, now };
const good = { sewer_id: "S103", timestamp: now.toISOString(), methane: 72, air_quality: 45, combustible: 60,
  oxygen: 20.8, water_level: 35, temperature: 31, humidity: 72 };

test("accepts a complete valid reading", () => {
  const v = validateReading(good, ctx);
  assert.equal(v.ok, true);
  assert.equal(v.reading.methane, 72);
  assert.deepEqual(v.missing_sensors, []);
});

test("rejects unknown sewer with 404", () => {
  const v = validateReading({ ...good, sewer_id: "S999" }, ctx);
  assert.equal(v.status, 404);
});

test("rejects missing sewer_id and non-object bodies", () => {
  assert.equal(validateReading({ methane: 5 }, ctx).status, 400);
  assert.equal(validateReading("hello", ctx).status, 400);
  assert.equal(validateReading([1, 2], ctx).status, 400);
});

test("rejects stale readings (older than stale_after_seconds)", () => {
  const old = new Date(now - (cfg.thresholds.stale_after_seconds + 5) * 1000).toISOString();
  const v = validateReading({ ...good, timestamp: old }, ctx);
  assert.equal(v.status, 422);
  assert.equal(v.errors[0].code, "STALE_READING");
});

test("rejects future timestamps and garbage timestamps", () => {
  assert.equal(validateReading({ ...good, timestamp: new Date(+now + 600e3).toISOString() }, ctx).errors[0].code, "FUTURE_TIMESTAMP");
  assert.equal(validateReading({ ...good, timestamp: "yesterday-ish" }, ctx).errors[0].code, "INVALID_TIMESTAMP");
});

test("invalid values are dropped and reported, never kept", () => {
  const v = validateReading({ ...good, methane: "abc", oxygen: 99 }, ctx);
  assert.equal(v.ok, true);
  assert.equal(v.reading.methane, null);
  assert.equal(v.reading.oxygen, null);
  assert.deepEqual(v.errors.map((e) => e.code).sort(), ["NOT_A_NUMBER", "OUT_OF_RANGE"]);
  assert.ok(v.missing_sensors.includes("methane") && v.missing_sensors.includes("oxygen"));
});

test("missing installed sensor is flagged as disconnected", () => {
  const { oxygen, ...rest } = good;
  const v = validateReading(rest, ctx);
  assert.deepEqual(v.missing_sensors, ["oxygen"]);
  assert.ok(v.warnings.some((w) => w.code === "SENSOR_DISCONNECTED"));
});

test("a sensor that isn't installed is not a fault when absent", () => {
  const v = validateReading({ sewer_id: "S102", methane: 100, air_quality: 50, combustible: 90, water_level: 20, temperature: 28, humidity: 70 }, ctx);
  assert.deepEqual(v.missing_sensors, []);   // S102 has no oxygen sensor
});

test("reading with no valid values is rejected", () => {
  const v = validateReading({ sewer_id: "S101", methane: -5, oxygen: "x" }, ctx);
  assert.equal(v.status, 422);
});

test("numeric strings are accepted (some firmware sends strings)", () => {
  const v = validateReading({ ...good, methane: "88.5" }, ctx);
  assert.equal(v.reading.methane, 88.5);
});
