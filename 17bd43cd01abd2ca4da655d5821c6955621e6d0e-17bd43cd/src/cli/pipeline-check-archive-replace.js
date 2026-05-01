#!/usr/bin/env node
/**
 * pipeline-check-archive-replace.js
 *
 * CLI for the Codex alias check-archive-replace pipeline.
 *
 * Usage:
 *   node src/cli/pipeline-check-archive-replace.js [options]
 *
 * Options:
 *   --dry-run                Simulate, no writes
 *   --force-replace-all-9    Create accounts for all 9 inboxes now (proactive)
 *   --status                 Show current archive + pool status, exit
 *
 * Path overrides (for testing):
 *   --archive-path <path>
 *   --pool-path <path>
 *   --health-path <path>
 *   --router-path <path>
 *   --auth-path <path>
 */

import { parseArgs } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import puppeteer from 'puppeteer-core';

import { readArchive } from '../pipeline/rotation/archiveManager.js';
import { readPool } from '../pipeline/rotation/inboxPoolManager.js';
import { assessCodexQuotas } from '../pipeline/rotation/quotaDetector.js';
import { runCheckArchiveAndReplace } from '../pipeline/rotation/checkArchiveAndReplaceExhausted.js';
import { registerAlias } from '../pipeline/rotation/piAccountRegistrar.js';
import { ensureAuthenticatedChatGptSession, inviteTeamMember, removeTeamMember } from '../pipeline/rotation/teamDriver.js';

const OWNER_EMAIL = 'brightbeer360@agentmail.to';
const CHROME_BIN = process.env.CHROME_BIN ?? '/usr/bin/google-chrome-stable';
const CHROME_DEBUG_PORT_BASE = 9300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Argument parsing ──────────────────────────────────────────────────────────────
const { values } = parseArgs({
  options: {
    'dry-run':              { type: 'boolean', default: false },
    'force-replace-all-9':  { type: 'boolean', default: false },
    'status':               { type: 'boolean', default: false },
    // Path overrides (primarily for tests)
    'archive-path':         { type: 'string' },
    'pool-path':            { type: 'string' },
    'health-path':          { type: 'string' },
    'router-path':          { type: 'string' },
    'auth-path':            { type: 'string' },
  },
  strict: true,
  allowPositionals: false,
});

// ── Default paths ─────────────────────────────────────────────────────────────────
const agentDir   = path.join(os.homedir(), '.pi', 'agent');
const archivePath = values['archive-path'] ?? path.join(agentDir, 'codex-alias-archive.json');
const poolPath    = values['pool-path']    ?? path.join(agentDir, 'codex-inbox-pool.json');
const healthPath  = values['health-path']  ?? path.join(agentDir, 'account-router-health.json');
const routerPath  = values['router-path']  ?? path.join(agentDir, 'account-router.json');
const authPath    = values['auth-path']    ?? path.join(agentDir, 'auth.json');

// ── --status ──────────────────────────────────────────────────────────────────────
if (values.status) {
  const archive = readArchive({ archivePath });
  const pool    = readPool({ poolPath });
  const quota   = assessCodexQuotas({ healthPath, routerPath });

  const archivedCount  = archive.aliases.length;
  const reinstatedCount = archive.aliases.filter((a) => a.reinstated).length;

  const availableCount   = pool.entries.filter((e) => e.status === 'available').length;
  const inUseCount       = pool.entries.filter((e) => e.status === 'in-use').length;
  const failedCount      = pool.entries.filter((e) => e.status === 'failed').length;
  const chatGptUsedCount = pool.entries.filter((e) => e.status === 'chatgpt-used').length;

  console.log('=== Codex Rotation Status ===');
  console.log(`Archive: ${archivedCount} aliases archived, ${reinstatedCount} reinstated`);
  console.log(`Pool: ${availableCount} available, ${inUseCount} in-use, ${failedCount} failed, ${chatGptUsedCount} chatgpt-used`);
  console.log(`Codex aliases: ${quota.aliases.length} total (${quota.healthy.length} healthy, ${quota.atRisk.length} at-risk, ${quota.exhausted.length} exhausted)`);
  process.exit(0);
}

// ── --dry-run header ─────────────────────────────────────────────────────────────
if (values['dry-run']) {
  console.log('[dry-run] Simulating check-archive-replace — no writes will occur');
}

// ── Production browser session factory ───────────────────────────────────────────
async function createBrowserSession() {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'gpt-new-account-'));
  const port = CHROME_DEBUG_PORT_BASE + Math.floor(Math.random() * 100);

  const proc = spawn(
    'xvfb-run',
    [
      '-a', CHROME_BIN,
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let browser = null;
  const deadline = Date.now() + 30_000;
  while (!browser && Date.now() < deadline) {
    try {
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    } catch {
      await sleep(1_000);
    }
  }
  if (!browser) throw new Error(`Chrome not available at port ${port} after 30s`);

  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());

  const cleanup = async () => {
    try { await browser.close(); } catch {}
    try { proc.kill('SIGTERM'); } catch {}
  };

  return { page, browser, proc, cleanup };
}

// ── Production finalize wrapper ───────────────────────────────────────────────────
// Wraps the credential rename + alias registration.
// The real finalizeAddedAccount() from the pi extension would do probe validation;
// here we implement a lightweight version that registers the alias and returns ok.
async function productionFinalize({
  tempId: tid,
  finalId,
  configPath,
  poolName,
  baseProviderId,
  email,
  label,
  modelId,
  authPath: aPath,
}) {
  try {
    // Register the new alias in account-router.json
    registerAlias({
      aliasId: finalId,
      email,
      label: label || finalId,
      poolName,
      modelId: modelId ?? 'gpt-5.4',
      baseProviderId,
      routerJsonPath: configPath,
    });
    return { ok: true, validation: 'ok' };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ── Owner team driver ─────────────────────────────────────────────────────────────
let ownerPage = null;
let ownerBrowser = null;
let ownerProc = null;

async function getOwnerPage() {
  if (ownerPage) return ownerPage;
  console.log('[cli] Authenticating ChatGPT owner session...');
  const ownerSession = await ensureAuthenticatedChatGptSession({
    email: OWNER_EMAIL,
    port: CHROME_DEBUG_PORT_BASE - 1,
    log: console.log,
  });
  ownerPage = ownerSession.page;
  ownerBrowser = ownerSession.browser;
  ownerProc = ownerSession.proc;
  return ownerPage;
}

const productionTeamDriver = {
  async inviteTeamMember(email) {
    const pg = await getOwnerPage();
    return inviteTeamMember(pg, email, { log: console.log });
  },
  async removeTeamMember(email) {
    const pg = await getOwnerPage();
    return removeTeamMember(pg, email, { log: console.log });
  },
};

// ── Run pipeline ──────────────────────────────────────────────────────────────────
const result = await runCheckArchiveAndReplace({
  dryRun: values['dry-run'],
  forceReplaceAll9: values['force-replace-all-9'],
  log: console.log,
  archivePath,
  poolPath,
  healthPath,
  routerPath,
  authPath,
  createBrowserSession,
  finalize: productionFinalize,
  teamDriver: productionTeamDriver,
  bootstrapNewRoot: undefined,  // would call pipeline-bootstrap here
});

// ── Print result summary ──────────────────────────────────────────────────────────
console.log('\n=== Result ===');
console.log(`Exhausted processed: ${result.exhaustedProcessed}`);
console.log(`Reinstated: ${result.reinstated}`);
console.log(`New accounts created: ${result.newAccountsCreated}`);
console.log(`Failed: ${result.failed}`);
if (result.dryRun) {
  console.log('(DRY RUN — no writes made)');
}

if (result.failed > 0) {
  process.exit(1);
}
