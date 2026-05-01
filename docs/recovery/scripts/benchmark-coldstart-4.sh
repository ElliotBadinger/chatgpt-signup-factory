#!/usr/bin/env bash
set -euo pipefail

# 4 consecutive cold-start headless runs + simple benchmark report.
#
# Usage:
#   cd /home/epistemophile/chatgpt-factory-bundle/.worktrees/phase01-e2e-trial
#   ./scripts/benchmark-coldstart-4.sh
#
# Notes:
# - Each run uses a fresh USER_DATA_DIR (mktemp -d).
# - We consider a run SUCCESS only if:
#     (a) process exits 0
#     (b) logs contain subscribe-click reaction evidence ("Checkout network response detected")

PROJECT_ROOT="/home/epistemophile/chatgpt-factory-bundle/.worktrees/phase01-e2e-trial"
cd "$PROJECT_ROOT"

RUN_DATE="$(date +%Y-%m-%d)"
LOG_DIR="$PROJECT_ROOT/docs/benchmarks/logs/$RUN_DATE"
mkdir -p "$LOG_DIR"

REPORT_FILE="$PROJECT_ROOT/docs/benchmarks/$RUN_DATE-coldstart-4runs.md"

extract_milestones_json() {
  local log_file="$1"
  node - <<'NODE' "$log_file"
import fs from 'node:fs';

const logFile = process.argv[2];
const text = fs.readFileSync(logFile, 'utf8');
const lines = text.split(/\r?\n/);

function extractTsFromPath(p) {
  // Examples:
  //   step_1_preparse_2026-02-04T08-39-16-165Z.png
  //   checkout_subscribe_network_response_2026-02-04T08-40-29-507Z.png
  const m = p.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
  if (!m) return null;
  // Convert 2026-02-04T08-39-16-165Z -> 2026-02-04T08:39:16.165Z
  return m[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
}

let lastScreenshotIso = null;
let firstScreenshotIso = null;

const firstStateIso = {};
let waitingCheckoutStart = false;
let waitingSubscribeEvidence = false;

for (const line of lines) {
  const fp = line.match(/"filePath":"([^"]+)"/);
  if (fp) {
    const iso = extractTsFromPath(fp[1]);
    if (iso) {
      lastScreenshotIso = iso;
      if (!firstScreenshotIso) firstScreenshotIso = iso;

      if (waitingCheckoutStart && fp[1].includes('checkout_start_')) {
        firstStateIso.CHECKOUT_DETECTED = iso;
        waitingCheckoutStart = false;
      }
      if (waitingSubscribeEvidence && fp[1].includes('checkout_subscribe_network_response_')) {
        firstStateIso.SUBSCRIBE_REACTION = iso;
        waitingSubscribeEvidence = false;
      }
    }
  }

  const st = line.match(/\[Step \d+\] State: ([A-Z_]+)/);
  if (st && lastScreenshotIso && !firstStateIso[st[1]]) {
    firstStateIso[st[1]] = lastScreenshotIso;
  }

  if (!firstStateIso.CHECKOUT_DETECTED && line.includes('Detected checkout page')) {
    waitingCheckoutStart = true;
  }

  // Subscribe-click verification evidence can be:
  // - a network watcher hit (then we record the timestamp from the subsequent screenshot)
  // - an explicit UI progress marker ("Checkout progress detected!")
  if (!firstStateIso.SUBSCRIBE_REACTION && line.includes('Checkout progress detected!') && lastScreenshotIso) {
    firstStateIso.SUBSCRIBE_REACTION = lastScreenshotIso;
  }
  if (!firstStateIso.SUBSCRIBE_REACTION && line.includes('Checkout network response detected')) {
    waitingSubscribeEvidence = true;
  }
}

const out = {
  start_iso: firstScreenshotIso,
  milestones_iso: {
    LOGIN_EMAIL: firstStateIso.LOGIN_EMAIL ?? null,
    OTP_VERIFICATION: firstStateIso.OTP_VERIFICATION ?? null,
    CHAT_INTERFACE: firstStateIso.CHAT_INTERFACE ?? null,
    CHECKOUT_DETECTED: firstStateIso.CHECKOUT_DETECTED ?? null,
    SUBSCRIBE_REACTION: firstStateIso.SUBSCRIBE_REACTION ?? null,
  },
};

console.log(JSON.stringify(out));
NODE
}

isoToMs() {
  node -e 'console.log(Date.parse(process.argv[1]) || 0)' "$1"
}

fmtDelta() {
  local start_iso="$1"
  local target_iso="$2"
  if [[ -z "$start_iso" || "$start_iso" == "null" || -z "$target_iso" || "$target_iso" == "null" ]]; then
    echo "N/A"
    return
  fi
  local start_ms
  local target_ms
  start_ms="$(isoToMs "$start_iso")"
  target_ms="$(isoToMs "$target_iso")"
  if [[ "$start_ms" == "0" || "$target_ms" == "0" ]]; then
    echo "N/A"
    return
  fi
  # seconds with one decimal
  node -e 'const s=Number(process.argv[1]); const t=Number(process.argv[2]); console.log(((t-s)/1000).toFixed(1));' "$start_ms" "$target_ms"
}

# report header
cat > "$REPORT_FILE" <<EOF
# Cold-Start Benchmark Report ($RUN_DATE)

Command per run:

\`\`\`bash
export USER_DATA_DIR=\$(mktemp -d)
MAX_RUN_MS=300000 STEP_TIMEOUT_MS=60000 HEADLESS=true STEALTH=true node --env-file=../../.env src/index.js
\`\`\`

## Per-run results

| Run | Exit | Total (s) | t(LOGIN_EMAIL) | t(OTP_VERIFICATION) | t(CHAT_INTERFACE) | t(CHECKOUT) | t(subscribe reaction) | Log |
|-----|------|-----------|----------------|---------------------|-------------------|-------------|------------------------|-----|
EOF

runtimes=()

for i in 1 2 3 4; do
  echo "=== Run $i/4 ==="
  USER_DATA_DIR="$(mktemp -d)"
  LOG_FILE="$LOG_DIR/run-$i.log"

  start_epoch="$(date +%s)"
  set +e
  MAX_RUN_MS=300000 STEP_TIMEOUT_MS=60000 HEADLESS=true STEALTH=true USER_DATA_DIR="$USER_DATA_DIR" \
    node --env-file=../../.env src/index.js >"$LOG_FILE" 2>&1
  ec=$?
  set -e
  end_epoch="$(date +%s)"
  duration_s=$((end_epoch-start_epoch))

  # Must have explicit subscribe reaction evidence (network watcher OR UI progress marker).
  if grep -q "Checkout network response detected" "$LOG_FILE" || grep -q "Checkout progress detected!" "$LOG_FILE"; then
    has_reaction=1
  else
    has_reaction=0
  fi

  status="FAIL"
  if [[ "$ec" -eq 0 && "$has_reaction" -eq 1 ]]; then
    status="PASS"
  fi

  ms_json="$(extract_milestones_json "$LOG_FILE")"
  start_iso="$(node -e 'const j=JSON.parse(process.argv[1]); console.log(j.start_iso ?? "");' "$ms_json")"

  login_iso="$(node -e 'const j=JSON.parse(process.argv[1]); console.log(j.milestones_iso.LOGIN_EMAIL ?? "");' "$ms_json")"
  otp_iso="$(node -e 'const j=JSON.parse(process.argv[1]); console.log(j.milestones_iso.OTP_VERIFICATION ?? "");' "$ms_json")"
  chat_iso="$(node -e 'const j=JSON.parse(process.argv[1]); console.log(j.milestones_iso.CHAT_INTERFACE ?? "");' "$ms_json")"
  checkout_iso="$(node -e 'const j=JSON.parse(process.argv[1]); console.log(j.milestones_iso.CHECKOUT_DETECTED ?? "");' "$ms_json")"
  react_iso="$(node -e 'const j=JSON.parse(process.argv[1]); console.log(j.milestones_iso.SUBSCRIBE_REACTION ?? "");' "$ms_json")"

  t_login="$(fmtDelta "$start_iso" "$login_iso")"
  t_otp="$(fmtDelta "$start_iso" "$otp_iso")"
  t_chat="$(fmtDelta "$start_iso" "$chat_iso")"
  t_checkout="$(fmtDelta "$start_iso" "$checkout_iso")"
  t_react="$(fmtDelta "$start_iso" "$react_iso")"

  echo "| $i | $status (ec=$ec) | $duration_s | $t_login | $t_otp | $t_chat | $t_checkout | $t_react | docs/benchmarks/logs/$RUN_DATE/run-$i.log |" >> "$REPORT_FILE"

  rm -rf "$USER_DATA_DIR"

  if [[ "$status" != "PASS" ]]; then
    echo "Run $i FAILED (ec=$ec, has_reaction=$has_reaction). See $LOG_FILE" >&2
    echo "--- last 200 log lines ---" >&2
    tail -n 200 "$LOG_FILE" >&2
    exit 1
  fi

  runtimes+=("$duration_s")
done

# summary stats
node - <<'NODE' "$REPORT_FILE" "${runtimes[@]}"
const reportFile = process.argv[2];
const samples = process.argv.slice(3).map(Number).filter(Number.isFinite);
samples.sort((a,b)=>a-b);
const sum = samples.reduce((a,b)=>a+b,0);
const avg = sum / samples.length;
const min = samples[0];
const max = samples[samples.length-1];
// p95-ish with n=4 -> max
const p95 = samples[Math.ceil(0.95*samples.length)-1];

const fs = await import('node:fs');
fs.appendFileSync(reportFile,
  `\n\n## Summary stats (total runtime, seconds)\n\n- samples: ${JSON.stringify(samples)}\n- avg: ${avg.toFixed(1)}\n- min: ${min.toFixed(0)}\n- max: ${max.toFixed(0)}\n- p95-ish: ${p95.toFixed(0)}\n`);
NODE

echo "Wrote report: $REPORT_FILE"
