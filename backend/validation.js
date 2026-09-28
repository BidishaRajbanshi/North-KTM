// Sensor input validation and normalization.
// Rule: a bad or missing value is NEVER silently treated as a safe value.

const FIELDS = {
  methane:     { min: 0,   max: 100000, unit: "ppm (indicative)" },
  combustible: { min: 0,   max: 100000, unit: "ppm (indicative)" },
  air_quality: { min: 0,   max: 1000,   unit: "index" },
  h2s:         { min: 0,   max: 1000,   unit: "ppm (indicative)" },
  oxygen:      { min: 0,   max: 30,     unit: "% vol" },
  water_level: { min: 0,   max: 100,    unit: "% of pipe" },
  temperature: { min: -20, max: 100,    unit: "°C" },
  humidity:    { min: 0,   max: 100,    unit: "% RH" },
  tilt:        { min: 0,   max: 180,    unit: "°" },
};

const MAX_FUTURE_SKEW_S = 60;

/**
 * @param {object} raw        body posted by a device or the simulator
 * @param {object} ctx        { sewers: [...], thresholds, now: Date }
 * @returns {{ ok, status, reading, errors, warnings, missing_sensors }}
 *   ok=false with status 400/404/422 means the reading was rejected entirely.
 */
function validateReading(raw, ctx) {
  const errors = [];
  const warnings = [];
  const now = ctx.now || new Date();

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return reject(400, [{ field: "body", code: "INVALID_BODY", message: "Body must be a JSON object" }]);
  }

  const sewerId = typeof raw.sewer_id === "string" ? raw.sewer_id.trim().toUpperCase() : "";
  if (!sewerId) return reject(400, [{ field: "sewer_id", code: "REQUIRED", message: "sewer_id is required" }]);
  const sewer = ctx.sewers.find((s) => s.id === sewerId);
  if (!sewer) return reject(404, [{ field: "sewer_id", code: "UNKNOWN_SEWER", message: `No sewer ${sewerId}` }]);

  // timestamp: optional (server time used), but if given it must be valid, not in the future, not stale
  let ts = now;
  if (raw.timestamp !== undefined && raw.timestamp !== null) {
    const t = new Date(raw.timestamp);
    if (Number.isNaN(t.getTime())) {
      return reject(400, [{ field: "timestamp", code: "INVALID_TIMESTAMP", message: "timestamp must be ISO 8601" }]);
    }
    const ageS = (now - t) / 1000;
    if (ageS < -MAX_FUTURE_SKEW_S) {
      return reject(422, [{ field: "timestamp", code: "FUTURE_TIMESTAMP", message: "timestamp is in the future: check the device clock" }]);
    }
    if (ageS > ctx.thresholds.stale_after_seconds) {
      return reject(422, [{ field: "timestamp", code: "STALE_READING",
        message: `reading is ${Math.round(ageS)}s old (limit ${ctx.thresholds.stale_after_seconds}s)` }]);
    }
    ts = t;
  }

  const reading = { sewer_id: sewerId, timestamp: ts.toISOString(), received_at: now.toISOString() };
  const installed = sewer.sensors || [];
  const missing = [];

  for (const [field, spec] of Object.entries(FIELDS)) {
    const v = raw[field];
    if (v === undefined || v === null || v === "") {
      reading[field] = null;
      if (installed.includes(field)) missing.push(field);
      continue;
    }
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n)) {
      errors.push({ field, code: "NOT_A_NUMBER", message: `${field} must be a number` });
      reading[field] = null;
      if (installed.includes(field)) missing.push(field);
      continue;
    }
    if (n < spec.min || n > spec.max) {
      errors.push({ field, code: "OUT_OF_RANGE", message: `${field}=${n} outside ${spec.min}..${spec.max} ${spec.unit}` });
      reading[field] = null;
      if (installed.includes(field)) missing.push(field);
      continue;
    }
    if (!installed.includes(field)) warnings.push({ field, code: "NOT_INSTALLED", message: `${field} sent but not listed for ${sewerId}` });
    reading[field] = Math.round(n * 100) / 100;
  }

  if (missing.length) warnings.push({ field: missing.join(","), code: "SENSOR_DISCONNECTED",
    message: `no valid value from installed sensor(s): ${missing.join(", ")}` });

  const anyValue = Object.keys(FIELDS).some((f) => reading[f] !== null);
  if (!anyValue) return reject(422, [...errors, { field: "*", code: "NO_VALID_VALUES", message: "no valid sensor values in reading" }]);

  reading.missing_sensors = missing;
  if (raw.device_id) reading.device_id = String(raw.device_id).slice(0, 64);
  return { ok: true, status: 201, reading, errors, warnings, missing_sensors: missing };

  function reject(status, errs) {
    return { ok: false, status, reading: null, errors: errs, warnings, missing_sensors: [] };
  }
}

module.exports = { validateReading, FIELDS };
