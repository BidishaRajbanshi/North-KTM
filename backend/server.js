// Start the SewerSafe backend + dashboard.   npm run server
const os = require("os");
const { createApp } = require("./app");

(async () => {
  const ctx = await createApp();
  await ctx.start();
  const server = ctx.app.listen(ctx.cfg.port, "0.0.0.0", () => {
    const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
    console.log(`\nSewerSafe running`);
    console.log(`  Dashboard:  http://localhost:${ctx.cfg.port}`);
    for (const ip of lan) console.log(`  ESP32 → POST http://${ip}:${ctx.cfg.port}/api/sensors/data`);
    console.log(`  Database:   ${ctx.store.kind}${ctx.store.kind === "file" ? " (" + ctx.cfg.dataFile + ")" : ""}`);
    console.log(`  Robot:      ${ctx.robotDriver.kind}${ctx.cfg.robotUrl ? " @ " + ctx.cfg.robotUrl : ""}`);
    console.log(`  Sensors:    ${ctx.cfg.simulateSensors ? "simulated for manholes without hardware" : "hardware only"}`);
    ctx.chain.status().then((s) => console.log(`  Blockchain: ${s.connected ? "connected, contract " + s.contract : "NOT connected (" + s.error + "). Records wait as PENDING."}\n`));
  });
  const stop = async () => { console.log("\nstopping..."); server.close(); await ctx.stop(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
})().catch((e) => { console.error("Could not start:", e.message); process.exit(1); });
