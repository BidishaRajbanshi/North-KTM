#!/bin/bash
# One-time Raspberry Pi setup for SewerSafe.  Run on the Pi:  bash robot/pi_setup.sh
set -e
echo "== Enabling I2C and camera =="
sudo raspi-config nonint do_i2c 0 || true
sudo raspi-config nonint do_camera 0 2>/dev/null || true   # newer Pi OS enables the camera by default
CFG=/boot/firmware/config.txt; [ -f "$CFG" ] || CFG=/boot/config.txt
grep -q "i2c_arm_baudrate" "$CFG" || echo "dtparam=i2c_arm_baudrate=400000" | sudo tee -a "$CFG" >/dev/null

echo "== System packages =="
sudo apt-get update -y
sudo apt-get install -y python3-venv python3-pip python3-picamera2 i2c-tools

echo "== Python environment (robot/.venv) =="
cd "$(dirname "$0")"
python3 -m venv --system-site-packages .venv      # system-site-packages lets it see picamera2
. .venv/bin/activate
pip install --upgrade pip
pip install -r requirements-pi.txt

echo
echo "Done. REBOOT once (sudo reboot), then:"
echo "  cd safesewer && . robot/.venv/bin/activate"
echo "  i2cdetect -y 1                 # should list 24 33 40 48"
echo "  python3 robot/hw_check.py      # test each part"
