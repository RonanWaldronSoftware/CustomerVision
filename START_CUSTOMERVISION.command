#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Node.js is required to run CustomerVision."
  echo "Install the current LTS version from https://nodejs.org and launch this file again."
  echo ""
  read -r -p "Press Enter to close..."
  exit 1
fi
node setup-email.mjs --if-needed || {
  read -r -p "Press Enter to close..."
  exit 1
}
node server.mjs
