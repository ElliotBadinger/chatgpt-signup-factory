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
import fs from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import puppeteer from 'puppeteer-core';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

import { readArchive } from '../pipeline/rotation/archiveManager.js';
import { readPool } from '../pipeline/rotation/inboxPoolManager.js';
import { assessCodexQuotas } from '../pipeline/rotation/quotaDetector.js';
import { runCheckArchiveAndReplace } from '../pipeline/rotation/checkArchiveAndReplaceExhausted.js';
import { createAccountViaYutori }   from '../pipeline/rotation/yutoriAccountCreator.js';
import { registerAlias } from '../pipeline/rotation/piAccountRegistrar.js';
import { ensureAuthenticatedChatGptSession, inviteTeamMember, removeTeamMember, removeTeamMemberById, listWorkspaceMembers } from '../pipeline/rotation/teamDriver.js';

// Primary inviter: any current Guardrail workspace member can send invites.
// adventuroussister568 is a confirmed working non-owner inviter (Wave 0 proof).
// Its AgentMail inbox is controlled by epistemophileagent+am8@googlemail.com.
// Set OWNER_EMAIL + OWNER_AGENTMAIL_API_KEY to configure which account sends invites.
// ── Workspace configuration (fully generalised — no hardcoded IDs) ───────────────
// Set via environment variables:
//   WORKSPACE_OWNER_EMAIL   The ChatGPT account that owns the target workspace.
//   WORKSPACE_NAME          Name of the workspace to use (used to pick from account list).
//   WORKSPACE_MAX_MEMBERS   Hard cap on total seats — default 8 (stay under 2× entitled).
//
// The CLI auto-discovers the workspace ID at runtime by calling GET /backend-api/accounts
// with the owner's Bearer token. No AID is ever hardcoded.
//
// Owner token is read from auth.json: looks for any alias whose `email` matches
// WORKSPACE_OWNER_EMAIL, or falls back to 'workspace-owner-a' / 'openai-codex'.
const WORKSPACE_OWNER_EMAIL = process.env.WORKSPACE_OWNER_EMAIL
  ?? 'agentmailroot1773504739a@epistemophile.space';
const WORKSPACE_NAME = process.env.WORKSPACE_NAME ?? 'Root-Mail_a';
const WORKSPACE_MAX_MEMBERS = parseInt(process.env.WORKSPACE_MAX_MEMBERS ?? '8', 10);

// OWNER_EMAIL kept for backward compat (used nowhere critical now)
const OWNER_EMAIL = WORKSPACE_OWNER_EMAIL;
const CHROME_BIN = process.env.CHROME_BIN ?? '/usr/bin/google-chrome-stable';
const CHROME_DEBUG_PORT_BASE = 9300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ROTATION_SERVICE_URL: when set, delegate browser sessions to the Ink service.
const ROTATION_SERVICE_URL = process.env.ROTATION_SERVICE_URL ?? null;

// YUTORI_API_KEY: when set, account creation is fully delegated to the Yutori
// Browsing API (n1 vision agent — real Chrome cloud, Cloudflare-resistant).
// All 9 aliases are created in parallel; fail-fast is disabled.
// Obtain at platform.yutori.com/settings.  Keys start with "yt_".
const YUTORI_API_KEY = process.env.YUTORI_API_KEY ?? null;

// BROWSER_WS_ENDPOINT: remote browser for WORKSPACE API CALLS (lightpanda cloud or remote Chrome).
// Account creation always uses local Chrome + Xvfb (more reliable for Clerk.js forms).
const BROWSER_WS_ENDPOINT = process.env.BROWSER_WS_ENDPOINT
  ?? process.env.LIGHTPANDA_WS_URL
  ?? null;

// LOCAL_CHROME: path to Chrome binary for account creation sessions.
// Default: /usr/bin/google-chrome — already installed on this machine (Chrome 146).
// Account creation ALWAYS uses local Chrome regardless of BROWSER_WS_ENDPOINT,
// because lightpanda cannot reliably handle Clerk.js React forms (auth.openai.com).
const LOCAL_CHROME_BIN = process.env.LOCAL_CHROME_BIN ?? '/usr/bin/google-chrome';

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

function logCanonicalArtifactPath(summary) {
  if (summary?.canonicalRunArtifactPath) {
    console.log(`[check-archive-replace] canonicalRunArtifactPath=${summary.canonicalRunArtifactPath}`);
  }
}

// ── Anti-bot fingerprint patches (applied before any navigation) ──────────────────
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

async function applyStealthPatches(page) {
  // Must be called BEFORE any page.goto() — evaluateOnNewDocument fires on every new document.
  try { await page.setUserAgent(USER_AGENT); } catch {}
  try { await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en' }); } catch {}
  try { await page.emulateTimezone('America/Los_Angeles'); } catch {}
  try {
    await page.evaluateOnNewDocument((lang, ua) => {
      const langs = ['en-US', 'en'];
      try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
      try { Object.defineProperty(navigator, 'languages', { get: () => langs }); } catch {}
      try { Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' }); } catch {}
      try { window.chrome = window.chrome || { runtime: {} }; } catch {}
      // Permissions API normalization (avoids bot-detection probe)
      try {
        const origQuery = window.navigator.permissions?.query;
        if (origQuery) {
          window.navigator.permissions.query = (p) =>
            p.name === 'notifications'
              ? Promise.resolve({ state: Notification.permission })
              : origQuery(p);
        }
      } catch {}
    }, 'en-US,en', USER_AGENT);
  } catch {}
}

// ── Production browser session factory ───────────────────────────────────────────
//
// Account creation ALWAYS uses local Chrome 146 + stealth plugin + Xvfb.
// lightpanda (BROWSER_WS_ENDPOINT) is reserved for workspace API calls only.
//
// Why local Chrome:
//   - auth.openai.com uses Clerk.js React controlled inputs; lightpanda cannot
//     simulate keyboard events reliably (tried page.evaluate, page.keyboard.type)
//   - Feb 2026 proven: real Chrome + stealth passed Turnstile + handled all forms
//   - Chrome 146 + Xvfb are installed on this machine
//
// puppeteer-extra + StealthPlugin covers:
//   navigator.webdriver, chrome runtime, permissions API, Cloudflare TLS fingerprint
async function createBrowserSession() {
  puppeteerExtra.use(StealthPlugin());

  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'gpt-new-account-'));
  console.log(`[cli] Launching local Chrome (stealth+Xvfb): ${LOCAL_CHROME_BIN}`);

  // DISPLAY must be set for non-headless Chrome. If DISPLAY is not set (no X server),
  // headless=true is used as a fallback (still works for most Clerk.js forms).
  const hasDisplay = Boolean(process.env.DISPLAY);
  const browser = await puppeteerExtra.launch({
    executablePath: LOCAL_CHROME_BIN,
    headless: !hasDisplay,        // headless=false under Xvfb; true if no display
    userDataDir: profileDir,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-features=IsolateOrigins,site-per-process',
      '--font-render-hinting=none',
      `--user-agent=${USER_AGENT}`,
      '--lang=en-US,en',
      '--window-size=1280,1024',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  await applyStealthPatches(page);

  const cleanup = async () => {
    try { await browser.close(); } catch {}
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  };

  return { page, browser, cleanup };
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

// ── Workspace API driver (generalised — no hardcoded IDs) ────────────────────────
//
// Confirmed API endpoints (Bearer token via lightpanda page.evaluate()):
//   GET  /backend-api/accounts                          → list all workspaces
//   GET  /backend-api/accounts/{AID}/users              → list members
//   POST /backend-api/accounts/{AID}/invites            → invite (any member token)
//     payload: { email_addresses: [email], role: 'standard-user' }
//     → 200/201 | 409 already-invited | 422 already-member
//   DELETE /backend-api/accounts/{AID}/users/{userId}   → remove (owner token only)
//     → 200 {"success":true}

/** Load the workspace owner's Bearer token from auth.json.
 *  Tries aliases whose email matches WORKSPACE_OWNER_EMAIL, then named fallbacks. */
function loadOwnerToken() {
  try {
    const authData = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    // 1. Match by email field (works for any owner, not hardcoded to specific alias)
    for (const [, v] of Object.entries(authData)) {
      if (typeof v !== 'object' || !v?.access) continue;
      if (v.email === WORKSPACE_OWNER_EMAIL && v.expires > Date.now()) return v.access;
    }
    // 2. Named fallbacks in preference order
    for (const alias of ['workspace-owner-a', 'openai-codex']) {
      const v = authData[alias];
      if (v?.access && v.expires > Date.now()) return v.access;
    }
  } catch { /* ignore */ }
  return null;
}

/** Load any valid member Bearer token (for invite POST — doesn't need owner). */
function loadMemberToken() {
  try {
    const authData = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    // Prefer owner first (they're definitely a member), then any other valid token
    for (const [, v] of Object.entries(authData)) {
      if (typeof v !== 'object' || !v?.access) continue;
      if (v.email === WORKSPACE_OWNER_EMAIL && v.expires > Date.now()) return v.access;
    }
    for (const [, v] of Object.entries(authData)) {
      if (typeof v !== 'object' || !v?.access) continue;
      if (v.expires > Date.now() && v.accountId) return v.access; // has workspace accountId
    }
  } catch { /* ignore */ }
  return loadOwnerToken();
}

/** Discover workspace account ID at runtime by calling GET /backend-api/accounts.
 *  Matches by WORKSPACE_NAME. Caches result for the lifetime of the process. */
let _workspaceAid = null;
async function resolveWorkspaceAid(page, ownerToken) {
  if (_workspaceAid) return _workspaceAid;
  const result = await page.evaluate(async (token, name) => {
    const r = await fetch('/backend-api/accounts', {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!r.ok) return { error: r.status };
    const d = await r.json();
    const ws = (d.items || []).find(a =>
      a.structure === 'workspace' &&
      (a.name === name || (name === '' && a.structure === 'workspace'))
    );
    return ws ? { id: ws.id, name: ws.name } : { items: (d.items || []).map(a => a.name) };
  }, ownerToken, WORKSPACE_NAME);
  if (!result?.id) throw new Error(`Workspace "${WORKSPACE_NAME}" not found. Got: ${JSON.stringify(result)}`);
  _workspaceAid = result.id;
  console.log(`[cli] Workspace "${result.name}" → ${_workspaceAid}`);
  return _workspaceAid;
}

let apiPage = null;
let apiBrowser = null;

async function getApiPage() {
  if (apiPage) return apiPage;
  if (!BROWSER_WS_ENDPOINT) throw new Error('BROWSER_WS_ENDPOINT required');
  console.log('[cli] Connecting lightpanda for workspace API calls...');
  const puppeteer = (await import('puppeteer-core')).default;
  apiBrowser = await puppeteer.connect({ browserWSEndpoint: BROWSER_WS_ENDPOINT });
  apiPage = await apiBrowser.newPage();
  await apiPage.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await sleep(2_000);
  console.log('[cli] lightpanda API page ready');
  return apiPage;
}

const productionTeamDriver = {
  async inviteTeamMember(email) {
    const pg = await getApiPage();
    const ownerToken = loadOwnerToken();
    const aid = await resolveWorkspaceAid(pg, ownerToken);
    return inviteTeamMember(pg, email, { log: console.log, accountId: aid, ownerToken: loadMemberToken() });
  },
  async removeTeamMember(email) {
    const pg = await getApiPage();
    const ownerToken = loadOwnerToken();
    const aid = await resolveWorkspaceAid(pg, ownerToken);
    return removeTeamMember(pg, email, { log: console.log, accountId: aid, ownerToken });
  },
};

// ── Pre-removal phase ─────────────────────────────────────────────────────────────
// Remove exhausted workspace members BEFORE creating new ones.
// Keeps seat count within WORKSPACE_MAX_MEMBERS (default 8) to avoid billing caps.
// Owner is preserved. The seat formula: owner(1) + healthy(n) + new(8) ≤ MAX.
async function preRemoveExhaustedMembers(exhaustedEmails) {
  if (!exhaustedEmails.length) return;
  console.log(`[cli] Pre-removing ${exhaustedEmails.length} exhausted workspace member(s)...`);
  const pg = await getApiPage();
  const ownerToken = loadOwnerToken();
  const aid = await resolveWorkspaceAid(pg, ownerToken);

  const membersResult = await listWorkspaceMembers(pg, { log: console.log, accountId: aid, ownerToken });
  if (!membersResult.ok) {
    console.warn('[cli] Could not list members, skipping pre-removal:', membersResult.error);
    return;
  }

  const exhaustedSet = new Set(exhaustedEmails.map(e => e.toLowerCase()));
  const toRemove = membersResult.members.filter(m =>
    m.userId && exhaustedSet.has(m.email.toLowerCase())
  );

  console.log(`[cli] Removing ${toRemove.length} exhausted member(s) from workspace`);
  for (const m of toRemove) {
    console.log(`[cli] Removing ${m.email} (${m.userId})`);
    const r = await removeTeamMemberById(pg, m.userId, { log: console.log, accountId: aid, ownerToken });
    if (r.ok) console.log(`[cli] ✓ Removed ${m.email}`);
    else console.warn(`[cli] Failed to remove ${m.email}:`, JSON.stringify(r));
    await sleep(1_000);
  }
}

// ── Pre-removal phase ─────────────────────────────────────────────────────────────
// Remove exhausted workspace members BEFORE creating new accounts.
// The Guardrail workspace is at 10/5 seats (2× true-up cap = hard limit).
// We cannot invite new members until old exhausted ones are removed.
if (!values['dry-run'] && BROWSER_WS_ENDPOINT) {
  try {
    // Determine which emails to pre-remove:
    // Read health.json + router to find all exhausted aliases' emails.
    // If --force-replace-all-9, remove all non-owner/non-healthy aliases from workspace.
    const authData = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    const routerData = JSON.parse(fs.readFileSync(routerPath, 'utf8'));
    const healthData = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
    const providers = healthData?.providers ?? {};

    // Never remove the workspace owner or currently healthy aliases
    const KEEP_EMAILS = new Set([
      WORKSPACE_OWNER_EMAIL,  // workspace owner — never remove
    ]);

    const exhaustedEmails = [];
    for (const alias of (routerData.aliases ?? [])) {
      const email = alias.email;
      if (!email || KEEP_EMAILS.has(email)) continue;
      const status = providers[alias.id]?.status;
      const isExhausted = status === 'cooldown' || values['force-replace-all-9'];
      if (isExhausted) exhaustedEmails.push(email);
    }

    // Deduplicate (some aliases share emails)
    const uniqueExhausted = [...new Set(exhaustedEmails)];
    await preRemoveExhaustedMembers(uniqueExhausted);
  } catch (preErr) {
    console.warn('[cli] Pre-removal phase warning:', preErr.message);
    // Non-fatal — continue with pipeline even if pre-removal fails
  }
}

// ── Run pipeline ──────────────────────────────────────────────────────────────────

// Build yutoriCreateAccount adapter when YUTORI_API_KEY is set.
// The adapter bridges the orchestrator's (inbox, opts) signature to the
// strongly-typed YutoriAccountCreatorOpts expected by createAccountViaYutori().
let yutoriCreateAccount = null;
if (YUTORI_API_KEY) {
  console.log('[yutori] YUTORI_API_KEY detected — using Yutori Browsing API (n1-latest)');
  console.log('[yutori] concurrency=9, failFast=false');
  yutoriCreateAccount = async (inbox, opts = {}) => {
    return createAccountViaYutori({
      email:             inbox.inboxAddress,
      agentMailApiKey:   inbox.rootApiKey ?? '',
      agentMailInboxId:  inbox.agentMailInboxId ?? inbox.inboxAddress,
      yutoriApiKey:      YUTORI_API_KEY,
      name:              'Codex Agent',
      teamInviteCallback: opts.teamInviteCallback,
    });
  };
}

let result;
try {
  result = await runCheckArchiveAndReplace({
    dryRun:           values['dry-run'],
    forceReplaceAll9: values['force-replace-all-9'],
    log:              console.log,
    archivePath,
    poolPath,
    healthPath,
    routerPath,
    authPath,
    // Yutori path: replaces createBrowserSession entirely when YUTORI_API_KEY set.
    // Legacy path: createBrowserSession (local Chrome + Xvfb) used when key absent.
    yutoriCreateAccount,
    createBrowserSession: yutoriCreateAccount ? undefined : createBrowserSession,
    finalize:         productionFinalize,
    teamDriver:       productionTeamDriver,
    bootstrapNewRoot: undefined,
    // Yutori: all 9 in parallel, independent tasks — no fail-fast needed.
    // Legacy: concurrency=1 (Xvfb conflicts) + failFast for fast iteration.
    failFast:    yutoriCreateAccount ? false : true,
    concurrency: yutoriCreateAccount ? 9    : 1,
  });
} catch (err) {
  // failFast threw — print the full error and exit immediately
  const msg = err?.message ?? String(err);
  const ctx = err?.context ? `\n  context: ${JSON.stringify(err.context, null, 4)}` : '';
  console.error(`\n[PIPELINE ABORTED — fail-fast]\n${msg}${ctx}`);
  process.exit(1);
}

// ── Print result summary ──────────────────────────────────────────────────────────
console.log('\n=== Result ===');
console.log(`Exhausted processed: ${result.exhaustedProcessed}`);
console.log(`Reinstated: ${result.reinstated}`);
console.log(`New accounts created: ${result.newAccountsCreated}`);
console.log(`Failed: ${result.failed}`);
if (result.dryRun) {
  console.log('(DRY RUN — no writes made)');
}
if (result.details?.length) {
  for (const d of result.details) {
    if (d.status === 'failed') {
      console.error(`\n[FAILED] alias=${d.aliasId} inbox=${d.inbox ?? '?'}\n  error=${d.error}`);
    }
  }
}

if (result.failed > 0) {
  process.exit(1);
}
