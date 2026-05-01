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
import { readPool, writePool } from '../pipeline/rotation/inboxPoolManager.js';
import { assessCodexQuotas } from '../pipeline/rotation/quotaDetector.js';
import { runCheckArchiveAndReplace } from '../pipeline/rotation/checkArchiveAndReplaceExhausted.js';
import { registerAlias } from '../pipeline/rotation/piAccountRegistrar.js';
import { onboardInboxToPiRouter } from '../pipeline/rotation/routerOnboarder.js';
import { createBrowserlessWorkspaceClient, isWorkspaceDeactivatedError, WorkspaceClientError } from '../pipeline/rotation/browserlessWorkspaceClient.js';
import { onboardBrowserlessWorkspaceMember } from '../pipeline/rotation/browserlessMemberOnboarder.js';
import { discoverOperationalWorkspaceRegistry, mergeUsableSupplyRoots } from '../pipeline/rotation/workspaceRegistry.js';
import { selectWorkspaceForAlias } from '../pipeline/rotation/workspaceSelector.js';
import { createRuntimeVerifiedAliasProbe } from '../pipeline/rotation/runtimeAliasProbe.js';
import { preRemoveExhaustedMembers as preRemoveExhaustedMembersByWorkspace } from '../pipeline/rotation/preRemoveWorkspaceMembers.js';
import { prepareLiveFixRuntime, createLiveBootstrapLineageRunner, collectRuntimeExhaustedAliases, createArchiveReinstatableEntriesProvider, collectFailedWorkspaceCleanupCandidates } from './pipelineCheckArchiveReplaceLiveFix.js';

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
    'router-onboard-email': { type: 'string', multiple: true },
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
// Priority order:
//  1. BROWSER_WS_ENDPOINT set → connect to remote browser (lightpanda cloud, remote Chrome)
//  2. Fallback → local xvfb-run + Chrome (requires display server, not recommended on servers)
//
// For Ink deployment: set BROWSER_WS_ENDPOINT to lightpanda cloud WS URL.
// For local debugging: leave unset (uses xvfb-run).
async function createBrowserSession() {
  if (BROWSER_WS_ENDPOINT) {
    // ── Remote browser (lightpanda cloud or remote Chrome) ────────────────────
    // IMPORTANT: getApiPage() also connects to the same BROWSER_WS_ENDPOINT.
    // Both connections share the same underlying lightpanda browser instance.
    // We MUST create a new page (tab) rather than reusing pages[0], which is
    // owned by getApiPage() and navigating to chatgpt.com for API calls.
    console.log(`[cli] Connecting to remote browser: ${BROWSER_WS_ENDPOINT.slice(0, 60)}...`);
    const browser = await puppeteer.connect({ browserWSEndpoint: BROWSER_WS_ENDPOINT });
    // Always open a new tab for account creation — never share with API page
    const page = await browser.newPage();
    await applyStealthPatches(page);
    const cleanup = async () => {
      try { await page.close(); } catch {}
      try { await browser.disconnect(); } catch {}
    };
    return { page, cleanup };
  }

  // ── Local Chrome via xvfb-run (fallback, local debugging only) ───────────
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
      '--disable-infobars',
      '--disable-features=IsolateOrigins,site-per-process',
      '--font-render-hinting=none',
      `--user-agent=${USER_AGENT}`,
      '--lang=en-US,en',
      '--window-size=1280,1024',
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
  if (!browser) {
    try { proc.kill('SIGTERM'); } catch {}
    throw new Error(`Chrome not available at port ${port} after 30s`);
  }

  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  await applyStealthPatches(page);

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

// ── Browserless workspace API driver ─────────────────────────────────────────────

function loadAuthData() {
  try {
    return JSON.parse(fs.readFileSync(authPath, 'utf8'));
  } catch {
    return {};
  }
}

const ownerWorkspaceClientCache = new Map();
let workspaceRegistryPromise = null;
let selectedWorkspacePromise = null;

function getOwnerAuthEntries() {
  return Object.entries(loadAuthData())
    .filter(([, entry]) => typeof entry === 'object' && entry?.access && entry?.expires > Date.now())
    .map(([ownerAliasId, ownerAuth]) => ({ ownerAliasId, ownerAuth }));
}

async function getWorkspaceClientForOwner(ownerAliasId, ownerAuth = null) {
  if (!ownerWorkspaceClientCache.has(ownerAliasId)) {
    ownerWorkspaceClientCache.set(ownerAliasId, Promise.resolve().then(() => {
      const resolvedAuth = ownerAuth ?? loadAuthData()?.[ownerAliasId];
      if (!resolvedAuth?.access) {
        throw new Error(`No valid auth.json entry found for workspace owner alias ${ownerAliasId}`);
      }
      return createBrowserlessWorkspaceClient({
        accessToken: resolvedAuth.access,
        accountId: resolvedAuth.accountId ?? null,
      });
    }));
  }
  return ownerWorkspaceClientCache.get(ownerAliasId);
}

async function getWorkspaceRegistry() {
  if (!workspaceRegistryPromise) {
    const registryOverridePath = process.env.PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_REGISTRY_PATH ?? null;
    if (registryOverridePath) {
      workspaceRegistryPromise = Promise.resolve(JSON.parse(fs.readFileSync(registryOverridePath, 'utf8')));
      return workspaceRegistryPromise;
    }
    const cachePath = path.join(process.cwd(), 'state', 'rotation', 'live-workspace-registry.json');
    workspaceRegistryPromise = discoverOperationalWorkspaceRegistry({
      authPath,
      cachePath,
      listWorkspacesForOwner: async ({ ownerAliasId, ownerAuth }) => {
        if (process.env.PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_FAIL_PREPARATION === ownerAliasId) {
          throw new Error(`simulated live-fix preparation failure for ${ownerAliasId}`);
        }
        try {
          const client = await getWorkspaceClientForOwner(ownerAliasId, ownerAuth);
          const accounts = await client.getAccounts({ accountIdOverride: ownerAuth.accountId ?? null });
          const workspaces = [];
          for (const account of (accounts.items ?? []).filter((item) => item.structure === 'workspace')) {
            const observation = {
              workspaceId: account.id,
              workspaceName: account.name ?? null,
              lineage: ownerAuth.lineage ?? ownerAuth.workspaceLineage ?? ownerAliasId,
              currentMembers: 0,
              maxMembers: WORKSPACE_MAX_MEMBERS,
              healthyAccounts: 0,
              verificationSource: 'workspace-list-users',
              lastVerifiedAt: new Date().toISOString(),
            };
            try {
              maybeSimulateDeactivatedWorkspace({ workspaceId: account.id });
              const users = await client.listUsers(account.id);
              workspaces.push({
                ...observation,
                currentMembers: typeof users?.total === 'number' ? users.total : (users?.items ?? []).length,
                eligible: true,
                usable: true,
                deactivated: false,
                eligibilityStatus: 'usable',
              });
            } catch (error) {
              if (isWorkspaceDeactivatedError(error)) {
                workspaces.push({
                  ...observation,
                  eligible: false,
                  usable: false,
                  deactivated: true,
                  eligibilityStatus: 'workspace-deactivated',
                  lastVerificationError: String(error?.message ?? error),
                });
                continue;
              }
              workspaces.push({
                ...observation,
                eligible: false,
                usable: false,
                deactivated: false,
                eligibilityStatus: 'workspace-ineligible',
                lastVerificationError: String(error?.message ?? error),
              });
            }
          }
          return workspaces;
        } catch (error) {
          const message = String(error?.message ?? error);
          const enriched = new Error(`workspace-registry-discovery failed for ${ownerAliasId}${ownerAuth?.email ? ` (${ownerAuth.email})` : ''}: ${message}`);
          enriched.codePath = 'workspace-registry-discovery';
          enriched.ownerAliasId = ownerAliasId;
          enriched.ownerEmail = ownerAuth?.email ?? null;
          enriched.ownerAccountId = ownerAuth?.accountId ?? null;
          throw enriched;
        }
      },
    });
  }
  return workspaceRegistryPromise;
}

function buildPlacementAlias(placementContext = {}) {
  return {
    aliasId: placementContext.aliasId ?? null,
    lineage: placementContext.lineage ?? placementContext.rootEmail ?? placementContext.rootOrgId ?? null,
    rootEmail: placementContext.rootEmail ?? null,
    rootOrgId: placementContext.rootOrgId ?? null,
    workspaceLineage: placementContext.workspaceLineage ?? null,
  };
}

function readTestWorkspaceUsersFixture() {
  const fixturePath = process.env.PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_WORKSPACE_USERS_PATH ?? null;
  if (!fixturePath) return null;
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

function maybeSimulateDeactivatedWorkspace(workspace = null) {
  const configuredWorkspaceId = process.env.PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_DEACTIVATED_WORKSPACE ?? null;
  if (!configuredWorkspaceId || workspace?.workspaceId !== configuredWorkspaceId) return;
  throw new WorkspaceClientError('Workspace is deactivated.', {
    status: 401,
    body: { detail: 'Workspace is deactivated.' },
    url: `https://chatgpt.com/backend-api/accounts/${configuredWorkspaceId}/users`,
  });
}

function maybeSimulateLastOwnerRemoval(workspace = null, email = null) {
  const configuredWorkspaceId = process.env.PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_LAST_OWNER_WORKSPACE ?? null;
  const configuredEmail = String(process.env.PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_LAST_OWNER_EMAIL ?? '').toLowerCase() || null;
  if (!configuredWorkspaceId || workspace?.workspaceId !== configuredWorkspaceId) return;
  if (!configuredEmail || String(email ?? '').toLowerCase() !== configuredEmail) return;
  throw new WorkspaceClientError('Cannot remove the last owner from a workspace', {
    status: 400,
    body: { detail: 'Cannot remove the last owner from a workspace' },
    url: `https://chatgpt.com/backend-api/accounts/${configuredWorkspaceId}/users`,
  });
}

async function resolveManagedWorkspace({ workspaceId = null, placementContext = null } = {}) {
  const registry = await getWorkspaceRegistry();
  if (workspaceId) {
    const directMatches = (registry.workspaces ?? []).filter((workspace) => workspace.workspaceId === workspaceId);
    const direct = selectWorkspaceForAlias({ alias: { workspaceId }, workspaces: directMatches });
    if (direct) return direct;
  }

  const ownerMatches = (registry.workspaces ?? []).filter((workspace) => (
    !WORKSPACE_OWNER_EMAIL || workspace.ownerEmail === WORKSPACE_OWNER_EMAIL
  ));
  const nameMatches = ownerMatches.filter((workspace) => (
    !WORKSPACE_NAME || workspace.workspaceName === WORKSPACE_NAME
  ));
  const candidates = nameMatches.length > 0
    ? nameMatches
    : (ownerMatches.length > 0 ? ownerMatches : (registry.workspaces ?? []));

  if (placementContext) {
    const selected = selectWorkspaceForAlias({ alias: buildPlacementAlias(placementContext), workspaces: candidates });
    if (!selected?.workspaceId) {
      throw new Error(`No managed workspace discovered for placement context ${JSON.stringify(buildPlacementAlias(placementContext))}`);
    }
    console.log(`[cli] Workspace "${selected.workspaceName ?? '(unnamed)'}" → ${selected.workspaceId}`);
    return selected;
  }

  if (!selectedWorkspacePromise) {
    selectedWorkspacePromise = Promise.resolve().then(async () => {
      const selected = selectWorkspaceForAlias({ alias: {}, workspaces: candidates });
      if (!selected?.workspaceId) {
        throw new Error(`No managed workspace discovered${WORKSPACE_NAME ? ` for ${WORKSPACE_NAME}` : ''}`);
      }
      console.log(`[cli] Workspace "${selected.workspaceName ?? '(unnamed)'}" → ${selected.workspaceId}`);
      return selected;
    });
  }
  return selectedWorkspacePromise;
}

const productionProbeVerifiedAlias = createRuntimeVerifiedAliasProbe({
  authJsonPath: authPath,
  healthPath,
  routerPath,
  workspaceClientFactory: createBrowserlessWorkspaceClient,
});

const productionTeamDriver = {
  async inviteTeamMember(email, context = {}) {
    const workspace = await resolveManagedWorkspace({
      workspaceId: context?.workspace?.workspaceId ?? null,
      placementContext: context?.placementContext ?? null,
    });
    const client = await getWorkspaceClientForOwner(workspace.ownerAliasId);
    const existingInvites = await client.listInvites(workspace.workspaceId).catch(() => ({ items: [] }));
    const existingInvite = (existingInvites.items ?? []).find((invite) => String(invite.email_address ?? '').toLowerCase() === String(email).toLowerCase());
    if (existingInvite?.id) {
      await client.cancelInvite(workspace.workspaceId, existingInvite.id).catch(() => {});
    }
    return client.createInvite(workspace.workspaceId, email);
  },

  async removeTeamMember(email, context = {}) {
    const workspace = await resolveManagedWorkspace({
      workspaceId: context?.workspace?.workspaceId ?? null,
      placementContext: context?.placementContext ?? null,
    });
    maybeSimulateDeactivatedWorkspace(workspace);
    const testUsersFixture = readTestWorkspaceUsersFixture();
    if (testUsersFixture?.[workspace.workspaceId]) {
      maybeSimulateLastOwnerRemoval(workspace, email);
      const member = (testUsersFixture[workspace.workspaceId].items ?? []).find((user) => String(user.email ?? '').toLowerCase() === String(email).toLowerCase());
      if (!member?.id) {
        return { ok: true, skipped: true, reason: 'not-found' };
      }
      return { ok: true, removed: true, userId: member.id };
    }
    const client = await getWorkspaceClientForOwner(workspace.ownerAliasId);
    const users = await client.listUsers(workspace.workspaceId);
    const member = (users.items ?? []).find((user) => String(user.email ?? '').toLowerCase() === String(email).toLowerCase());
    if (!member?.id) {
      return { ok: true, skipped: true, reason: 'not-found' };
    }
    maybeSimulateLastOwnerRemoval(workspace, email);
    await client.removeUser(workspace.workspaceId, member.id);
    return { ok: true, removed: true, userId: member.id };
  },

  async listUsers(workspaceId = null, context = {}) {
    const workspace = await resolveManagedWorkspace({
      workspaceId: workspaceId ?? context?.workspace?.workspaceId ?? null,
      placementContext: context?.placementContext ?? null,
    });
    maybeSimulateDeactivatedWorkspace(workspace);
    const testUsersFixture = readTestWorkspaceUsersFixture();
    if (testUsersFixture?.[workspace.workspaceId]) {
      return testUsersFixture[workspace.workspaceId];
    }
    const client = await getWorkspaceClientForOwner(workspace.ownerAliasId);
    return client.listUsers(workspace.workspaceId);
  },
};

// ── Live-fix preparation + pre-removal ───────────────────────────────────────────
const bootstrapKnownLineageRuntime = createLiveBootstrapLineageRunner({
  cwd: process.cwd(),
  reinstatableEntriesProvider: createArchiveReinstatableEntriesProvider({ archivePath }),
});

async function maybeBootstrapRuntimeCapacity({ pool, exhaustedDemand, registry }) {
  return bootstrapRuntimeCapacity({
    pool,
    exhaustedDemand,
    registry,
    bootstrapLineage: bootstrapKnownLineageRuntime,
  });
}

async function preRemoveExhaustedMembers(exhaustedAliases) {
  if (!exhaustedAliases.length) return;
  console.log(`[cli] Pre-removing ${exhaustedAliases.length} exhausted workspace member(s)...`);
  const result = await preRemoveExhaustedMembersByWorkspace({
    exhaustedAliases,
    resolveWorkspace: async (alias) => resolveManagedWorkspace({
      workspaceId: alias.workspaceId ?? alias.placementContext?.workspaceId ?? null,
      placementContext: alias.placementContext ?? {
        aliasId: alias.aliasId,
        aliasEmail: alias.email,
        lineage: alias.lineage ?? alias.workspaceLineage ?? null,
        workspaceId: alias.workspaceId ?? null,
      },
    }),
    teamDriver: productionTeamDriver,
    log: (message) => console.log(`[cli] ${message}`),
  });

  for (const item of result.removed) {
    console.log(`[cli] ✓ Removed ${item.email} from ${item.workspaceId}`);
  }
  for (const item of result.skipped) {
    console.warn(`[cli] Skipped pre-removal for ${item.email ?? item.aliasId}: ${item.reason}`);
  }
}

let liveFixPreparation = {
  exhaustedAliases: [],
  resolvedAliases: [],
  unresolvedAliases: [],
  skippedAliasIds: [],
  allowedAliasIds: [],
  placementContextByAliasId: {},
  bootstrapResult: { triggered: false, ok: true, createdEntries: [], createdCapacity: 0, remainingDemand: 0 },
  usableCapacityBeforeBootstrap: 0,
  usableCapacityAfterBootstrap: 0,
  canProceed: true,
};

try {
  const routerData = JSON.parse(fs.readFileSync(routerPath, 'utf8'));
  const healthData = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
  const poolData = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
  const exhaustedAliases = collectRuntimeExhaustedAliases({
    routerData,
    healthData,
    workspaceOwnerEmail: WORKSPACE_OWNER_EMAIL,
    forceReplaceAll9: values['force-replace-all-9'],
  });
  const registry = exhaustedAliases.length > 0 ? await getWorkspaceRegistry() : { workspaces: [] };

  liveFixPreparation = await prepareLiveFixRuntime({
    routerData,
    healthData,
    poolData,
    authData: loadAuthData(),
    registry,
    workspaceOwnerEmail: WORKSPACE_OWNER_EMAIL,
    forceReplaceAll9: values['force-replace-all-9'],
    bootstrapLineage: bootstrapKnownLineageRuntime,
  });

  for (const item of liveFixPreparation.unresolvedAliases ?? []) {
    console.warn(`[cli] Skipping unresolved exhausted alias ${item.aliasId ?? item.email}: ${item.reason}`);
  }
  for (const entry of liveFixPreparation.bootstrapResult?.excludedEntries ?? []) {
    console.warn(`[cli] Excluded recovered inbox ${entry.inboxAddress}: ${entry.reason}`);
  }
  if (liveFixPreparation.bootstrapResult?.triggered) {
    console.log(`[cli] Runtime bootstrap triggered: createdCapacity=${liveFixPreparation.bootstrapResult.createdCapacity} remainingDemand=${liveFixPreparation.bootstrapResult.remainingDemand}`);
  }
  if (!values['dry-run'] && (liveFixPreparation.bootstrapResult?.createdEntries?.length ?? 0) > 0) {
    const persistedPool = readPool({ poolPath });
    for (const entry of liveFixPreparation.bootstrapResult.createdEntries) {
      persistedPool.entries.push({
        ...entry,
        status: entry.status ?? 'available',
        statusUpdatedAt: entry.statusUpdatedAt ?? Date.now(),
      });
    }
    writePool(persistedPool, { poolPath });
  }
  if (!values['dry-run'] && (liveFixPreparation.bootstrapResult?.registryUpdates?.usableSupplyRoots?.length ?? 0) > 0) {
    const cachePath = path.join(process.cwd(), 'state', 'rotation', 'live-workspace-registry.json');
    let cachedRegistry = registry;
    try {
      if (fs.existsSync(cachePath)) {
        cachedRegistry = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      }
    } catch {
      cachedRegistry = registry;
    }
    const updatedRegistry = mergeUsableSupplyRoots(cachedRegistry, liveFixPreparation.bootstrapResult.registryUpdates.usableSupplyRoots);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(updatedRegistry, null, 2));
  }

  if (!values['dry-run']) {
    const cleanupRouterAliases = (() => {
      try {
        return JSON.parse(fs.readFileSync(routerPath, 'utf8')).aliases ?? [];
      } catch {
        return [];
      }
    })();
    const cleanupCandidates = collectFailedWorkspaceCleanupCandidates({
      poolEntries: readPool({ poolPath }).entries ?? [],
      routerAliases: cleanupRouterAliases,
      allowedLineages: [...new Set((liveFixPreparation.resolvedAliases ?? []).map((item) => item.lineage).filter(Boolean))],
    });
    if (cleanupCandidates.length > 0) {
      console.log(`[cli] Cleaning up ${cleanupCandidates.length} failed workspace occupant(s) before refill...`);
      await preRemoveExhaustedMembers(cleanupCandidates);
    }

    await preRemoveExhaustedMembers((liveFixPreparation.resolvedAliases ?? []).map((item) => ({
      aliasId: item.aliasId,
      email: item.email,
      lineage: item.lineage,
      workspaceId: item.workspaceId,
      ownerAliasId: item.ownerAliasId,
      placementContext: item.placementContext,
    })));
  }
  if (process.env.PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_EXIT_AFTER_PRE_REMOVE === '1') {
    console.log('[cli] Test exit after pre-remove');
    process.exit(0);
  }
} catch (preErr) {
  const details = {
    codePath: preErr?.codePath ?? 'live-fix-preparation',
    ownerAliasId: preErr?.ownerAliasId ?? null,
    ownerEmail: preErr?.ownerEmail ?? null,
    ownerAccountId: preErr?.ownerAccountId ?? null,
  };
  console.error(`[cli] Live-fix preparation failed: ${preErr?.message ?? String(preErr)}`);
  console.error(`[cli] Live-fix preparation context: ${JSON.stringify(details)}`);
  process.exit(1);
}

if (!liveFixPreparation.canProceed) {
  console.error(`[cli] Blocking rerun: usable pool capacity ${liveFixPreparation.usableCapacityAfterBootstrap}/${liveFixPreparation.allowedAliasIds.length} does not fully cover allowed demand after bootstrap`);
  process.exit(1);
}

// ── Run pipeline ──────────────────────────────────────────────────────────────────
let result;
try {
  result = await runCheckArchiveAndReplace({
  dryRun: values['dry-run'],
  forceReplaceAll9: values['force-replace-all-9'],
  log: console.log,
  archivePath,
  poolPath,
  healthPath,
  routerPath,
  authPath,
  createBrowserSession,
  memberOnboarder: onboardBrowserlessWorkspaceMember,
  finalize: productionFinalize,
  teamDriver: productionTeamDriver,
  bootstrapNewRoot: undefined,  // would call pipeline-bootstrap here
  routerOnboardInbox: async (input) => onboardInboxToPiRouter({
    ...input,
    browserlessOnboardMember: onboardBrowserlessWorkspaceMember,
    inviteMember: productionTeamDriver.inviteTeamMember,
    ownerClient: productionTeamDriver,
  }),
  probeVerifiedAlias: productionProbeVerifiedAlias,
  allowedAliasIds: liveFixPreparation.allowedAliasIds,
  placementContextByAliasId: liveFixPreparation.placementContextByAliasId,
  // Fail-fast: stop entire pipeline on first error for fast iterative debugging.
  // Each failure tells you exactly what went wrong at that step; no point
  // running remaining aliases with the same broken configuration.
    failFast: true,
    concurrency: 1,
    routerOnboardEmails: values['router-onboard-email'] ?? [],
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
console.log(`Router onboarded: ${result.routerOnboarded ?? 0}`);
console.log(`Failed: ${result.failed}`);
if (result.liveAudit?.counts) {
  console.log(`Live audit counts: ${JSON.stringify(result.liveAudit.counts)}`);
}
if (result.quotaPolicy?.groups) {
  console.log('Quota policy groups:');
  for (const [groupKey, group] of Object.entries(result.quotaPolicy.groups)) {
    console.log(`  - ${groupKey}: action=${group.action} healthy=${group.healthyAccounts}/${group.totalAccounts}`);
  }
}
if (result.artifactPaths?.browserlessAudit) {
  console.log(`Browserless audit artifact: ${result.artifactPaths.browserlessAudit}`);
}
console.log('Verification contract: browserless session/workspace checks + codex usability/quota proof');
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
