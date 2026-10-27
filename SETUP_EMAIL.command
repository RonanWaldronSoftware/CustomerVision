#!/bin/bash
cd "$(dirname "$0")"
node setup-email.mjs
read -r -p "Press Enter to close..."
