#!/usr/bin/env python3
"""
SewerSafe robot agent — runs on the Raspberry Pi inside the robot.

What it does, in order:
  1. Reads the manhole's physical tag (NFC) so the proof is tied to one manhole.
  2. Runs the cleaning session, logging gas, depth, motor current and a thermal
     "is there a human in here?" check once per second.
  3. Takes before/after photos.
  4. Hashes everything into one evidence hash.
  5. Signs the proof with the ROBOT'S OWN KEY (the contractor never touches it).
  6. Submits the proof to the SewerSafe contract on MST Blockchain.

Runs with real sensors on a Pi, or with --mock on any laptop for the demo.

  pip install mst-sdk-python eth-abi
  python robot_agent.py --new-key                     # create the robot's wallet once
  python robot_agent.py --mock                        # clean job  -> contractor gets paid
  python robot_agent.py --mock --scenario human       # human enters -> payment blocked, bond slashed
"""
import argparse, hashlib, json, os, random, sys, time
from pathlib import Path

from eth_abi import encode
from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3

from mst_blockchain_sdk import Client, Provider, Signer

HERE = Path(__file__).resolve().parent
KEY_FILE = HERE / "robot.key"          # production: key lives in an ATECC608A secure element
# Hardhat's public test account #2 — used automatically ONLY on the local practice chain.
HARDHAT_ROBOT_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"

try:
    sys.stdout.reconfigure(encoding="utf-8")   # Windows terminals: print ° and ₂ safely
except Exception:
    pass

H2S_ALARM_PPM = 10       # buzzer threshold; H2S is dangerous at low levels
HUMAN_TEMP_C = 31.0      # thermal pixels above this count as "warm body"
HUMAN_MIN_PIXELS = 12    # on a 32x24 MLX90640 frame; tune on site


# --------------------------------------------------------------------------- sensors
def _try(label, fn):
    """Start one hardware part; if it's missing, warn and carry on without it."""
    try:
        part = fn()
        print(f"  [ok]   {label}")
        return part
    except Exception as e:
        print(f"  [skip] {label}: {e.__class__.__name__}: {e}")
        return None


class RealSensors:
    """Raspberry Pi hardware. Only the thermal camera is required (it's the human check).
    Every other part is optional, so one loose wire on demo day doesn't stop the run.
    Run robot/hw_check.py first to test each part on its own."""

    def __init__(self, fallback_tag):
        import board, busio                                   # adafruit-blinka
        print("  starting hardware:")
        self.fallback_tag = fallback_tag
        i2c = busio.I2C(board.SCL, board.SDA, frequency=400_000)

        def mlx():
            import adafruit_mlx90640
            m = adafruit_mlx90640.MLX90640(i2c)
            m.refresh_rate = adafruit_mlx90640.RefreshRate.REFRESH_2_HZ
            return m
        self.mlx = _try("MLX90640 thermal camera (0x33)", mlx)
        if not self.mlx:
            sys.exit("  The thermal camera is required: it's the human check. Fix wiring, run hw_check.py.")
        self.frame = [0.0] * 768

        def h2s():
            import adafruit_ads1x15.ads1115 as ADS
            from adafruit_ads1x15.analog_in import AnalogIn
            return AnalogIn(ADS.ADS1115(i2c), ADS.P0)          # MQ-136 AO -> ADS1115 A0
        self.h2s = _try("MQ-136 gas via ADS1115 (0x48)", h2s)

        def ina():
            import adafruit_ina219
            return adafruit_ina219.INA219(i2c)                 # in series with motor supply
        self.ina = _try("INA219 motor current (0x40)", ina)

        def nfc():
            from adafruit_pn532.i2c import PN532_I2C
            n = PN532_I2C(i2c, debug=False); n.SAM_configuration(); return n
        self.nfc = _try("PN532 NFC reader (0x24)", nfc)

        from gpiozero import DistanceSensor, Buzzer, Motor
        self.depth = _try("JSN-SR04T ultrasonic (GPIO23/24)",
                          lambda: DistanceSensor(echo=24, trigger=23, max_distance=4))
        self.buzzer = _try("Buzzer (GPIO18)", lambda: Buzzer(18))
        self.motor = _try("Brush/drive motor via L298N (GPIO17/27, EN 12)",
                          lambda: Motor(forward=17, backward=27, enable=12))
        self.has_cam = _try("Pi camera", lambda: __import__("picamera2")) is not None

    def read_manhole_tag(self, timeout=30):
        if not self.nfc:
            print(f"  NFC reader not connected: using the job's tag {self.fallback_tag} (prototype shortcut)")
            return self.fallback_tag
        print("  hold the robot's NFC reader against the manhole tag...")
        t0 = time.time()
        while time.time() - t0 < timeout:
            uid = self.nfc.read_passive_target(timeout=0.5)
            if uid:
                return "NFC-" + uid.hex().upper()
        sys.exit("  No manhole tag read in 30 s. Check the tag is on the rim and the PN532 is in I2C mode.")

    def start_work(self):
        if self.motor:
            self.motor.forward(0.8)

    def stop_work(self):
        if self.motor:
            self.motor.stop()

    def h2s_ppm(self):
        if not self.h2s:
            return None
        # MQ-136 needs per-unit calibration (Rs/R0 curve). This linear map is a
        # placeholder for the demo: calibrate against a reference meter before any real use.
        return round(max(0.0, (self.h2s.voltage - 0.4) * 50), 1)

    def human_present(self):
        for _ in range(3):                                     # MLX90640 occasionally misreads a frame
            try:
                self.mlx.getFrame(self.frame)
                break
            except ValueError:
                continue
        warm = sum(1 for t in self.frame if t >= HUMAN_TEMP_C)
        return warm >= HUMAN_MIN_PIXELS, round(max(self.frame), 1)

    def depth_m(self):
        return round(self.depth.distance, 2) if self.depth else None

    def motor_current_ma(self):
        return round(self.ina.current, 1) if self.ina else None

    def photo(self, path):
        if not self.has_cam:
            return
        from picamera2 import Picamera2
        cam = Picamera2(); cam.start(); time.sleep(1); cam.capture_file(str(path)); cam.close()

    def alarm(self, on):
        if self.buzzer:
            self.buzzer.on() if on else self.buzzer.off()


class MockSensors:
    """Simulated sensors for laptop demos. --scenario human makes a person 'enter' mid-job."""

    def __init__(self, scenario, tag, duration):
        self.scenario, self.tag, self.duration = scenario, tag, duration
        self.t0 = time.time()

    def read_manhole_tag(self, timeout=30):
        return self.tag

    def start_work(self):
        pass

    def stop_work(self):
        pass

    def _t(self):
        return time.time() - self.t0

    def h2s_ppm(self):
        # gas spikes as the robot disturbs sludge, then clears as it ventilates
        t = self._t()
        return round(max(0, 40 * (1 - abs(t - self.duration * 0.4) / (self.duration * 0.5))) + random.uniform(0, 3), 1)

    def human_present(self):
        if self.scenario == "human" and self._t() > self.duration * 0.35:
            return True, round(random.uniform(33.5, 35.5), 1)
        return False, round(random.uniform(24, 28), 1)

    def depth_m(self):
        return round(1.8 - 0.4 * min(1, self._t() / self.duration) + random.uniform(-0.02, 0.02), 2)

    def motor_current_ma(self):
        return round(random.uniform(900, 1400), 1)

    def photo(self, path):
        path.write_bytes(hashlib.sha256(f"{path.name}{time.time()}".encode()).digest() * 64)

    def alarm(self, on):
        if on and not getattr(self, "_alarm", False):
            print("  \a*** ALARM ON: dangerous gas or person detected ***")
        self._alarm = on


# --------------------------------------------------------------------------- evidence
def sha256_file(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run_session(sensors, job_id, duration, outdir):
    outdir.mkdir(parents=True, exist_ok=True)
    tag = sensors.read_manhole_tag()
    print(f"  manhole tag: {tag}")
    sensors.photo(outdir / "before.jpg")

    started = int(time.time())
    human, peak_gas = False, 0.0
    fmt = lambda v, spec, unit: "  n/a " + unit if v is None else f"{v:{spec}} {unit}"
    sensors.start_work()
    try:
        with open(outdir / "samples.jsonl", "w") as log:
            for i in range(duration):
                gas = sensors.h2s_ppm()
                present, tmax = sensors.human_present()
                s = {"t": int(time.time()), "h2s_ppm": gas, "thermal_max_c": tmax,
                     "human": present, "depth_m": sensors.depth_m(), "motor_ma": sensors.motor_current_ma()}
                log.write(json.dumps(s) + "\n")
                peak_gas = max(peak_gas, gas or 0)
                sensors.alarm((gas or 0) >= H2S_ALARM_PPM or present)
                flag = "  HUMAN DETECTED" if present else ""
                print(f"  [{i+1:>3}/{duration}] H2S {fmt(gas, '5.1f', 'ppm')} | thermal {tmax:4.1f}°C | "
                      f"depth {fmt(s['depth_m'], '.2f', 'm')} | motor {fmt(s['motor_ma'], '.0f', 'mA')}{flag}")
                if present:
                    human = True
                    break                      # stop immediately: a person is inside
                time.sleep(1)
    finally:
        sensors.stop_work()
        sensors.alarm(False)
    ended = int(time.time())
    sensors.photo(outdir / "after.jpg")

    files = sorted(p for p in outdir.iterdir() if p.name != "manifest.json")
    manifest = {
        "jobId": job_id, "manholeTag": tag, "startedAt": started, "endedAt": ended,
        "humanDetected": human, "maxH2Sppm": peak_gas,
        "files": {p.name: sha256_file(p) for p in files},
    }
    mbytes = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    (outdir / "manifest.json").write_bytes(mbytes)
    manifest["evidenceHash"] = "0x" + Web3.keccak(mbytes).hex().removeprefix("0x")
    return manifest


# --------------------------------------------------------------------------- chain
def proof_digest(chain_id, contract, p):
    enc = encode(
        ["uint256", "address", "uint256", "bytes32", "bytes32", "uint64", "uint64", "bool", "uint32"],
        [chain_id, Web3.to_checksum_address(contract), p["jobId"], p["manholeId"],
         p["evidenceHash"], p["startedAt"], p["endedAt"], p["humanDetected"], p["maxGasPpm"]],
    )
    return Web3.keccak(enc)


def submit(dep, rpc, key, m):
    provider = Provider(rpc)                     # MST SDK
    signer = Signer(key, provider)               # MST SDK — robot's own wallet
    w3 = provider.web3
    c = w3.eth.contract(address=Web3.to_checksum_address(dep["contract"]), abi=dep["abi"])

    to_b32 = lambda h: bytes.fromhex(h.removeprefix("0x"))
    p = {
        "jobId": dep["jobId"],
        "manholeId": Web3.keccak(text=m["manholeTag"]),
        "evidenceHash": to_b32(m["evidenceHash"]),
        "startedAt": m["startedAt"], "endedAt": m["endedAt"],
        "humanDetected": m["humanDetected"], "maxGasPpm": int(round(m["maxH2Sppm"])),
    }
    digest = proof_digest(w3.eth.chain_id, dep["contract"], p)
    onchain = c.functions.proofDigest(tuple(p.values())).call()
    assert bytes(onchain) == bytes(digest), "digest mismatch — ABI encoding out of sync with contract"

    sig = Account.sign_message(encode_defunct(primitive=bytes(digest)), private_key=key).signature
    print(f"  signed by robot {signer.address}")

    call = c.functions.submitProof(tuple(p.values()), sig)
    gas = call.estimate_gas({"from": signer.address})
    tx = call.build_transaction({"from": signer.address, "gas": int(gas * 1.2),
                                 "nonce": w3.eth.get_transaction_count(signer.address)})
    tx.pop("maxFeePerGas", None); tx.pop("maxPriorityFeePerGas", None)
    txh = signer.send_transaction(tx)
    rc = provider.wait_for_transaction(txh)
    print(f"  tx {('0x' + txh.removeprefix('0x'))}  status={'OK' if rc.status == 1 else 'FAILED'}")
    if dep.get("network") == "mstTestnet":
        print(f"  explorer: https://mstscan.com/tx/0x{txh.removeprefix('0x')}")
    if rc.status != 1:
        sys.exit("  Transaction failed. Did the job already get a proof? Post a new one: npm run job:local")
    return rc


# --------------------------------------------------------------------------- main
def decode_error(abi, text):
    """Turn a revert like 0x5c975bda into the contract's error name (e.g. BadStatus)."""
    for item in abi:
        if item.get("type") == "error":
            sig = f"{item['name']}({','.join(i['type'] for i in item.get('inputs', []))})"
            if Web3.keccak(text=sig)[:4].hex().removeprefix("0x") in text:
                return item["name"]
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--new-key", action="store_true", help="create the robot wallet and exit")
    ap.add_argument("--mock", action="store_true", help="simulated sensors")
    ap.add_argument("--scenario", choices=["clean", "human"], default="clean")
    ap.add_argument("--deployment", default=str(HERE.parent / "deployment.json"))
    ap.add_argument("--rpc", help="override RPC (defaults to deployment.json / MST testnet)")
    ap.add_argument("--duration", type=int, help="seconds to run (default: job minimum + 5)")
    args = ap.parse_args()

    if args.new_key:
        if KEY_FILE.exists():
            sys.exit(f"{KEY_FILE} already exists — robot address: {Account.from_key(KEY_FILE.read_text().strip()).address}")
        c = Client.create_random("testnet")       # MST SDK wallet generation
        KEY_FILE.write_text(c.signer.get_private_key()); os.chmod(KEY_FILE, 0o600)
        print(f"robot address: {c.signer.address}\n(fund it with MSTC from https://faucet.masterstroke.academy for gas)")
        return

    dep = json.loads(Path(args.deployment).read_text())
    local = dep.get("network") in ("localhost", "hardhat")
    key = os.environ.get("ROBOT_KEY") or (KEY_FILE.read_text().strip() if KEY_FILE.exists() else None)
    if not key and local:
        key = HARDHAT_ROBOT_KEY
    if not key:
        sys.exit("No robot key. Run: python robot/robot_agent.py --new-key")
    rpc = args.rpc or dep.get("rpc") or "https://testnetrpc.mstblockchain.com"
    duration = args.duration or dep["minDuration"] + 5

    sensors = (MockSensors(args.scenario, dep["manholeTag"], duration) if args.mock
               else RealSensors(fallback_tag=dep["manholeTag"]))
    outdir = HERE / "evidence" / f"job-{dep['jobId']}-{int(time.time())}"
    mode = f"MOCK ({args.scenario})" if args.mock else "LIVE HARDWARE"
    print(f"\n== SewerSafe job #{dep['jobId']} — {mode} — chain {rpc} ==")
    m = run_session(sensors, dep["jobId"], duration, outdir)
    if m["manholeTag"] != dep["manholeTag"]:
        sys.exit(f"\n  This tag is {m['manholeTag']} but job #{dep['jobId']} is for {dep['manholeTag']}.\n"
                 f"  Put MANHOLE_TAG={m['manholeTag']} in .env on the laptop and redeploy.")
    print(f"\n  evidence hash {m['evidenceHash']}  ({outdir})")
    print(f"  human detected: {m['humanDetected']}   peak H2S: {m['maxH2Sppm']} ppm")
    try:
        submit(dep, rpc, key, m)
    except Exception as e:
        name = decode_error(dep["abi"], str(e))
        hint = {
            "BadStatus": "This job already has a proof (or was refunded). Post a new one:\n"
                         "    npm run job:local      (or npm run job:testnet)",
            "BadSigner": "The robot key isn't registered for this contractor. Redeploy, or check ROBOT_ADDRESS in .env.",
            "Expired": "The job's deadline passed. Post a new one: npm run job:local",
            "TooShort": "The robot didn't run long enough. Use a longer --duration.",
            "WrongManhole": "The manhole tag doesn't match the job.",
        }.get(name, "See the error above.")
        sys.exit(f"\n  Contract rejected the proof: {name or e}\n  {hint}")
    if m["humanDetected"]:
        print("\n  >>> HUMAN ENTRY recorded on-chain. Payment refunded to city, contractor bond slashed.")
    else:
        print(f"\n  >>> Proof accepted. Payment releases after the {dep['challengeWindow']}s challenge window.")


if __name__ == "__main__":
    main()
