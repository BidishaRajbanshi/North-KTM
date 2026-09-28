# Optional: Raspberry Pi "trusted robot" (escrow proof signed on the robot)

> **This is an optional extension, not the main system.** The main SewerSafe system (ESP32 sensors + ESP32 robot + backend + dashboard) is described in the main README and `docs/GUIDE.md`. Use this guide only if you also want a robot that signs its own proof with its own key (thermal-camera human detection on a Raspberry Pi). There, the backend signs on the ESP32 robot's behalf. Commands here use `npm run demo:escrow` in place of the old `START-DEMO`.

**The idea in one line:** a city pays a sewer contractor only when the contractor's robot proves, with its own digital signature, that it did the job and that no human entered the manhole.

---

## STEP 0. Extract the zip first

If your window has a column called **"Compressed size"**, you are looking *inside* the zip, not a real folder. Nothing runs from there.

1. Close that window.
2. Right-click `safesewer.zip` → **Extract All…** → **Extract**.
3. A normal folder called `safesewer` opens. Use that folder from now on.

---

## PART 1. The concept

### The problem

- By the government's own count, **498 workers died cleaning sewers and septic tanks in India from Jan 2019 to Jun 2026**. There were 47 deaths in 2025.
- For early 2026 the government reported 16 deaths. A rights group (DASAM) documented 66 and says deaths get relabelled as "accidents" or "drowning".
- Manual scavenging has been banned since 2013. Cleaning robots already exist in several cities. Contractors still send people in because it's cheaper and nobody can prove what method was used.

### The solution

We don't build a better sewer robot. We make using one the only way to get paid.

```
CITY puts payment in escrow (smart contract)
        │
ROBOT goes into the manhole:
  • reads the manhole's NFC tag      → proves WHICH manhole
  • logs gas, depth, motor current   → proves it WORKED
  • thermal camera watches           → proves NO HUMAN went in
  • signs everything with its own key
        │
CONTRACT checks the signature and the rules
        │
  no human ─────────────► inspectors get a short window to object
                          → contractor PAID automatically
  human detected ───────► recorded on-chain forever
                          → payment back to city
                          → contractor's bond to worker welfare fund
```

### Why blockchain (judges will ask)

The city, contractors and the public don't trust each other. Whoever runs a normal database can quietly edit it, which is exactly how deaths get relabelled. On MST Blockchain:

- The robot's signature can't be faked.
- The record can't be changed later.
- Anyone can check it on MSTScan.
- Payment happens automatically, with no official who can be pressured.

### What each part does

| Part | Role |
|---|---|
| `contracts/SewerSafe.sol` | The rules: escrow, bond, proof checks, payment, penalty |
| `robot/robot_agent.py` | The robot's brain: reads sensors, builds and signs the proof, sends it |
| `robot/hw_check.py` | Tests each hardware part on its own |
| `scripts/*.js` | Deploy, post job, release payment, show status |
| `scripts/demo-all.js` | Runs everything in one go |
| `dashboard/index.html` | The screen you show judges (simulation) |

---

## PART 2. Run the software on your laptop

### 2.1 Install three programs (once)

Install them in this order, then **restart the laptop**.

1. **Node.js**: nodejs.org → green **LTS** button → install with the defaults.
2. **Python 3.12**: python.org → Downloads. On the first screen, **tick "Add python.exe to PATH"** before you click Install.
3. **VS Code**: code.visualstudio.com.

Check: open **Command Prompt** and type `node -v` and `python --version`. Both should print a version number.

### 2.2 Option A: run everything with one click

In the `safesewer` folder, double-click **`npm run demo:escrow`**. (Mac: `npm run demo:escrow`, then right-click → Open.)

The first run takes 2–5 minutes and needs internet. You'll see:

```
=== 1/7  Checking your computer
=== 2/7  Installing packages (first run only)
=== 3/7  Checking the contract (8 automated tests)     → 8 passing
=== 4/7  Starting a local blockchain on your laptop
=== 5/7  Deploying SewerSafe + posting job #1
=== 6/7  CLEAN JOB: robot works alone → contractor gets paid
=== 7/7  HUMAN ENTRY: person goes into the manhole
=== RESULT
job #1  Paid
job #2  HumanEntry
welfare fund      0.5 MSTC
✔ Everything ran.
```

If you see `✔ Everything ran.`, your software is working.

### 2.3 Option B: run it manually, step by step

Use this when presenting, so judges watch each step happen.

1. Open VS Code → **File → Open Folder** → select `safesewer`.
2. **Terminal → New Terminal** (this is Terminal 1).
3. If this is the first time, install the packages:
   ```
   npm install
   python -m pip install -r robot/requirements.txt
   ```
4. **Start the blockchain** in Terminal 1:
   ```
   npm run chain
   ```
   Wait for `Started HTTP and WebSocket JSON-RPC server`. **Leave this terminal alone.**
5. Click **+** in the terminal panel to open Terminal 2. Type each command below and wait for it to finish before the next.

| # | Command | What happens | What you should see |
|---|---|---|---|
| 1 | `npm run deploy:local` | City deploys the contract, approves the robot, contractor locks a 0.5 MSTC bond, city posts job #1 with 1 MSTC | `job #1 posted` |
| 2 | `python robot/robot_agent.py --mock` | Robot works for 20 s, then signs and submits its proof | `Proof accepted` |
| 3 | `npm run release:local` | Waits out the 10 s inspector window, then pays | `job #1 PAID: contractor +1.0 MSTC` |
| 4 | `npm run job:local` | City posts a new job (each job accepts one proof only) | `job #2 posted` |
| 5 | `python robot/robot_agent.py --mock --scenario human` | A person "enters" at second 8 | `HUMAN DETECTED` … `HUMAN ENTRY recorded on-chain` |
| 6 | `npm run status:local` | Shows the final state | job #1 Paid, job #2 HumanEntry, welfare fund 0.5 MSTC |
| 7 | `npm test` | Runs 8 automated tests on the contract | `8 passing` |

You can also do all of this from the menu: **Terminal → Run Task…** has the same steps, numbered 0–6.

**Stop the chain:** click Terminal 1 and press `Ctrl+C`. Restarting it wipes everything, so start again from command 1.

### 2.4 The dashboard

Double-click `dashboard/index.html`, or right-click it in VS Code → **Open with Live Server**. The three buttons show:

- **Run robot job**: a clean job ending in payment.
- **Simulate human entry**: a person detected, so the payment is blocked.
- **Tamper with log**: someone edits the data and the contract rejects it.

This screen is a simulation for the pitch. The real on-chain proof comes from the terminal.

---

## PART 3. Build the hardware

### 3.1 Shopping list

Check current prices on Robu.in or Robocraze before ordering.

**Must have** (the demo works with only these):

| Part | Why |
|---|---|
| Raspberry Pi 4 or 5 + official power supply + 32 GB microSD | The robot's brain |
| **MLX90640 thermal camera breakout (32×24)** | **The human check. The whole idea depends on this** |
| Female-to-female jumper wires (20–40) | Connections |
| 40–60 cm PVC pipe or a big bucket | The "manhole" |

**Should have** (makes the demo much stronger):

| Part | Why |
|---|---|
| PN532 NFC module + 2–3 NTAG213 stickers | Ties the proof to one manhole |
| MQ-136 H₂S sensor module + ADS1115 ADC module | Shows gas danger live |
| Active buzzer module | Alarm sound when a human is detected |

**Nice to have:**

| Part | Why |
|---|---|
| L298N motor driver + 1 small DC motor (brush or pump) + 2×18650 battery holder | Robot "does work" |
| INA219 current sensor | Proves the motor actually ran |
| JSN-SR04T waterproof ultrasonic | Sludge depth |
| Pi Camera Module + ribbon cable | Before and after photos |
| Resistors: 1 kΩ, 2 kΩ, 10 kΩ, 20 kΩ | Voltage dividers (see wiring) |
| Small plastic box (tiffin box) + string or cord | The pod that gets lowered in |

Every part except the thermal camera is optional. If one is missing or loose, the robot prints `[skip]` for it and keeps going.

### 3.2 The physical build

1. **Manhole:** stand the PVC pipe upright (or use the bucket). Stick a printed "BBMP MH-0417" plate on it, and the NFC sticker on the rim.
2. **Pod:** mount the Pi and sensors in the plastic box. Point the thermal camera **down** through a hole in the bottom, and the ultrasonic sensor down as well. Put the gas sensor on the side, the buzzer on top, and the motor on the outside as the "brush".
3. Keep all I2C wires **under 30 cm**. Long wires make the thermal camera fail randomly.
4. Tie a cord to the box so you can lower it into the pipe. Power it from a power bank.

### 3.3 Wiring

Pin numbers are the **physical pins** on the Pi header. Pin 1 is the corner pin nearest the SD card end; odd numbers are on the inner row.

**Shared power and data (all I2C boards connect in parallel):**

| Pi pin | Goes to |
|---|---|
| Pin 1 (3.3V) | VIN/VCC of MLX90640, ADS1115, INA219, PN532 |
| Pin 3 (SDA) | SDA of MLX90640, ADS1115, INA219, PN532 |
| Pin 5 (SCL) | SCL of MLX90640, ADS1115, INA219, PN532 |
| Pin 6 (GND) | GND of every module (all grounds together) |
| Pin 2 (5V) | MQ-136 VCC, JSN-SR04T 5V |

**Individual parts:**

| Part | Connection |
|---|---|
| PN532 | Set its two DIP switches to **I2C** (usually SW1 ON, SW2 OFF; check the label on your board) |
| MQ-136 AO | Through a divider to ADS1115 **A0**: AO → 10 kΩ → A0, and A0 → 20 kΩ → GND. This keeps it under 3.3V |
| JSN-SR04T TRIG | Pin 16 (GPIO23) |
| JSN-SR04T ECHO | Through a divider to pin 18 (GPIO24): ECHO → 1 kΩ → pin 18, and pin 18 → 2 kΩ → GND |
| Buzzer + | Pin 12 (GPIO18). Buzzer − → GND |
| L298N IN1 / IN2 | Pin 11 (GPIO17) / pin 13 (GPIO27) |
| L298N ENA | Pin 32 (GPIO12). **Remove the ENA jumper cap first** |
| L298N 12V / GND | Battery + / battery −. **Also connect L298N GND to Pi GND** |
| INA219 VIN+ / VIN− | Put it in the battery + wire going to the L298N: battery + → VIN+, VIN− → L298N 12V |
| Pi Camera | Ribbon cable into the CAM port, contacts facing the right way |

**Never** connect a 5V signal straight to a Pi pin. That's what the dividers are for.

### 3.4 Set up the Raspberry Pi (once)

1. On your laptop, install **Raspberry Pi Imager** (raspberrypi.com/software).
2. Choose **Raspberry Pi OS (64-bit)** and your SD card. Before writing, click **Edit settings**:
   - hostname `safesewer`
   - username `pi` and a password
   - your Wi-Fi name and password: **the same Wi-Fi as the laptop** (a phone hotspot works well at hackathons)
   - Services tab: **enable SSH**
3. Put the SD card in the Pi, power it on and wait 2 minutes.
4. On the laptop, open Command Prompt and connect:
   ```
   ssh pi@safesewer.local
   ```
   Type `yes`, then your password.
5. Copy the project from the laptop to the Pi. In a **new** Command Prompt on the laptop, inside the folder that contains `safesewer`:
   ```
   scp -r safesewer pi@safesewer.local:~
   ```
   Alternatively, copy it with a USB stick.
6. Back in the SSH window, on the Pi:
   ```
   cd safesewer
   bash robot/pi_setup.sh
   sudo reboot
   ```

### 3.5 Test every part (on the Pi)

Reconnect with `ssh pi@safesewer.local`, then:

```
cd safesewer
. robot/.venv/bin/activate
i2cdetect -y 1
```

You should see **33** (thermal), **48** (gas ADC), **40** (current) and **24** (NFC) in the grid. A missing number means that board's wiring is wrong.

Then:

```
python3 robot/hw_check.py
```

It tests each part and ends with a PASS/FAIL list:

- **thermal:** first point it at nothing, then hold your hand 20 cm away. "warm pixels" should jump above 12 and show `← HUMAN`.
- **nfc:** hold the sticker on the reader. It prints something like `MANHOLE_TAG=NFC-04A2B3C1D2E380`. **Write this down.**
- **gas:** MQ sensors need 2–5 minutes to warm up.
- **buzzer / motor:** you should hear or see them.

Re-test one part only with, for example, `python3 robot/hw_check.py thermal`.

### 3.6 Run the real robot

The blockchain runs on the **laptop**. The robot on the **Pi** sends its proof to it over Wi-Fi.

**On the laptop:**

1. Find the laptop's IP address. Windows: `ipconfig` → **IPv4 Address** (like `192.168.1.23`). Mac: `ipconfig getifaddr en0`.
2. In the `safesewer` folder, copy `.env.example` → rename the copy to `.env` → set the tag you wrote down:
   ```
   MANHOLE_TAG=NFC-04A2B3C1D2E380
   ```
   Leave the other lines as they are.
3. Terminal 1:
   ```
   npm run chain:lan
   ```
   If Windows Firewall asks, click **Allow** for private networks. If you miss it, the Pi can't connect.
4. Terminal 2:
   ```
   npm run deploy:local
   scp deployment.json pi@safesewer.local:~/safesewer/
   ```

**On the Pi (SSH window):**

```
cd safesewer
. robot/.venv/bin/activate
python3 robot/robot_agent.py --rpc http://192.168.1.23:8545
```

Use your laptop's IP in place of `192.168.1.23`. Then:

1. It lists each part as `[ok]` or `[skip]`.
2. It asks for the tag. Hold the pod's NFC reader to the sticker on the rim.
3. Lower the pod into the pipe. It logs for 20 seconds with the motor running.
4. It prints `Proof accepted`.

**Back on the laptop:** `npm run release:local` → `job #1 PAID`.

**Human-entry run, live:**

1. Laptop: `npm run job:local`, then `scp deployment.json pi@safesewer.local:~/safesewer/`
2. Pi: run the same `robot_agent.py` command again.
3. While the pod is in the pipe, **ask a judge to lean over the pipe or put a hand into it**.
4. Buzzer on, `HUMAN DETECTED`, then `HUMAN ENTRY recorded on-chain`.
5. Laptop: `npm run status:local` shows job #2 HumanEntry and the bond in the welfare fund.

**Every new job needs `deployment.json` copied to the Pi again.** It holds the job number.

---

## PART 4. Put it on the real MST testnet (optional, adds MSTScan links)

Do this at least one day before the hackathon.

1. Install the **BridgeKey** extension in Chrome and create two wallets: **city** and **contractor**. Export each private key.
2. Make the robot wallet: `python robot/robot_agent.py --new-key`. Copy the address it prints. On the Pi, copy the created `robot/robot.key` file too.
3. Get test MSTC for all three addresses from **faucet.masterstroke.academy**.
4. In `.env` fill `MST_PRIVATE_KEY` (city), `CONTRACTOR_KEY`, `ROBOT_ADDRESS` (and `MANHOLE_TAG` for hardware).
5. Run the same flow with `:testnet` in place of `:local`:
   ```
   npm run deploy:testnet
   python robot/robot_agent.py --mock
   npm run release:testnet
   npm run job:testnet
   npm run status:testnet
   ```
   The robot prints an `mstscan.com/tx/...` link after each proof. Open it to show the judges.

On the Pi with testnet, the Pi needs internet and no `--rpc` flag: `python3 robot/robot_agent.py`.

---

## PART 5. Demo-day plan

**The night before:**

- [ ] `npm run demo:escrow` ends with `✔ Everything ran.`
- [ ] `hw_check.py` passes for thermal (the must-have) and NFC
- [ ] One full live hardware run done at home, both clean and human
- [ ] Phone hotspot ready, and laptop + Pi both connect to it
- [ ] Power bank for the Pi charged

**On stage (3 minutes):**

1. **(30 s) The problem.** 498 deaths since 2019 by the government's own count. Robots exist. Contractors skip them because nothing forces them.
2. **(45 s) Clean job.** Tap the tag, lower the pod, readings stream, `Proof accepted`, release, contractor paid.
3. **(45 s) Human entry with a judge.** The judge leans in, the buzzer goes off, the event is recorded forever, the payment is blocked and the bond is slashed.
4. **(30 s) Tamper test.** Dashboard → **Tamper with log**: the contract rejects the edited data.
5. **(30 s) Why it scales.** It plugs into robots cities already buy under the NAMASTE scheme; the payment rules become automatic.

**Backup plan:** if the hardware fails on stage, say "here's the same flow with recorded sensor data" and run `python robot/robot_agent.py --mock` on the laptop. The blockchain part is identical.

---

## PART 6. Fixing problems

| You see | Do this |
|---|---|
| "Compressed size" column in the folder | You're inside the zip. See Step 0 |
| `'node' is not recognized` | Install Node.js, then restart the laptop |
| `'python' is not recognized` | Reinstall Python with "Add to PATH" ticked, then restart. Or use `py` in place of `python` |
| `running scripts is disabled` (VS Code, Windows) | Use `npm run demo:escrow`, or run once in PowerShell: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `No module named 'mst_blockchain_sdk'` | `python -m pip install -r robot/requirements.txt` |
| `ECONNREFUSED 127.0.0.1:8545` | The chain isn't running. Start `npm run chain` and leave it open |
| `ENOENT deployment.json` | Run `npm run deploy:local` first |
| `Contract rejected the proof: BadStatus` | That job is used up. Run `npm run job:local` |
| `port 8545 already in use` | An old chain is still running. Close the old terminal or restart VS Code |
| Pi: `Connection refused` to the laptop IP | Laptop must use `npm run chain:lan` (not `chain`), same Wi-Fi, and Windows Firewall must allow Node |
| Pi: `This tag is NFC-… but job is for …` | Put that exact tag in `.env` as `MANHOLE_TAG`, redeploy, copy `deployment.json` to the Pi |
| Pi: `The thermal camera is required` | Check pins 1, 3, 5, 6. `i2cdetect -y 1` must show 33. Shorten the wires |
| Pi: thermal never says HUMAN | Get closer. Or in `robot/robot_agent.py`, lower `HUMAN_TEMP_C` to 30.0 or `HUMAN_MIN_PIXELS` to 8 |
| Pi: gas always 0 | Warm up 5 minutes and check the AO → divider → A0 wiring |
| `insufficient funds` (testnet) | Top up that wallet from the faucet |

---

## What's tested, honestly

- **Tested:** the one-click run and every manual laptop step, from a fresh unzip with no packages installed. The contract passes its 8 tests.
- **Not tested:** the real sensors (no hardware available here) and the live MST testnet (unreachable from the build machine). That's why `hw_check.py` exists: test each part the day before, not on stage.
- **Prototype limits to state openly:** the gas sensor isn't calibrated. The human check is a heat threshold, not AI. The NFC sticker can be copied; production would use NTAG 424 DNA tags and a secure chip for the robot's key.
