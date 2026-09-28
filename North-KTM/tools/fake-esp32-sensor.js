// Fake ESP32 SENSOR NODE: posts the exact JSON firmware/esp32_sensor_node sends, every 2 s.
//   node tools/fake-esp32-sensor.js                     normal air
//   node tools/fake-esp32-sensor.js --danger            methane climbs past the critical threshold
//   node tools/fake-esp32-sensor.js --danger --open     …and the manhole cover gets opened (entry attempt)
//   node tools/fake-esp32-sensor.js --unplug methane    that sensor reads nothing (shows the fault path)
// Options: --url http://127.0.0.1:4000/api/sensors/data  --sewer S101  --key <DEVICE_API_KEY>
const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf("--" + name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true) : d; };
const URL_ = opt("url", "http://127.0.0.1:4000/api/sensors/data");
const SEWER = opt("sewer", "S101");
const KEY = opt("key", process.env.DEVICE_API_KEY || "");
const danger = !!opt("danger", false);
const openCover = !!opt("open", false);
const unplug = opt("unplug", null);

let t = 0;
async function send() {
  t++;
  const ramp = danger ? Math.min(1, t / 6) : 0;
  const r = (v) => Math.round(v * 10) / 10;
  const body = {
    sewer_id: SEWER, device_id: "fake-esp32-node",
    timestamp: new Date().toISOString(),
    methane: r(180 + ramp * 8800 + Math.random() * 60),
    combustible: r(150 + ramp * 6500 + Math.random() * 50),
    air_quality: r(40 + ramp * 360 + Math.random() * 8),
    water_level: r(22 + ramp * 30),
    temperature: r(28.5 + Math.random() * 0.4),
    humidity: r(71 + Math.random() * 2),
    tilt: r(openCover && t > 8 ? 78 : 1.5 + Math.random()),
  };
  if (unplug) body[unplug] = null;
  try {
    const res = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json", ...(KEY ? { "x-api-key": KEY } : {}) }, body: JSON.stringify(body) });
    const j = await res.json();
    console.log(`${res.status} ${SEWER} CH4=${body.methane} tilt=${body.tilt} → ${j.risk ? j.risk.risk_level + " " + j.risk.risk_score + " entry " + j.human_entry : JSON.stringify(j.error)}`);
  } catch (e) { console.log("send failed:", e.message); }
}
send(); setInterval(send, 2000);
