const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeRisk } = require("../risk");
const { loadConfig } = require("../config");

const { thresholds: t } = loadConfig();
const base = { methane: 150, combustible: 120, air_quality: 60, oxygen: 20.8, water_level: 30, temperature: 29, humidity: 70, missing_sensors: [] };

test("SAFE: normal air → continue monitoring, and humans still get 'robot first', never 'enter'", () => {
  const r = analyzeRisk(base, t);
  assert.equal(r.risk_level, "SAFE");
  assert.equal(r.risk_score, 0);
  assert.equal(r.recommended_action, "CONTINUE_MONITORING");
  assert.equal(r.human_entry, "ROBOT_FIRST");
});

test("WARNING: methane between warning and critical", () => {
  const r = analyzeRisk({ ...base, methane: 2500 }, t);
  assert.equal(r.risk_level, "WARNING");
  assert.ok(r.risk_score >= 40 && r.risk_score < 70);
  assert.deepEqual(r.triggered_hazards, ["HIGH_METHANE"]);
  assert.equal(r.recommended_action, "RESTRICT_ENTRY_AND_DEPLOY_ROBOT");
});

test("CRITICAL: methane over critical → block human entry and deploy robot", () => {
  const r = analyzeRisk({ ...base, methane: 7000 }, t);
  assert.equal(r.risk_level, "CRITICAL");
  assert.equal(r.recommended_action, "BLOCK_HUMAN_ENTRY_AND_DEPLOY_ROBOT");
  assert.equal(r.human_entry, "BLOCKED");
});

test("CRITICAL: low oxygen alone (below 19.5%)", () => {
  const r = analyzeRisk({ ...base, oxygen: 18.5 }, t);
  assert.equal(r.risk_level, "CRITICAL");
  assert.ok(r.triggered_hazards.includes("LOW_OXYGEN"));
});

test("multiple hazards raise the score above the worst single one", () => {
  const one = analyzeRisk({ ...base, methane: 9000 }, t).risk_score;
  const two = analyzeRisk({ ...base, methane: 9000, oxygen: 18.5 }, t);
  assert.ok(two.risk_score > one);
  assert.deepEqual(two.triggered_hazards.slice(0, 2).sort(), ["HIGH_METHANE", "LOW_OXYGEN"]);
});

test("three simultaneous WARNINGs escalate to CRITICAL (COMBINED_HAZARDS)", () => {
  const r = analyzeRisk({ ...base, methane: 1200, air_quality: 160, water_level: 62 }, t);
  assert.equal(r.risk_level, "CRITICAL");
  assert.ok(r.triggered_hazards.includes("COMBINED_HAZARDS"));
});

test("missing gas sensor data is a fault, never SAFE", () => {
  const r = analyzeRisk({ ...base, methane: null, missing_sensors: ["methane"] }, t);
  assert.notEqual(r.risk_level, "SAFE");
  assert.ok(r.triggered_hazards.includes("SENSOR_FAULT"));
  assert.equal(r.recommended_action, "NO_ENTRY_UNTIL_SENSORS_RESTORED");
});

test("high water level and high temperature are hazards", () => {
  assert.equal(analyzeRisk({ ...base, water_level: 90 }, t).risk_level, "CRITICAL");
  assert.equal(analyzeRisk({ ...base, temperature: 45 }, t).risk_level, "WARNING");
});

test("cover open (tilt) is reported for entry prevention", () => {
  const r = analyzeRisk({ ...base, tilt: 70 }, t);
  assert.equal(r.cover_open, true);
  assert.ok(r.triggered_hazards.includes("COVER_OPEN"));
});

test("thresholds are configurable", () => {
  const strict = JSON.parse(JSON.stringify(t));
  strict.methane_ppm = { warning: 100, critical: 140 };
  assert.equal(analyzeRisk(base, strict).risk_level, "CRITICAL");
});

test("score is always 0..100", () => {
  const r = analyzeRisk({ ...base, methane: 100000, combustible: 100000, air_quality: 1000, oxygen: 5, water_level: 100, temperature: 100 }, t);
  assert.ok(r.risk_score <= 100 && r.risk_score >= 70);
});
