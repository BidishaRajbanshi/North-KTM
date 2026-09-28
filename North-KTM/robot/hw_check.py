#!/usr/bin/env python3
"""
SewerSafe hardware checker — run this on the Raspberry Pi BEFORE the robot script.
Tests each part on its own and tells you exactly which one is wrong.

    python3 robot/hw_check.py              # test everything
    python3 robot/hw_check.py thermal nfc  # test only some parts

Parts: i2c thermal gas current nfc distance buzzer motor camera
"""
import sys, time

RESULTS = {}


def section(name):
    print(f"\n--- {name} " + "-" * (50 - len(name)))


def record(name, ok, note=""):
    RESULTS[name] = (ok, note)
    print(f"  {'PASS' if ok else 'FAIL'}  {note}")


def i2c_bus():
    import board, busio
    return busio.I2C(board.SCL, board.SDA, frequency=400_000)


def check_i2c():
    section("I2C bus scan")
    expected = {0x33: "MLX90640 thermal", 0x48: "ADS1115 (gas)", 0x40: "INA219 current", 0x24: "PN532 NFC"}
    i2c = i2c_bus()
    while not i2c.try_lock():
        pass
    found = i2c.scan()
    i2c.unlock()
    print("  found:", ", ".join(hex(a) for a in found) or "nothing")
    for addr, name in expected.items():
        print(f"    {hex(addr)}  {name:18} {'yes' if addr in found else 'MISSING'}")
    record("i2c", 0x33 in found, "thermal camera present" if 0x33 in found
           else "thermal camera (0x33) not found: check SDA=pin 3, SCL=pin 5, 3.3V, GND; enable I2C in raspi-config")


def check_thermal():
    section("MLX90640 thermal camera  (THE human check)")
    import adafruit_mlx90640
    mlx = adafruit_mlx90640.MLX90640(i2c_bus())
    mlx.refresh_rate = adafruit_mlx90640.RefreshRate.REFRESH_2_HZ
    frame = [0.0] * 768
    shades = " .:-=+*#%@"
    print("  Point it at an empty space first. Then hold your hand ~20 cm in front.")
    best = 0
    for n in range(10):
        try:
            mlx.getFrame(frame)
        except ValueError:
            continue
        warm = sum(1 for t in frame if t >= 31.0)
        best = max(best, warm)
        lo, hi = min(frame), max(frame)
        print(f"  frame {n+1:>2}: min {lo:5.1f}°C  max {hi:5.1f}°C  warm pixels (≥31°C): {warm:>3}"
              f"  {'← HUMAN' if warm >= 12 else ''}")
        if n == 9:
            for r in range(0, 24, 2):  # small ASCII picture of the last frame
                row = frame[r * 32:(r + 1) * 32]
                print("    " + "".join(shades[min(9, max(0, int((t - lo) / max(0.1, hi - lo) * 9)))] for t in row))
        time.sleep(0.3)
    record("thermal", True, f"frames read OK; most warm pixels seen: {best} "
           f"({'hand detected' if best >= 12 else 'no hand seen: try again closer, or lower HUMAN_TEMP_C in robot_agent.py'})")


def check_gas():
    section("MQ-136 H2S sensor via ADS1115")
    import adafruit_ads1x15.ads1115 as ADS
    from adafruit_ads1x15.analog_in import AnalogIn
    ch = AnalogIn(ADS.ADS1115(i2c_bus()), ADS.P0)
    print("  MQ sensors need 2–5 minutes of warm-up after power-on for stable readings.")
    vals = []
    for _ in range(5):
        vals.append(ch.voltage); print(f"  A0 = {ch.voltage:.3f} V"); time.sleep(0.5)
    ok = 0.05 < max(vals) < 3.4
    record("gas", ok, "reading OK (values are indicative, not calibrated ppm)" if ok
           else "0 V or ~3.3 V flat: check AO→A0 wiring and the voltage divider")


def check_current():
    section("INA219 motor current")
    import adafruit_ina219
    ina = adafruit_ina219.INA219(i2c_bus())
    print(f"  bus {ina.bus_voltage:.2f} V   current {ina.current:.1f} mA")
    record("current", True, "reads OK (near 0 mA is normal with motors off)")


def check_nfc():
    section("PN532 NFC reader  (manhole tag)")
    from adafruit_pn532.i2c import PN532_I2C
    nfc = PN532_I2C(i2c_bus(), debug=False)
    ic, ver, rev, _ = nfc.firmware_version
    print(f"  PN532 firmware {ver}.{rev}. Hold the manhole tag on the reader (15 s)...")
    nfc.SAM_configuration()
    t0 = time.time()
    while time.time() - t0 < 15:
        uid = nfc.read_passive_target(timeout=0.5)
        if uid:
            tag = "NFC-" + uid.hex().upper()
            print(f"\n  TAG READ: {tag}")
            print(f"  → on the laptop, put this line in .env and redeploy:\n      MANHOLE_TAG={tag}")
            record("nfc", True, tag); return
    record("nfc", False, "reader found but no tag read: hold it flat on the reader; DIP switches must be set to I2C")


def check_distance():
    section("JSN-SR04T ultrasonic (sludge depth)")
    from gpiozero import DistanceSensor
    d = DistanceSensor(echo=24, trigger=23, max_distance=4)
    vals = []
    for _ in range(5):
        vals.append(d.distance); print(f"  {d.distance:.2f} m"); time.sleep(0.4)
    ok = any(0.2 < v < 3.9 for v in vals)
    record("distance", ok, "reads OK (it can't see closer than ~20 cm)" if ok
           else "always 0 or max: check the 5V power and the echo voltage divider")


def check_buzzer():
    section("Buzzer")
    from gpiozero import Buzzer
    b = Buzzer(18); b.on(); time.sleep(0.5); b.off()
    record("buzzer", True, "beeped? If silent: check GPIO18 and polarity (long leg = +)")


def check_motor():
    section("Motor via L298N")
    from gpiozero import Motor
    m = Motor(forward=17, backward=27, enable=12)
    print("  spinning forward for 2 s...")
    m.forward(0.6); time.sleep(2); m.stop()
    record("motor", True, "spun? If not: L298N needs its own 6–12V battery, and GND shared with the Pi")


def check_camera():
    section("Pi camera")
    from picamera2 import Picamera2
    cam = Picamera2(); cam.start(); time.sleep(1); cam.capture_file("camera_test.jpg"); cam.close()
    record("camera", True, "saved camera_test.jpg")


CHECKS = {"i2c": check_i2c, "thermal": check_thermal, "gas": check_gas, "current": check_current,
          "nfc": check_nfc, "distance": check_distance, "buzzer": check_buzzer,
          "motor": check_motor, "camera": check_camera}

if __name__ == "__main__":
    wanted = [a for a in sys.argv[1:] if a in CHECKS] or list(CHECKS)
    for name in wanted:
        try:
            CHECKS[name]()
        except Exception as e:
            record(name, False, f"{e.__class__.__name__}: {e}")
    print("\n=== SUMMARY " + "=" * 40)
    for name in wanted:
        ok, note = RESULTS.get(name, (False, "not run"))
        print(f"  {'PASS' if ok else 'FAIL'}  {name:9} {note}")
    must = RESULTS.get("thermal", (True,))[0] if "thermal" in wanted else True
    print("\n" + ("Ready: run  python3 robot/robot_agent.py --rpc http://<laptop-ip>:8545"
                  if must else "Fix the thermal camera first: the robot won't start without it."))
