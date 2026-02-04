#!/usr/bin/env bash
set -euo pipefail

# Runs the flow in a headful Chrome inside a virtual framebuffer.
# This can reduce Cloudflare/Turnstile headless detection while keeping the run non-interactive.

cd "$(dirname "$0")/.."

export USER_DATA_DIR="${USER_DATA_DIR:-$(mktemp -d)}"
export MAX_RUN_MS="${MAX_RUN_MS:-300000}"
export STEP_TIMEOUT_MS="${STEP_TIMEOUT_MS:-60000}"

# IMPORTANT: headful mode (HEADLESS=false) inside Xvfb.
export HEADLESS="false"

# Optional hardening toggles
export STEALTH="${STEALTH:-true}"

# A stable viewport is important; Xvfb screen size should match BROWSER_WINDOW_SIZE.
export BROWSER_WINDOW_SIZE="${BROWSER_WINDOW_SIZE:-1280,1024}"

# Start Xvfb with a matching screen.
exec xvfb-run -a -s "-screen 0 1280x1024x24" node --env-file=../../.env src/index.js
