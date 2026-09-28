// Loads configuration from config/*.json and environment variables (.env).
// Nothing secret is hard-coded: keys come from the environment only.
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const ROOT = path.join(__dirname, "..");
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

function loadConfig(overrides = {}) {
  const env = process.env;
  const bool = (v, d) => (v === undefined || v === "" ? d : /^(1|true|yes|on)$/i.test(v));
  const cfg = {
    root: ROOT,
    port: Number(env.PORT || 4000),
    thresholds: readJson("config/thresholds.json"),
    sewers: readJson("config/sewers.json").sewers,

    // storage: file DB by default; MongoDB when MONGODB_URI is set
    mongoUri: env.MONGODB_URI || "",
    dataFile: env.DATA_FILE || path.join(ROOT, "data", "sewersafe-db.json"),

    // security
    deviceApiKey: env.DEVICE_API_KEY || "",       // ESP32 sends this in x-api-key
    operatorToken: env.OPERATOR_TOKEN || "",      // dashboard/operator writes send this in x-operator-token
    corsOrigins: (env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),

    // simulated sensors for manholes without real hardware
    simulateSensors: bool(env.SIMULATE_SENSORS, true),
    simIntervalMs: Number(env.SIM_INTERVAL_MS || 2000),

    // robot: "sim" or "esp32"
    robotDriver: env.ROBOT_DRIVER || "sim",
    robotUrl: env.ROBOT_URL || "",               // e.g. http://192.168.1.50 (ESP32 robot)
    cameraUrl: env.CAMERA_URL || "",             // e.g. http://192.168.1.51:81/stream (ESP32-CAM)
    // mission geometry. Simulator: a 10 m pipe. Real ESP32 on a table-top model: ~2 m.
    robotStepM: Number(env.ROBOT_STEP_M || (env.ROBOT_DRIVER === "esp32" ? 0.1 : 0.5)),
    robotSegmentM: Number(env.ROBOT_SEGMENT_M || (env.ROBOT_DRIVER === "esp32" ? 2.0 : 10)),
    robotCheckpointM: Number(env.ROBOT_CHECKPOINT_M || (env.ROBOT_DRIVER === "esp32" ? 0.5 : 2.5)),
    robotStepDelayMs: Number(env.ROBOT_STEP_DELAY_MS || 700),

    // blockchain
    chainRpc: env.CHAIN_RPC || "http://127.0.0.1:8545",
    recorderKey: env.RECORDER_KEY || "",          // wallet that writes records (city). Local chain has a default.
    gatewayKey: env.ROBOT_GATEWAY_KEY || "",      // key that signs robot proofs for ESP32 robots
    deploymentFile: env.DEPLOYMENT_FILE || path.join(ROOT, "deployment.json"),
    chainRetryMs: Number(env.CHAIN_RETRY_MS || 10000),

    // alerts
    supervisorWebhook: env.SUPERVISOR_WEBHOOK_URL || "",
  };
  return { ...cfg, ...overrides };
}

module.exports = { loadConfig };
