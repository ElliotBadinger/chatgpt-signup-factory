/**
 * rotationDaemon.js
 *
 * Continuous rotation daemon that:
 *  - Polls quota health on a configurable interval
 *  - Triggers rotation cycles when accounts are exhausted or about to be exhausted
 *  - Tracks consecutive failures with exponential backoff
 *  - Emits structured log events
 *  - Handles SIGTERM/SIGINT gracefully
 *
 * The daemon runs indefinitely until signaled to stop.
 */

import { runRotationCycle, assessCodexQuotas, QUOTA_EXHAUSTED_THRESHOLD, QUOTA_PREEMPTIVE_THRESHOLD } from './rotationCycle.js';

const DEFAULT_POLL_INTERVAL_MS   = 5  * 60 * 1000;   // 5  min — how often we check quotas
const DEFAULT_ACTIVE_POLL_MS     = 60 * 1000;         // 1  min — fast-check when at-risk accounts exist
const DEFAULT_MIN_CYCLE_INTERVAL = 10 * 60 * 1000;    // 10 min — don't rotate again before this
const DEFAULT_BACKOFF_BASE_MS    = 2  * 60 * 1000;    // 2  min
const DEFAULT_BACKOFF_MAX_MS     = 30 * 60 * 1000;    // 30 min
const LIVE_MUTATION_POLICY_MESSAGE =
  'Live unattended rotation is disabled by the deep-interview fleet concurrency policy; use pipeline-check-archive-replace.js for canonical locked mutations.';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function now() { return new Date().toISOString(); }

function buildLogger(prefix) {
  return (msg) => {
    const line = `[${now()}] ${prefix} ${msg}`;
    process.stdout.write(`${line}\n`);
  };
}

/**
 * Calculate next poll delay based on current state.
 */
function nextPollDelay({
  assessment,
  consecutiveFailures,
  backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
  backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  activePollMs = DEFAULT_ACTIVE_POLL_MS,
}) {
  if (consecutiveFailures > 0) {
    const backoff = Math.min(backoffMaxMs, backoffBaseMs * (2 ** (consecutiveFailures - 1)));
    return backoff;
  }
  if (assessment && (assessment.exhausted?.length > 0 || assessment.atRisk?.length > 0)) {
    return activePollMs;
  }
  return pollIntervalMs;
}

/**
 * Start the rotation daemon.
 *
 * @param {object} options
 * @param {boolean}  [options.dryRun=false]       - don't make real changes
 * @param {boolean}  [options.preemptive=false]    - rotate at-risk accounts before exhaustion
 * @param {number}   [options.pollIntervalMs]      - idle poll interval
 * @param {number}   [options.activePollMs]        - at-risk poll interval
 * @param {number}   [options.minCycleIntervalMs]  - minimum time between rotation cycles
 * @param {number}   [options.maxRotationsPerCycle]
 * @param {object}   [options.env]                 - credential env vars
 * @param {function} [options.onCycle]             - called after each cycle with the summary
 * @param {function} [options.onAssess]            - called after each assessment
 * @returns {{ stop: function }} - call stop() to halt the daemon
 */
export function startRotationDaemon({
  dryRun = false,
  preemptive = false,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  activePollMs = DEFAULT_ACTIVE_POLL_MS,
  minCycleIntervalMs = DEFAULT_MIN_CYCLE_INTERVAL,
  maxRotationsPerCycle = 3,
  env,
  onCycle = () => {},
  onAssess = () => {},
} = {}) {
  if (!dryRun) {
    throw new Error(LIVE_MUTATION_POLICY_MESSAGE);
  }
  const log = buildLogger('[daemon]');
  let running = true;
  let consecutiveFailures = 0;
  let lastCycleAt = 0;

  async function daemonLoop() {
    log(`Starting rotation daemon (dryRun=${dryRun}, preemptive=${preemptive}, pollInterval=${pollIntervalMs}ms)`);

    while (running) {
      // Assess current quota state
      let assessment;
      try {
        assessment = assessCodexQuotas();
        onAssess(assessment);

        const exhaustedCount = assessment.exhausted?.length ?? 0;
        const atRiskCount = assessment.atRisk?.length ?? 0;
        const totalCodex = assessment.aliases?.length ?? 0;

        log(`Quota assessment: ${totalCodex} codex aliases, ${exhaustedCount} exhausted, ${atRiskCount} at-risk`);

        if (exhaustedCount > 0) {
          log(`Exhausted: ${assessment.exhausted.map((a) => `${a.email}(${Math.round((a.effectiveFraction ?? 0) * 100)}%)`).join(', ')}`);
        }
        if (atRiskCount > 0) {
          log(`At-risk:   ${assessment.atRisk.map((a) => `${a.email}(${Math.round((a.effectiveFraction ?? 0) * 100)}%)`).join(', ')}`);
        }
      } catch (error) {
        log(`Assessment error: ${error.message}`);
        assessment = null;
      }

      // Decide whether to run a rotation cycle
      const needsRotation = assessment && (
        assessment.exhausted?.length > 0 ||
        (preemptive && assessment.atRisk?.length > 0)
      );
      const cooldownExpired = (Date.now() - lastCycleAt) >= minCycleIntervalMs;

      if (needsRotation && cooldownExpired) {
        log(`Triggering rotation cycle`);
        try {
          const summary = await runRotationCycle({
            env,
            dryRun,
            preemptive,
            maxRotationsPerCycle,
            log,
          });
          consecutiveFailures = 0;
          lastCycleAt = Date.now();
          onCycle(summary);
          log(`Cycle complete: ${summary.rotations?.length ?? 0} rotations, status=${summary.status}`);
        } catch (error) {
          consecutiveFailures++;
          log(`Cycle failed (attempt ${consecutiveFailures}): ${error.message}`);
        }
      } else if (needsRotation && !cooldownExpired) {
        log(`Rotation needed but in cooldown (${Math.round((minCycleIntervalMs - (Date.now() - lastCycleAt)) / 1000)}s remaining)`);
      }

      if (!running) break;

      const delay = nextPollDelay({ assessment, consecutiveFailures, pollIntervalMs, activePollMs });
      log(`Next check in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
    }

    log(`Daemon stopped`);
  }

  // Start the loop (non-blocking)
  const loopPromise = daemonLoop().catch((error) => {
    buildLogger('[daemon]')(`Fatal error: ${error.message}`);
    process.exitCode = 1;
  });

  // Graceful shutdown
  const stop = () => {
    running = false;
    log(`Stop requested`);
  };

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      log(`Received ${sig}`);
      stop();
    });
  }

  return { stop, done: loopPromise };
}
