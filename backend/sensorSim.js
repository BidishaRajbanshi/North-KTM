// Simulated sensor nodes for manholes without real hardware.
// Produces believable, slowly drifting readings. The demo can force a hazard on one sewer.
function createSensorSim({ sewers, onReading, intervalMs = 2000, rng = Math.random }) {
  const state = {};
  const forced = {};          // sewerId -> { until, profile }
  let timer = null;

  const drift = (v, target, step, noise) => v + (target - v) * step + (rng() - 0.5) * noise;

  for (const s of sewers) {
    if (s.device !== "simulated") continue;
    state[s.id] = { methane: 150 + rng() * 150, combustible: 120 + rng() * 120, air_quality: 60 + rng() * 40,
      oxygen: 20.8, water_level: 20 + rng() * 20, temperature: 27 + rng() * 3, humidity: 70 + rng() * 10 };
  }

  function sample(sewer) {
    const st = state[sewer.id];
    const f = forced[sewer.id];
    const hazard = f && Date.now() < f.until;
    st.methane = drift(st.methane, hazard ? f.profile.methane : 200, hazard ? 0.45 : 0.1, 40);
    st.combustible = drift(st.combustible, hazard ? f.profile.combustible : 180, hazard ? 0.45 : 0.1, 30);
    st.air_quality = drift(st.air_quality, hazard ? f.profile.air_quality : 70, hazard ? 0.45 : 0.1, 6);
    st.oxygen = drift(st.oxygen, hazard ? f.profile.oxygen : 20.8, hazard ? 0.45 : 0.2, 0.05);
    st.water_level = drift(st.water_level, hazard ? f.profile.water_level : 30, 0.08, 2);
    st.temperature = drift(st.temperature, 29, 0.05, 0.3);
    st.humidity = drift(st.humidity, 75, 0.05, 1);
    const r = { sewer_id: sewer.id, device_id: "sim-" + sewer.id, timestamp: new Date().toISOString() };
    for (const k of sewer.sensors) if (st[k] !== undefined) r[k] = Math.max(0, Math.round(st[k] * 10) / 10);
    return r;
  }

  async function tick() {
    for (const s of sewers) if (state[s.id]) { try { await onReading(sample(s)); } catch (e) { console.warn("[sim]", e.message); } }
  }

  return {
    start() { if (!timer) { timer = setInterval(tick, intervalMs); tick(); } },
    stop() { clearInterval(timer); timer = null; },
    tick,
    /** force a dangerous atmosphere on a simulated sewer for `ms` milliseconds */
    forceHazard(sewerId, ms = 60000, profile = { methane: 9000, combustible: 7000, air_quality: 380, oxygen: 18.2, water_level: 55 }) {
      if (!state[sewerId]) return false;
      forced[sewerId] = { until: Date.now() + ms, profile };
      return true;
    },
    clearHazard(sewerId) { delete forced[sewerId]; },
    isSimulated: (id) => !!state[id],
  };
}

module.exports = { createSensorSim };
