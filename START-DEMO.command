#!/bin/bash
# Double-click to start SewerSafe on Mac. If macOS blocks it: right-click → Open → Open.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org then try again."
  read -p "Press Enter to close"; exit 1
fi
node scripts/start.js
read -p "Press Enter to close"
