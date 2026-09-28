// Risk engine: SAFE / WARNING / CRITICAL from a validated reading.
// Safety-first rules:
//   • Missing data from an installed gas/oxygen sensor is a fault, never "safe".
//   • Humans are never told to enter. The best outcome is "robot first".
//   • All thresholds live in config/thresholds.json.

const GAS_SENSORS = ["methane", "combustible", "air_quality", "h2s", "oxygen"];

const ACTIONS = {
  CRITICAL: "BLOCK_HUMAN_ENTRY_AND_DEPLOY_ROBOT",
  WARNING: "RESTRICT_ENTRY_AND_DEPLOY_ROBOT",
  SENSOR_FAULT: "NO_ENTRY_UNTIL_SENSORS_RESTORED",
  SAFE: "CONTINUE_MONITORING",
};

const ENTRY = { CRITICAL: "BLOCKED", WARNING: "RESTRICTED", SAFE: "ROBOT_FIRST" };

// Map a value between warning and critical (and beyond) to a 0–100 severity score.
function band(value, warn, crit, lv) {
  if (value < warn) return 0;
  if (value < crit) return lv.warning_score + ((value - warn) / (crit - warn)) * (lv.critical_score - 1 - lv.warning_score);
  const over = Math.min(1, (value - crit) / crit);           // 2× critical → 100
  return lv.critical_score + over * (100 - lv.critical_score);
}

function lowBand(value, warn, crit, floor, lv) {             // for "too low" metrics (oxygen)
  if (value > warn) return 0;
  if (value > crit) return lv.warning_score + ((warn - value) / (warn - crit)) * (lv.critical_score - 1 - lv.warning_score);
  const under = Math.min(1, (crit - value) / (crit - floor));
  return lv.critical_score + under * (100 - lv.critical_score);
}

/**
 * @param {object} r  normalized reading from validateReading()
 * @param {object} t  thresholds (config/thresholds.json)
 * @param {object} sewer  sewer config (for installed sensors)
 */
function analyzeRisk(r, t, sewer = { sensors: [] }) {
  const lv = t.levels;
  const found = [];   // { hazard, metric, value, threshold, score }
  const add = (hazard, metric, value, threshold, score) => { if (score > 0) found.push({ hazard, metric, value, threshold, score: Math.round(score) }); };

  if (r.methane != null) add("HIGH_METHANE", "methane", r.methane, t.methane_ppm, band(r.methane, t.methane_ppm.warning, t.methane_ppm.critical, lv));
  if (r.combustible != null) add("HIGH_COMBUSTIBLE_GAS", "combustible", r.combustible, t.combustible_ppm, band(r.combustible, t.combustible_ppm.warning, t.combustible_ppm.critical, lv));
  if (r.air_quality != null) add("POOR_AIR_QUALITY", "air_quality", r.air_quality, t.air_quality_index, band(r.air_quality, t.air_quality_index.warning, t.air_quality_index.critical, lv));
  if (r.h2s != null) add("HIGH_H2S", "h2s", r.h2s, t.h2s_ppm, band(r.h2s, t.h2s_ppm.warning, t.h2s_ppm.critical, lv));
  if (r.oxygen != null) {
    const o = t.oxygen_pct;
    add("LOW_OXYGEN", "oxygen", r.oxygen, o, lowBand(r.oxygen, o.low_warning, o.low_critical, 16, lv));
    add("HIGH_OXYGEN", "oxygen", r.oxygen, o, band(r.oxygen, o.high_warning, o.high_critical, lv));
  }
  if (r.water_level != null) add("HIGH_WATER_LEVEL", "water_level", r.water_level, t.water_level_pct, band(r.water_level, t.water_level_pct.warning, t.water_level_pct.critical, lv));
  if (r.temperature != null) add("HIGH_TEMPERATURE", "temperature", r.temperature, t.temperature_c, band(r.temperature, t.temperature_c.warning, t.temperature_c.critical, lv));

  // installed gas/oxygen sensor with no valid value → fault (keeps level at WARNING at least)
  const faulty = (r.missing_sensors || []).filter((s) => GAS_SENSORS.includes(s));
  if (faulty.length) found.push({ hazard: "SENSOR_FAULT", metric: faulty.join(","), value: null, threshold: null, score: lv.warning_score + 5 });

  const warnings = found.filter((h) => h.score >= lv.warning_score && h.score < lv.critical_score);
  let score = found.length ? Math.max(...found.map((h) => h.score)) : 0;
  if (found.length > 1) score += (found.length - 1) * t.combined.extra_points_per_hazard;
  score = Math.min(100, Math.round(score));

  const hazards = found.map((h) => h.hazard);
  if (warnings.length >= t.combined.warnings_for_critical) {
    hazards.push("COMBINED_HAZARDS");
    score = Math.max(score, lv.critical_score);
  }

  const level = score >= lv.critical_score ? "CRITICAL" : score >= lv.warning_score ? "WARNING" : "SAFE";

  // cover open (MPU6050 tilt) isn't a gas hazard, but matters for human-entry prevention
  const coverOpen = r.tilt != null && t.tilt_deg && r.tilt >= t.tilt_deg.cover_open;
  if (coverOpen) hazards.push("COVER_OPEN");

  let action = ACTIONS[level];
  if (level !== "CRITICAL" && faulty.length) action = ACTIONS.SENSOR_FAULT;

  return {
    risk_level: level,
    risk_score: score,
    triggered_hazards: hazards,
    recommended_action: action,
    human_entry: level === "SAFE" && faulty.length ? "RESTRICTED" : ENTRY[level],
    cover_open: !!coverOpen,
    details: found,
    disclaimer: "Prototype indicator readings, not certified gas measurements.",
  };
}

module.exports = { analyzeRisk, ACTIONS };
