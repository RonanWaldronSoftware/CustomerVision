#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install the current LTS version from https://nodejs.org."
  exit 1
fi
node setup-email.mjs --if-needed || exit 1
node server.mjs
