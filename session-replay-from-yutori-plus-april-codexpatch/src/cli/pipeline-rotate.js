#!/usr/bin/env node
/**
 * pipeline-rotate  —  Codex account quota rotation CLI
 *
 * Usage:
 *   node src/cli/pipeline-rotate.js [options]
 *
 * Modes:
 *   (default)    Run one rotation cycle then exit
 *   --daemon     Run continuously as a daemon
 *   --status     Show current quota status and exit
 *   --dry-run    Simulate without making real changes
 *   --preemptive Also rotate at-risk (≤15%) accounts, not just exhausted ones
 *   --force      Force a rotation even when no account is exhausted
 *
 * Options:
 *   --poll-interval <ms>       Idle poll interval (daemon mode, default: 300000)
 *   --active-poll  <ms>        At-risk poll interval (daemon mode, default: 60000)
 *   --max-rotations <n>        Max rotations per cycle (default: 3)
 *   --rotate-email <email>     Force-rotate a specific alias email
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIVE_MUTATION_POLICY_MESSAGE =
  '[pipeline-rotate] Live unattended rotation is disabled by the deep-interview fleet concurrency policy; use node --experimental-vm-modules src/cli/pipeline-check-archive-replace.js for canonical locked mutations.';

async function main(argv = process.argv.slice(2)) {
  const parsed = {
    daemon: false,
    status: false,
    dryRun: false,
    preemptive: false,
    force: false,
    pollIntervalMs: 5 * 60 * 1000,
    activePollMs: 60 * 1000,
    maxRotations: 3,
    rotateEmail: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--daemon')        { parsed.daemon = true; continue; }
    if (t === '--status')        { parsed.status = true; continue; }
    if (t === '--dry-run')       { parsed.dryRun = true; continue; }
    if (t === '--preemptive')    { parsed.preemptive = true; continue; }
    if (t === '--force')         { parsed.force = true; continue; }
    if (t === '--poll-interval') { parsed.pollIntervalMs = Number(argv[++i]); continue; }
    if (t === '--active-poll')   { parsed.activePollMs = Number(argv[++i]); continue; }
    if (t === '--max-rotations') { parsed.maxRotations = Number(argv[++i]); continue; }
    if (t === '--rotate-email')  { parsed.rotateEmail = argv[++i]; continue; }
  }

  // ── Status mode ─────────────────────────────────────────────────────────────
  if (parsed.status) {
    const { assessCodexQuotas } = await import('../pipeline/rotation/quotaDetector.js');
    const assessment = assessCodexQuotas();

    console.log('\n=== Codex Quota Status ===\n');
    for (const alias of assessment.aliases) {
      const pct = alias.effectiveFraction === null ? '  ?' : `${Math.round(alias.effectiveFraction * 100)}%`.padStart(4);
      const flag = alias.exhausted ? '🔴 EXHAUSTED' : alias.atRisk ? '🟡 AT-RISK ' : '🟢 OK      ';
      const stale = alias.stale ? ' [stale]' : '';
      console.log(`  ${flag}  ${pct}  ${alias.email}${stale}`);
    }
    console.log(`\n  Total: ${assessment.aliases.length} codex aliases`);
    console.log(`  Exhausted: ${assessment.exhausted.length}`);
    console.log(`  At-risk:   ${assessment.atRisk.length}`);
    console.log(`  Healthy:   ${assessment.healthy.length}\n`);
    return;
  }

  if (!parsed.dryRun) {
    console.error(LIVE_MUTATION_POLICY_MESSAGE);
    process.exitCode = 1;
    return;
  }

  // ── Daemon mode ──────────────────────────────────────────────────────────────
  if (parsed.daemon) {
    const { startRotationDaemon } = await import('../pipeline/rotation/rotationDaemon.js');
    const { stop, done } = startRotationDaemon({
      dryRun: parsed.dryRun,
      preemptive: parsed.preemptive,
      pollIntervalMs: parsed.pollIntervalMs,
      activePollMs: parsed.activePollMs,
      maxRotationsPerCycle: parsed.maxRotations,
      onCycle: (summary) => {
        for (const r of (summary.rotations ?? [])) {
          if (r.status === 'success') {
            console.log(`[ROTATION] ✅ ${r.exhaustedAlias?.email} → ${r.newMember?.email} (cycle: ${r.cycleId})`);
          } else {
            console.log(`[ROTATION] ❌ ${r.email} failed: ${r.error}`);
          }
        }
      },
    });
    await done;
    return;
  }

  // ── Single-cycle mode (default) ──────────────────────────────────────────────
  const { runRotationCycle, assessCodexQuotas } = await import('../pipeline/rotation/rotationCycle.js');
  const { resolveEnv } = await import('../pipeline/rotation/teamDriver.js');

  const env = resolveEnv(path.resolve(__dirname, '..', '..'));
  const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

  // Build forceAliases list
  const forceAliases = [];

  if (parsed.rotateEmail) {
    forceAliases.push(parsed.rotateEmail);
    console.log(`[pipeline-rotate] Forcing rotation of specific alias: ${parsed.rotateEmail}`);
  } else if (parsed.force) {
    const assessment = assessCodexQuotas();
    if (assessment.aliases.length === 0) {
      console.error('[pipeline-rotate] No codex aliases found in account-router.json');
      process.exitCode = 1;
      return;
    }
    const target = assessment.aliases[0];
    forceAliases.push(target.email);
    console.log(`[pipeline-rotate] --force: targeting most exhausted alias ${target.email} (${Math.round((target.effectiveFraction ?? 0) * 100)}%)`);
  }

  const summary = await runRotationCycle({
    env,
    dryRun: parsed.dryRun,
    preemptive: parsed.preemptive,
    maxRotationsPerCycle: parsed.maxRotations,
    forceAliases,
    log,
  });

  console.log('\n=== Rotation Cycle Summary ===');
  console.log(`Status: ${summary.status}`);
  console.log(`Time:   ${summary.cycleAt}`);
  if (summary.rotations?.length > 0) {
    for (const r of summary.rotations) {
      if (r.status === 'success') {
        console.log(`  ✅ ${r.exhaustedAlias?.email} → ${r.newMember?.email}`);
      } else {
        console.log(`  ❌ ${r.email}: ${r.error}`);
      }
    }
  } else {
    console.log('  No rotations needed (all accounts healthy)');
  }

  if (summary.status === 'failed' || summary.rotations?.some((r) => r.status === 'failed')) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[pipeline-rotate] Fatal: ${error.message}`);
  if (error.stack) console.error(error.stack);
  process.exitCode = 1;
});
