# SewerSafe: step-by-step guide

From an empty laptop to a working demo, then the ESP32 hardware, then demo day. Follow the parts in order.

---

## Part 1. Install three things (once)

Install them in this order, then **restart the laptop**.

1. **Node.js**: go to nodejs.org, click the green **LTS** button, and install with the defaults.
2. **VS Code** (to look at and edit the code): code.visualstudio.com.
3. **Git** (optional, only if you want to `git clone`): git-scm.com.

Check: open **Command Prompt** (Windows) or **Terminal** (Mac) and type `node -v`. It should print a version like `v22.x.x`.

Python is **not** needed for the main system. It's only for the optional Raspberry Pi robot.

## Part 2. Get the code

**Option A, no Git:** on the GitHub page (github.com/BidishaRajbanshi/North-KTM) click the green **Code** button → **Download ZIP**. Then right-click the zip → **Extract All** → **Extract**.

> Work in the extracted folder. If a window shows a **"Compressed size"** column, you're still inside the zip and nothing will run.

**Option B, with Git:**

```
git clone https://github.com/BidishaRajbanshi/North-KTM.git
```

## Part 3. Run it

Open the project folder and double-click **`START-DEMO.bat`** (Windows) or **`START-DEMO.command`** (Mac; if blocked, right-click → Open → Open).

Or in VS Code: **File → Open Folder** → pick the project folder → **Terminal → New Terminal** → type `npm start`.

The first run installs packages (1–3 minutes, needs internet). You'll see:

```
=== 1/4  Checking your computer
=== 2/4  Packages
=== 3/4  Local blockchain + contract
  SewerSafe    0x5FbDB2315678afecb367f032d93F642f64180aa3
=== 4/4  Backend + dashboard
✔ SewerSafe is running.  Dashboard: http://localhost:4000
```

The browser opens **http://localhost:4000**. Keep the black window open; closing it (or pressing Ctrl+C) stops everything.

## Part 4. The demo

On the dashboard:

1. **Simulate critical hazard** (top right). Watch the 12-step tracker light up:
   - the sewer goes red, **HUMAN ENTRY BLOCKED** appears across the top, an alert is logged
   - robot R1 drives into the pipe (camera view), checks gas at checkpoints, finds the blockage, drives back
   - the inspection is saved, four blockchain transactions confirm, and the record shows **VERIFIED**
2. **Maintenance** panel → **Run cleaning robot**. The robot clears the blockage and its proof is accepted. About 12 seconds later the contractor shows **PAID** from escrow.
3. **Entry attempt**: a critical alert fires and the contractor's bond shows **SLASHED**.
4. **Tamper latest record**: the database is edited, and within a second the record shows **MISMATCH** against the blockchain.

Other things to show:

- Click a sewer row to see its gas trend.
- Click an inspection row for findings and transaction hashes.
- Drive the robot with the arrow buttons or keyboard arrows; space is STOP.

### Check everything works

In a second terminal:

```
npm test
```

You should see `18 passing` (contracts + the real-blockchain end-to-end test), then `# pass 50` (backend).

## Part 5. Add the ESP32 hardware

Full parts lists, wiring tables and flashing steps are in [`firmware/README.md`](../firmware/README.md). In short:

1. **Set up Arduino IDE** with the esp32 boards package and 3 libraries (firmware/README.md section 1).
2. **Build the sensor node** and flash `firmware/esp32_sensor_node`. Set your Wi-Fi and `SERVER_URL`: the laptop IP printed by `npm start` on the line `ESP32 → POST http://…`.
   - Laptop and ESP32 must be on the **same 2.4 GHz Wi-Fi**. A phone hotspot is the most reliable option at a hackathon.
   - Windows Firewall will ask about Node.js the first time: click **Allow** for private networks.
   - Row **S101** on the dashboard switches from OFFLINE to live values.
3. **Build the robot** and flash `firmware/esp32_robot`. Its Serial Monitor prints `Robot ready: http://192.168.x.y`.
4. Copy `.env.example` to `.env` and set:
   ```
   ROBOT_DRIVER=esp32
   ROBOT_URL=http://192.168.x.y
   CAMERA_URL=http://192.168.x.z:81/stream      (only if you built the ESP32-CAM)
   ```
5. Stop (Ctrl+C) and run `npm start` again.

**No hardware yet?** Put `ROBOT_DRIVER=esp32` and `ROBOT_URL=http://127.0.0.1:8081` in `.env`, then run these in extra terminals:

```
npm run fake:robot
npm run fake:sensor
```

They speak exactly the same protocol as the real boards, so the ESP32 path works end to end.

**Live gas demo on the model:** hold an unlit butane lighter near the MQ sensors and press its button for a second, outdoors or by an open window, away from any flame. S101 goes CRITICAL and the node's buzzer sounds even without Wi-Fi.
**Cover demo:** lift the model's manhole lid (MPU6050 tilts past 30°) while S101 is blocked, and an entry-attempt alert fires.

## Part 6. Use the real MST Blockchain testnet (optional)

Do this at least one day before the event.

1. Install the **BridgeKey** Chrome extension and create three wallets: **city**, **contractor**, **robot gateway**. Export each private key.
2. Get test MSTC for all three from **faucet.masterstroke.academy**:
   - city: gas for every record + 1 MSTC per maintenance job
   - contractor: 0.5 MSTC bond + gas
   - robot gateway: gas
3. In `.env`:
   ```
   CHAIN_RPC=https://testnetrpc.mstblockchain.com
   MST_PRIVATE_KEY=0x<city key>
   CONTRACTOR_KEY=0x<contractor key>
   ROBOT_GATEWAY_KEY=0x<robot gateway key>
   ROBOT_ADDRESS=0x<robot gateway address>
   ```
4. Deploy: `npm run deploy:testnet`. It writes `deployment.json`.
5. `npm start`. It sees the testnet in `.env`, skips the local chain, and connects to the deployed contract.
6. Transactions can be checked on **mstscan.com**; the dashboard links them.

Each maintenance job escrows 1 MSTC, and each entry attempt slashes 0.5 MSTC of the contractor's bond. Top up from the faucet between rehearsals.

## Part 7. Demo-day checklist

**The night before**
- [ ] `npm test` passes on the demo laptop
- [ ] `npm start` → full demo runs from Part 4
- [ ] ESP32 sketches compiled and flashed; S101 shows live values
- [ ] Robot drives from the dashboard buttons
- [ ] Phone hotspot ready; laptop, sensor node and robot all join it
- [ ] Power banks charged; spare USB data cable

**On stage (3 minutes)**
1. **Problem (30 s):** 498 deaths since 2019 by the government's own count; robots exist, but nothing forces contractors to use them.
2. **Live hazard (60 s):** gas on the model (or Simulate critical hazard). HUMAN ENTRY BLOCKED, the robot goes in instead, the blockage is found.
3. **Trust (45 s):** the inspection is VERIFIED on-chain. Press Tamper and it turns MISMATCH: "nobody can relabel this record later".
4. **Money (30 s):** Run cleaning robot → PAID only on robot proof. Entry attempt → bond SLASHED. "Sending a person in now costs the contractor money."
5. **Scale (15 s):** plugs into robots cities already buy under the NAMASTE scheme.

**Backup plan:** if Wi-Fi or hardware fails on stage, the simulated sensors and robot keep running. Press Simulate critical hazard; the blockchain part is identical.

## Part 8. Fixing problems

| You see | Do this |
|---|---|
| "Compressed size" column in the folder | You're inside the zip. Extract it (Part 2). |
| `'node' is not recognized` | Install Node.js and restart the laptop. |
| `running scripts is disabled` (VS Code, Windows) | Use `START-DEMO.bat`, or run once in PowerShell: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. |
| `Port 8545 is already in use` or `port 4000` | An old SewerSafe window is still open. Close it or restart the laptop. |
| `HH502: Couldn't download compiler` | The first run needs internet to fetch the Solidity compiler. Connect and retry. |
| Dashboard: "Chain: not connected" | Local: restart `npm start`. Testnet: check `CHAIN_RPC`, keys and wallet balances. Records wait as PENDING and send themselves once connected. |
| S101 stays OFFLINE | ESP32 not reaching the laptop: same Wi-Fi? correct IP in `SERVER_URL`? Firewall allowed Node? |
| ESP32 gets `401` | `DEVICE_API_KEY` in `.env` and `API_KEY` in the sketch must match (or leave both empty). |
| S101 shows SENSOR FAULT | An installed sensor isn't sending. Check wiring, or remove it from S101's `sensors` in `config/sewers.json`. |
| Robot `ERROR`, "robot not responding" | Check `ROBOT_URL`; open `http://<robot IP>/status` in a browser. |
| Maintenance shows `NOT POSTED` | The escrow job failed: on testnet the city wallet needs MSTC, and the contractor needs its bond. |
| `insufficient funds` (testnet) | Top up that wallet from the faucet. |
