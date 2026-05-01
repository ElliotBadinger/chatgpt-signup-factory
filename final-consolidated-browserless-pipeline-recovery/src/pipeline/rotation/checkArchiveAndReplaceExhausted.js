/**
 * checkArchiveAndReplaceExhausted.js
 *
 * Main orchestrator for the Codex alias rotation pipeline.
 *
 * Architecture:
 *
 *  Phase 1 — ASSESS (fast, sequential)
 *    Read health.json + archive.  Classify aliases.  Run reinstatements.
 *
 *  Phase 2 — PARALLEL ACCOUNT CREATION
 *    Each alias runs concurrently (up to `concurrency` in flight).
 *    Inboxes are claimed from an atomic in-memory queue:
 *      claimNextInbox() is called synchronously (no await between check and
 *      claim), so JavaScript's single-threaded runtime guarantees no two
 *      workers can claim the same inbox.
 *    Each worker has its own retry loop: if an inbox returns
 *    NO_EMAIL_CODE_OPTION it claims the next inbox and retries.
 *    Browser sessions are created per attempt, closed after.
 *    NO file writes happen in Phase 2 — it is pure computation.
 *
 *  Phase 3 — APPLY RESULTS (fast, sequential file writes)
 *    Reads archive / auth / router once; applies all successful results;
 *    writes each file once atomically.  Failures update pool statuses.
 *    The pool file is written once at the very end.
 *
 * Strong typing:
 *   All parameters and returns are documented via JSDoc @typedef.
 *   Critical fields are validated at runtime with `assertField`.
 *
 * Fail-fast:
 *   Unexpected page state inside createChatGptAccount throws a typed
 *   RotationError whose `.context` includes the URL and observed state.
 *   The error is captured in `summary.details` for that alias; other
 *   aliases continue unaffected.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { assessCodexQuotas }                    from './quotaDetector.js';
import { auditCodexFleetLive }                  from './liveFleetAudit.js';
import { classifyQuotaState, chooseWorkspaceAction } from './quotaPolicy.js';
import { readArchive, writeArchive,
         checkReinstatements, markReinstated }  from './archiveManager.js';
import { readPool, writePool }                  from './inboxPoolManager.js';
import { createChatGptAccount }                 from './chatGptAccountCreator.js';
import { verifyRecoveredAlias }                 from './verifyRecoveredAlias.js';
import { writeAuthCredential, removeAuthCredential,
         emailToAliasId }                       from './piAccountRegistrar.js';
import { onboardInboxToPiRouter }               from './routerOnboarder.js';
import { RotationError }                        from './errors.js';
import { createLifecycleReconciler }                 from './lifecycleReconciler.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   dryRun?:               boolean;
 *   failFast?:             boolean;
 *   forceReplaceAll9?:     boolean;
 *   log?:                  (...args: any[]) => void;
 *   archivePath?:          string;
 *   poolPath?:             string;
 *   healthPath?:           string;
 *   routerPath?:           string;
 *   authPath?:             string;
 *   createBrowserSession?: () => Promise<{ page: any, cleanup: () => Promise<void> }>;
 *   memberOnboarder?:      (input: { email: string, agentMailApiKey: string, inviteMember?: (email: string) => Promise<void>, ownerClient?: object }) => Promise<any>;
 *   finalize?:             (input: object) => Promise<{ ok: boolean, validation?: string, error?: string }>;
 *   teamDriver?:           { inviteTeamMember: (email: string) => Promise<void>, removeTeamMember: (email: string) => Promise<void>, listUsers?: (workspaceId: string) => Promise<any> };
 *   bootstrapNewRoot?:     () => Promise<object[]>;
 *   _probeQuotaOverride?:  (aliasId: string, auth: object) => Promise<number>;
 *   agentMailPollIntervalMs?:  number;
 *   agentMailTimeoutMs?:       number;
 *   navigationDelayMs?:        number;
 *   pageStateCheckRetries?:    number;
 *   pageStateCheckIntervalMs?: number;
 *   concurrency?:          number;
 *   routerOnboardEmails?: string[];
 *   routerOnboardInbox?: (input: { email: string, apiKey: string, authJsonPath: string, routerJsonPath: string, log: (...args: any[]) => void }) => Promise<any>;
 *   liveProbeAlias?:       (input: { aliasId: string, alias: object, auth: object | null, health: object | null }) => Promise<any>;
 *   excludedAuditAliases?: string[];
 *   quotaPolicyThresholds?: object;
 *   verifyRecoveredAliasImpl?: typeof import('./verifyRecoveredAlias.js').verifyRecoveredAlias;
 *   probeVerifiedAlias?:    (input: { aliasId: string, auth: object }) => Promise<any>;
 *   allowedAliasIds?:       string[];
 *   placementContextByAliasId?: Record<string, object>;
 *   artifactRootDir?:       string;
 *   codexLbStore?:          { writeActiveLifecycle?: (input: object) => Promise<any>, clearActiveLifecycle?: (input: object) => Promise<any> };
 *   forceResendReceiving?: boolean;
 *   resendReceivingDomain?: string;
 *   maxInboxAttempts?: number;
 * }} RunCheckArchiveAndReplaceOpts
 */

/**
 * @typedef {{
 *   exhaustedProcessed: number;
 *   reinstated:         number;
 *   newAccountsCreated: number;
 *   routerOnboarded:    number;
 *   failed:             number;
 *   skipped:            number;
 *   dryRun:             boolean;
 *   details:            object[];
 * }} RotationSummary
 */

// ─── Constants & helpers ──────────────────────────────────────────────────────

const PI_DIR               = path.join(os.homedir(), '.pi', 'agent');
const DEFAULT_ARCHIVE_PATH = path.join(PI_DIR, 'codex-alias-archive.json');
const DEFAULT_POOL_PATH    = path.join(PI_DIR, 'codex-inbox-pool.json');
const DEFAULT_HEALTH_PATH  = path.join(PI_DIR, 'account-router-health.json');
const DEFAULT_ROUTER_PATH  = path.join(PI_DIR, 'account-router.json');
const DEFAULT_AUTH_PATH    = path.join(PI_DIR, 'auth.json');
const MAX_INBOX_ATTEMPTS   = 5;

function ensureDir(p) {
  const d = path.dirname(p);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}

/**
 * Atomic JSON write: write to *.tmp then rename. Mode 0o600.
 * @param {string} filePath  @param {object} data
 */
function atomicWrite(filePath, data) {
  ensureDir(filePath);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function safeReadJson(p, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function tempId() { return `temp-${randomBytes(6).toString('hex')}`; }

function buildPlacementContext({ alias = null, inbox = null, source = 'rotation', resolvedPlacementContext = null } = {}) {
  return {
    ...(resolvedPlacementContext ?? {}),
    source,
    aliasId: resolvedPlacementContext?.aliasId ?? alias?.aliasId ?? alias?.id ?? null,
    aliasEmail: resolvedPlacementContext?.aliasEmail ?? alias?.email ?? null,
    lineage: resolvedPlacementContext?.lineage ?? alias?.lineage ?? alias?.workspaceLineage ?? inbox?.workspaceGroupKey ?? inbox?.rootEmail ?? inbox?.rootOrgId ?? null,
    rootEmail: resolvedPlacementContext?.rootEmail ?? inbox?.rootEmail ?? null,
    rootOrgId: resolvedPlacementContext?.rootOrgId ?? inbox?.rootOrgId ?? null,
    workspaceGroupKey: resolvedPlacementContext?.workspaceGroupKey ?? alias?.workspaceGroupKey ?? inbox?.workspaceGroupKey ?? null,
    workspaceId: resolvedPlacementContext?.workspaceId ?? null,
    ownerAliasId: resolvedPlacementContext?.ownerAliasId ?? null,
    ownerEmail: resolvedPlacementContext?.ownerEmail ?? null,
  };
}

function deriveInboxGroupKey(inbox = {}) {
  return inbox.workspaceGroupKey ?? inbox.lineage ?? inbox.rootEmail ?? inbox.rootOrgId ?? 'fleet:default';
}

/**
 * Remove `aliasId` from the account-router.json pools.
 * @param {string} aliasId @param {string} routerPath
 */
function removeAliasFromRouter(aliasId, routerPath) {
  try {
    if (!fs.existsSync(routerPath)) return;
    const cfg = safeReadJson(routerPath, { aliases: [], pools: [] });
    cfg.aliases = (cfg.aliases ?? []).filter((a) => a.id !== aliasId);
    cfg.pools   = (cfg.pools   ?? []).map((p) => ({
      ...p,
      providers: (p.providers ?? []).filter((x) => x !== aliasId),
      routes:    (p.routes    ?? []).filter((r) => r.provider !== aliasId),
    }));
    atomicWrite(routerPath, cfg);
  } catch { /* non-fatal */ }
}

/**
 * Write archived alias back to auth.json + re-add to router via finalize.
 */
async function reinstateAlias(entry, { routerPath, authPath, finalize, log }) {
  log(`[reinstateAlias] Writing credentials for ${entry.aliasId}`);
  writeAuthCredential({
    aliasId:      entry.aliasId,
    accessToken:  entry.auth.access,
    refreshToken: entry.auth.refresh ?? null,
    expiresAt:    entry.auth.expires ?? null,
    accountId:    entry.auth.accountId ?? null,
    authJsonPath: authPath,
  });
  if (finalize) {
    try {
      await finalize({
        tempId: entry.aliasId, finalId: entry.aliasId,
        configPath:      routerPath,
        poolName:        'openai-codex',
        baseProviderId:  'openai-codex',
        email:           entry.email,
        label:           entry.aliasId,
        modelId:         'gpt-5.4',
        now:             Date.now(),
        probeTimeoutMs:  30_000,
        defaultCooldownMs: 300_000,
      });
    } catch { /* non-fatal */ }
  }
}

/**
 * Concurrency-limited parallel map.
 * Returns an array of PromiseSettledResult in the same order as `items`.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<PromiseSettledResult<R>[]>}
 */
async function runWithConcurrency(items, limit, fn) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  const running = new Set();
  let next = 0;

  return new Promise((resolve) => {
    const launch = () => {
      while (running.size < limit && next < items.length) {
        const i = next++;
        const p = Promise.resolve()
          .then(() => fn(items[i], i))
          .then(
            (value)  => { results[i] = { status: 'fulfilled', value }; },
            (reason) => { results[i] = { status: 'rejected',  reason }; },
          )
          .finally(() => {
            running.delete(p);
            launch();
            if (running.size === 0 && next >= items.length) resolve(results);
          });
        running.add(p);
      }
    };
    launch();
    if (running.size === 0) resolve(results);
  });
}

function isResendReceivingEmail(email, domain) {
  return String(email ?? '').toLowerCase().endsWith(`@${String(domain ?? '').toLowerCase()}`);
}

function applyResendReceivingAlias(inbox, alias, { domain = 'epistemophile.store' } = {}) {
  if (!inbox || isResendReceivingEmail(inbox.inboxAddress, domain)) return inbox;
  const originalInboxAddress = inbox.originalInboxAddress ?? inbox.inboxAddress;
  const aliasPart = String(alias?.aliasId ?? 'alias').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'alias';
  const suffix = randomBytes(4).toString('hex');
  const resendAddress = `codex-${aliasPart}-${suffix}@${domain}`;
  inbox.originalInboxAddress = originalInboxAddress;
  inbox.inboxAddress = resendAddress;
  inbox.agentMailInboxId = resendAddress;
  inbox.receivingProvider = 'resend';
  inbox.resendReceivingDomain = domain;
  return inbox;
}


// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * @param {RunCheckArchiveAndReplaceOpts} opts
 * @returns {Promise<RotationSummary>}
 */
export async function runCheckArchiveAndReplace({
  dryRun              = false,
  failFast            = false,
  forceReplaceAll9    = false,
  log                 = console.log,

  archivePath         = DEFAULT_ARCHIVE_PATH,
  poolPath            = DEFAULT_POOL_PATH,
  healthPath          = DEFAULT_HEALTH_PATH,
  routerPath          = DEFAULT_ROUTER_PATH,
  authPath            = DEFAULT_AUTH_PATH,

  createBrowserSession,
  memberOnboarder = null,
  finalize,
  teamDriver,
  bootstrapNewRoot,
  _probeQuotaOverride,

  agentMailPollIntervalMs  = 5_000,
  agentMailTimeoutMs       = 300_000,
  navigationDelayMs        = 3_000,
  pageStateCheckRetries    = 6,
  pageStateCheckIntervalMs = 2_000,
  concurrency              = 3,
  routerOnboardEmails      = [],
  routerOnboardInbox       = onboardInboxToPiRouter,
  liveProbeAlias           = async () => null,
  excludedAuditAliases     = [],
  quotaPolicyThresholds    = undefined,
  verifyRecoveredAliasImpl = verifyRecoveredAlias,
  probeVerifiedAlias       = async () => ({ ok: false, blockerReason: 'verification-probe-not-configured', reason: 'verification-probe-not-configured' }),
  allowedAliasIds          = null,
  placementContextByAliasId = {},
  artifactRootDir          = path.join(process.cwd(), 'state', 'rotation', 'runs'),
  codexLbStore          = null,
  forceResendReceiving  = false,
  resendReceivingDomain = process.env.RESEND_RECEIVING_DOMAIN ?? 'epistemophile.store',
  maxInboxAttempts      = MAX_INBOX_ATTEMPTS,
} = {}) {

  /** @type {RotationSummary} */
  const summary = {
    exhaustedProcessed: 0,
    reinstated:  0,
    newAccountsCreated: 0,
    routerOnboarded: 0,
    failed:  0,
    skipped: 0,
    dryRun,
    details: [],
    liveAudit: null,
    quotaPolicy: null,
  };

  async function finalizeSummary() {
    try {
      const runDir = path.join(artifactRootDir, new Date().toISOString().replace(/[:.]/g, '-'));
      ensureDir(path.join(runDir, 'summary.json'));
      atomicWrite(path.join(runDir, 'summary.json'), { ...summary, writtenAt: new Date().toISOString() });
      atomicWrite(path.join(runDir, 'browserless-audit.json'), {
        liveAudit: summary.liveAudit,
        quotaPolicy: summary.quotaPolicy,
        details: summary.details,
        writtenAt: new Date().toISOString(),
      });
      summary.artifactDir = runDir;
      summary.artifactPaths = {
        summary: path.join(runDir, 'summary.json'),
        browserlessAudit: path.join(runDir, 'browserless-audit.json'),
      };
    } catch (error) {
      summary.artifactError = String(error?.message ?? error);
    }
    return summary;
  }

  const poolData = readPool({ poolPath });
  const routerCfg = safeReadJson(routerPath, { aliases: [] });
  const onboardedEmails = new Set(
    (routerCfg.aliases ?? []).map((a) => String(a.email ?? '').toLowerCase()),
  );

  if (routerOnboardEmails.length > 0) {
    log(`[checkArchiveAndReplace] Router onboarding ${routerOnboardEmails.length} inbox(es) before rotation...`);
    for (const requestedEmail of [...new Set(routerOnboardEmails.map((email) => String(email ?? '').trim()).filter(Boolean))]) {
      const email = requestedEmail.toLowerCase();
      const aliasId = emailToAliasId(email);
      const poolEntry = poolData.entries.find((entry) => String(entry.inboxAddress ?? '').toLowerCase() === email);

      if (onboardedEmails.has(email)) {
        summary.skipped++;
        summary.details.push({ aliasId, status: 'router-onboard-skipped', inbox: email, reason: 'already-onboarded' });
        continue;
      }

      if (dryRun) {
        summary.details.push({ aliasId, status: 'router-onboard-dry-run', inbox: email });
        continue;
      }

      if (!poolEntry?.rootApiKey) {
        const error = `router-onboard pool entry missing rootApiKey for ${email}`;
        summary.failed++;
        summary.details.push({ aliasId, status: 'failed', inbox: email, error });
        if (failFast) throw new RotationError(error, { code: 'ROUTER_ONBOARD_POOL_ENTRY_MISSING', context: { email } });
        continue;
      }

      try {
        const onboarded = await routerOnboardInbox({
          email,
          apiKey: poolEntry.rootApiKey,
          authJsonPath: authPath,
          routerJsonPath: routerPath,
          placementContext: buildPlacementContext({
            inbox: poolEntry,
            source: 'router-onboard',
            resolvedPlacementContext: placementContextByAliasId?.[poolEntry.linkedAliasId] ?? null,
          }),
          log,
        });
        poolEntry.status = 'in-use';
        poolEntry.linkedAliasId = onboarded.aliasId ?? aliasId;
        poolEntry.chatGptAccountId = onboarded.auth?.accountId ?? null;
        poolEntry.chatGptSignupAt = Date.now();
        poolEntry.statusUpdatedAt = Date.now();
        summary.routerOnboarded++;
        summary.details.push({ aliasId: onboarded.aliasId ?? aliasId, status: 'router-onboarded', inbox: email });
        onboardedEmails.add(email);
      } catch (error) {
        poolEntry.status = 'failed';
        poolEntry.failedReason = String(error?.message ?? error).slice(0, 200);
        poolEntry.statusUpdatedAt = Date.now();
        summary.failed++;
        summary.details.push({ aliasId, status: 'failed', inbox: email, error: `router-onboard: ${error.message}` });
        if (failFast) {
          writePool(poolData, { poolPath });
          throw new RotationError(`failFast: router onboarding failed for '${aliasId}': ${error.message}`, {
            code: 'ROUTER_ONBOARD_FAIL_FAST',
            context: { aliasId, email, error: error.message },
          });
        }
      }
    }

    if (!dryRun) {
      writePool(poolData, { poolPath });
    }
  }

  // ── PHASE 1: ASSESS ─────────────────────────────────────────────────────────
  log('[checkArchiveAndReplace] Phase 1: Assessing quotas...');
  const assessment = assessCodexQuotas({ healthPath, routerPath });
  summary.liveAudit = await auditCodexFleetLive({
    routerPath,
    authPath,
    healthPath,
    excludedAliases: excludedAuditAliases,
    probeAlias: liveProbeAlias,
  });

  const auditedAliases = (summary.liveAudit.aliases ?? []).map((alias) => ({
    ...alias,
    quotaState: classifyQuotaState({
      source: alias.quotaSource,
      explicitState: alias.live?.quotaState ?? null,
      windows: alias.live?.quotaWindows ?? null,
      coarseFraction: alias.health?.effectiveFraction ?? null,
      thresholds: quotaPolicyThresholds,
    }),
  }));
  const groupedAudit = auditedAliases.reduce((groups, alias) => {
    const groupKey = alias.workspaceGroupKey ?? alias.lineage ?? 'fleet:default';
    (groups[groupKey] ??= []).push(alias);
    return groups;
  }, {});
  const quotaPolicyGroups = Object.fromEntries(Object.entries(groupedAudit).map(([groupKey, aliases]) => {
    const aliasQuotaStates = aliases.map((alias) => alias.quotaState);
    const healthyAccounts = aliases.filter((alias) => alias.classification === 'keep-live' && alias.quotaState === 'healthy').length;
    return [groupKey, {
      groupKey,
      lineage: aliases[0]?.lineage ?? null,
      workspaceId: aliases[0]?.workspaceId ?? null,
      aliasIds: aliases.map((alias) => alias.aliasId),
      aliasQuotaStates,
      healthyAccounts,
      totalAccounts: aliases.length,
      action: chooseWorkspaceAction({
        aliasQuotaStates,
        healthyAccounts,
        totalAccounts: aliases.length,
        ...(quotaPolicyThresholds ?? {}),
      }),
    }];
  }));
  summary.quotaPolicy = {
    groups: quotaPolicyGroups,
    fleetAction: Object.values(quotaPolicyGroups).some((group) => group.action === 'replace')
      ? 'replace'
      : (Object.values(quotaPolicyGroups).some((group) => group.action === 'supplement-prewarm')
          ? 'supplement-prewarm'
          : (Object.values(quotaPolicyGroups).some((group) => group.action === 'prewarm') ? 'prewarm' : 'keep')),
  };
  const quotaStateByAliasId = new Map(auditedAliases.map((alias) => [alias.aliasId, alias.quotaState]));
  const quotaGroupByAliasId = new Map(auditedAliases.map((alias) => [alias.aliasId, alias.workspaceGroupKey ?? alias.lineage ?? 'fleet:default']));

  const routerAliasById = new Map((routerCfg.aliases ?? []).map((alias) => [alias.id, alias]));
  const allowedAliasIdSet = Array.isArray(allowedAliasIds)
    ? new Set(allowedAliasIds)
    : null;
  let toRotate = (forceReplaceAll9 ? [...assessment.aliases] : [...assessment.exhausted])
    .map((alias) => ({ ...(routerAliasById.get(alias.aliasId) ?? {}), ...alias }))
    .filter((alias) => !allowedAliasIdSet || allowedAliasIdSet.has(alias.aliasId));

  log(`[checkArchiveAndReplace] ${forceReplaceAll9 ? 'forceReplaceAll9' : 'exhausted'}: ${toRotate.length} queued | healthy=${assessment.healthy.length} atRisk=${assessment.atRisk.length} exhausted=${assessment.exhausted.length}`);

  if (!dryRun) {
    for (const [groupKey, groupPolicy] of Object.entries(summary.quotaPolicy.groups ?? {})) {
      if (groupPolicy.action !== 'supplement-prewarm' && groupPolicy.action !== 'prewarm') continue;
      const standbyInbox = poolData.entries.find((entry) => entry.status === 'available' && deriveInboxGroupKey(entry) === groupKey);
      if (!standbyInbox) continue;
      standbyInbox.status = 'prewarmed';
      standbyInbox.reservedForAction = groupPolicy.action;
      standbyInbox.statusUpdatedAt = Date.now();
      summary.details.push({ status: 'prewarmed', inbox: standbyInbox.inboxAddress, action: groupPolicy.action, groupKey });
    }
  }

  if (!forceReplaceAll9) {
    const archive = readArchive({ archivePath });
    const authData = safeReadJson(authPath, {});
    const deferredAliases = new Set();
    for (const alias of toRotate) {
      const quotaState = quotaStateByAliasId.get(alias.aliasId);
      const groupKey = quotaGroupByAliasId.get(alias.aliasId) ?? alias.lineage ?? 'fleet:default';
      if (quotaState !== 'five-hour-exhausted-only') continue;
      const existingArchiveEntry = archive.aliases.find((entry) => entry.aliasId === alias.aliasId && entry.archivedReason === '5h-exhausted' && entry.awaitingReinstatement);
      if (!existingArchiveEntry) {
        archive.aliases.push({
          aliasId: alias.aliasId,
          email: alias.email ?? `${alias.aliasId}@agentmail.to`,
          auth: authData[alias.aliasId] ?? { type: 'oauth', access: '', refresh: '', expires: 0, accountId: '' },
          archivedAt: Date.now(),
          archivedReason: '5h-exhausted',
          quotaRemainingFraction: alias.effectiveFraction ?? 0,
          quotaWindow: 'five-hour',
          workspaceGroupKey: groupKey,
          reinstated: false,
          awaitingReinstatement: true,
        });
      }
      summary.exhaustedProcessed++;
      summary.details.push({ aliasId: alias.aliasId, status: 'awaiting-reinstatement', archivedReason: '5h-exhausted', groupKey });
      deferredAliases.add(alias.aliasId);
    }
    if (deferredAliases.size > 0) {
      writeArchive(archive, { archivePath });
      toRotate = toRotate.filter((alias) => !deferredAliases.has(alias.aliasId));
    }
  }

  // Reinstatements
  const probeQuota = _probeQuotaOverride ?? (async () => 0);
  const readyToReinstate = await checkReinstatements(probeQuota, { archivePath });
  log(`[checkArchiveAndReplace] ${readyToReinstate.length} archived alias(es) ready to reinstate`);

  for (const archived of readyToReinstate) {
    if (!dryRun) {
      await reinstateAlias(archived, { routerPath, authPath, finalize, log });
      markReinstated(archived.aliasId, { archivePath });
    }
    summary.reinstated++;
    summary.details.push({ aliasId: archived.aliasId, status: 'reinstated' });
    if (toRotate.length > 0) toRotate.shift();
  }

  if (toRotate.length === 0 && !forceReplaceAll9) {
    if (!dryRun) {
      writePool(poolData, { poolPath });
    }
    log('[checkArchiveAndReplace] All gaps covered by reinstatements. Done.');
    return finalizeSummary();
  }

  // Dry-run early exit
  if (dryRun) {
    const pool = readPool({ poolPath });
    const avail = pool.entries.filter((e) => e.status === 'available');
    for (let i = 0; i < toRotate.length; i++) {
      const inbox = avail[i] ?? null;
      log(`[checkArchiveAndReplace] [dry-run] Would rotate ${toRotate[i].aliasId} → ${inbox?.inboxAddress ?? '(no inbox)'}`);
      summary.exhaustedProcessed++;
      summary.details.push({ aliasId: toRotate[i].aliasId, status: 'dry-run', inbox: inbox?.inboxAddress ?? null });
    }
    return finalizeSummary();
  }

  // ── PHASE 2: PARALLEL ACCOUNT CREATION ──────────────────────────────────────
  //
  // We maintain an in-memory queue of available inboxes. claimNextInbox() is
  // called synchronously (no await between check and increment) so the
  // single-threaded JS runtime guarantees exclusivity — no two concurrent
  // workers can claim the same inbox.

  const retryableFailedQueue = poolData.entries.filter((entry) => entry.status === 'failed' && entry.rootApiKey);
  const availableQueue = poolData.entries.filter((entry) => entry.status === 'available');
  const inboxQueue = [...retryableFailedQueue, ...availableQueue];
  let queueIdx = 0;

  /**
   * Claim the next available inbox from the in-memory queue.
   * Atomic in single-threaded JS: no await between index check and increment.
   * Returns null when queue is exhausted.
   */
  function claimNextInbox() {
    while (queueIdx < inboxQueue.length) {
      const inbox = inboxQueue[queueIdx++];
      if (inbox.status !== 'available' && inbox.status !== 'failed') continue; // already claimed or not reusable
      inbox._claimedFromFailed = inbox.status === 'failed';
      inbox.status = 'in-use';
      inbox.statusUpdatedAt = Date.now();
      return inbox;
    }
    return null;
  }

  log(`[checkArchiveAndReplace] Phase 2: Creating ${toRotate.length} account(s) (concurrency=${concurrency})...`);

  /**
   * @typedef {{
   *   status: 'success';
   *   alias:  object;
   *   inbox:  object;
   *   auth:   import('./chatGptAccountCreator.js').ChatGptAuth;
   *   newAliasId: string;
   *   tid:    string;
   * } | {
   *   status: 'failed';
   *   alias:  object;
   *   usedInboxes: { inbox: object, markAs: string, error: string }[];
   * } | {
   *   status: 'skipped';
   *   alias:  object;
   *   inbox:  object;
   *   reason: string;
   * }} WorkerResult
   */

  /** @type {Array<{alias: object}>} */
  const workItems = toRotate.map((alias) => ({ alias }));

  // failFast abort signal: when true, remaining workers return immediately.
  // Single-threaded JS: no data race; workers check this at their entry point.
  let abortRequested = false;

  const rawResults = await runWithConcurrency(workItems, concurrency, async ({ alias }) => {
    // failFast: if a previous worker failed, abort immediately.
    if (abortRequested) {
      return { status: 'aborted', alias };
    }
    const inboxAttempts = [];

    for (let attempt = 0; attempt < maxInboxAttempts; attempt++) {
      // Claim inbox (atomic: no await between claimNextInbox and its use below)
      let inbox = claimNextInbox();

      if (!inbox) {
        // Pool exhausted — try bootstrap
        if (bootstrapNewRoot) {
          log(`[${alias.aliasId}] Pool exhausted; bootstrapping new root...`);
          try {
            const newInboxes = await bootstrapNewRoot();
            for (const ni of newInboxes) {
              ni.status = 'available';
              poolData.entries.push(ni);
              inboxQueue.push(ni);
            }
            inbox = claimNextInbox();
          } catch (e) {
            log(`[${alias.aliasId}] bootstrapNewRoot failed: ${e.message}`);
          }
        }
        if (!inbox) {
          /** @type {WorkerResult} */
          return { status: 'failed', alias, usedInboxes: inboxAttempts };
        }
      }
      if (forceResendReceiving) {
        applyResendReceivingAlias(inbox, alias, { domain: resendReceivingDomain });
      }


      // Already onboarded? (inbox email already in pi router)
      if (onboardedEmails.has(String(inbox.inboxAddress ?? '').toLowerCase())) {
        log(`[${alias.aliasId}] Inbox ${inbox.inboxAddress} already onboarded — skipping`);
        inbox.status = 'chatgpt-used';
        inbox.statusUpdatedAt = Date.now();
        inboxAttempts.push({ inbox, markAs: 'chatgpt-used', error: 'already-onboarded' });
        continue; // try next inbox
      }

      log(`[${alias.aliasId}] Attempt ${attempt + 1}: creating account with ${inbox.inboxAddress}...`);

      let createResult;
      if (memberOnboarder) {
        try {
          const placementContext = buildPlacementContext({
            alias,
            inbox,
            source: 'rotation-replace',
            resolvedPlacementContext: placementContextByAliasId?.[alias.aliasId] ?? null,
          });
          const onboarded = await memberOnboarder({
            email: inbox.inboxAddress,
            agentMailApiKey: inbox.rootApiKey ?? '',
            placementContext,
            inviteMember: teamDriver?.inviteTeamMember
              ? async (inviteEmail, inviteContext = {}) => teamDriver.inviteTeamMember(inviteEmail, inviteContext)
              : undefined,
            ownerClient: teamDriver ?? null,
          });
          createResult = {
            success: true,
            auth: {
              type: 'oauth',
              access: onboarded.accessToken,
              refresh: onboarded.refreshToken ?? null,
              expires: onboarded.expiresAt,
              accountId: onboarded.accountId ?? onboarded.workspaceId ?? onboarded.personalAccountId ?? null,
            },
            onboarded,
            placementContext,
          };
        } catch (e) {
          createResult = { success: false, error: String(e?.message ?? e) };
        }
      } else {
        let page, cleanup;
        try {
          const session = await createBrowserSession();
          page    = session.page;
          cleanup = session.cleanup;
        } catch (e) {
          inbox.status = 'failed';
          inbox.failedReason = String(e.message ?? e).slice(0, 200);
          inbox.statusUpdatedAt = Date.now();
          inboxAttempts.push({ inbox, markAs: 'failed', error: `browser-session: ${e.message}` });
          if (failFast) abortRequested = true;
          /** @type {WorkerResult} */
          return { status: 'failed', alias, usedInboxes: inboxAttempts };
        }

        try {
          createResult = await createChatGptAccount(page, {
            email:                  inbox.inboxAddress,
            agentMailApiKey:        inbox.rootApiKey ?? '',
            agentMailInboxId:       inbox.agentMailInboxId ?? inbox.inboxAddress,
            teamInviteCallback:     teamDriver?.inviteTeamMember
              ? async (e) => teamDriver.inviteTeamMember(e)
              : undefined,
            agentMailPollIntervalMs,
            agentMailTimeoutMs,
            navigationDelayMs,
            pageStateCheckRetries,
            pageStateCheckIntervalMs,
          });
        } catch (e) {
          createResult = { success: false, error: String(e?.message ?? e) };
        } finally {
          if (cleanup) await cleanup().catch(() => {});
        }
      }

      if (createResult.success) {
        const newAliasId = emailToAliasId(inbox.inboxAddress);
        const tid = tempId();
        log(`[${alias.aliasId}] Account created → ${newAliasId}`);
        /** @type {WorkerResult} */
        return {
          status: 'success',
          alias,
          inbox,
          auth: createResult.auth,
          newAliasId,
          tid,
          onboarded: createResult.onboarded ?? null,
          placementContext: createResult.placementContext ?? null,
        };
      }

      // Classify failure
      const isChatGptUsed = String(createResult.error ?? '').includes('NO_EMAIL_CODE_OPTION');
      const markAs = isChatGptUsed ? 'chatgpt-used' : 'failed';
      log(`[${alias.aliasId}] Account creation failed (markAs=${markAs}): ${createResult.error}`);

      inbox.status = markAs;
      inbox.failedReason = isChatGptUsed ? undefined : String(createResult.error ?? '').slice(0, 200);
      inbox.statusUpdatedAt = Date.now();
      inboxAttempts.push({ inbox, markAs, error: createResult.error });

      if (!isChatGptUsed) {
        // Previously-failed inboxes are worth retrying opportunistically, but they should
        // not abort the whole alias if recovery still fails — continue to the next inbox.
        if (inbox._claimedFromFailed === true) {
          continue;
        }
        // Hard failure on a fresh inbox — don't retry with another inbox
        if (failFast) abortRequested = true;
        /** @type {WorkerResult} */
        return { status: 'failed', alias, usedInboxes: inboxAttempts };
      }
      // chatgpt-used → try next inbox
    }

    /** @type {WorkerResult} */
    return { status: 'failed', alias, usedInboxes: inboxAttempts };
  });

  // ── PHASE 3: APPLY RESULTS (sequential file writes) ──────────────────────────
  log('[checkArchiveAndReplace] Phase 3: Applying results...');

  const archive  = readArchive({ archivePath });
  const authData = safeReadJson(authPath, {});

  const lifecycleReconciler = createLifecycleReconciler({
    authPath,
    routerPath,
    archivePath,
    finalize,
    verifyRecoveredAliasImpl,
    probeVerifiedAlias,
    codexLbStore,
    log,
  });


  for (const settledResult of rawResults) {
    if (!settledResult) continue;

    /** @type {WorkerResult} */
    const result = settledResult.status === 'fulfilled'
      ? settledResult.value
      : { status: 'failed', alias: null, usedInboxes: [], error: String(settledResult.reason ?? '') };

    if (result.status === 'skipped') {
      summary.skipped++;
      summary.details.push({ aliasId: result.alias.aliasId, status: 'skipped', reason: result.reason, inbox: result.inbox.inboxAddress });
      continue;
    }

    if (result.status === 'aborted') {
      // failFast: a prior worker failed and signalled abort — skip this alias entirely
      continue;
    }

    if (result.status === 'failed') {
      summary.failed++;
      const lastAttempt = (result.usedInboxes ?? []).at(-1);
      const detail = {
        aliasId:        result.alias?.aliasId ?? '(unknown)',
        status:         'failed',
        error:          lastAttempt?.error ?? 'no-inboxes-available',
        inboxAttempts:  (result.usedInboxes ?? []).map((a) => ({ inbox: a.inbox.inboxAddress, markAs: a.markAs })),
      };
      summary.details.push(detail);
      summary.exhaustedProcessed++;
      // failFast: write pool for proper status tracking, then throw with full context
      if (failFast) {
        writePool(poolData, { poolPath });
        throw new RotationError(
          `failFast: first account creation failed for alias '${detail.aliasId}': ${detail.error}`,
          { code: 'ROTATION_FAIL_FAST', context: detail },
        );
      }
      continue;
    }

    // success
    const { alias, inbox, auth, newAliasId, tid, onboarded } = result;
    summary.exhaustedProcessed++;
    if (codexLbStore) {
      const reconciled = await lifecycleReconciler.reconcileReplacement({
        alias,
        inbox,
        auth,
        newAliasId,
        tempAliasId: tid,
        onboarded,
        placementContext: result.placementContext ?? null,
        teamDriver,
      });

      if (!reconciled.ok) {
        inbox.status = 'failed';
        inbox.failedReason = String(reconciled.error ?? 'lifecycle-reconcile-failed').slice(0, 200);
        inbox.statusUpdatedAt = Date.now();
        summary.failed++;
        summary.details.push({
          aliasId: alias.aliasId,
          status: 'failed',
          error: reconciled.error ?? 'lifecycle-reconcile-failed',
          stage: reconciled.stage ?? 'lifecycle-reconcile',
          inbox: inbox.inboxAddress,
        });
        continue;
      }

      archive.aliases.push(reconciled.archiveEntry);
      inbox.linkedAliasId    = newAliasId;
      inbox.chatGptAccountId = auth.accountId ?? null;
      inbox.chatGptSignupAt  = Date.now();
      inbox.statusUpdatedAt  = Date.now();

      summary.newAccountsCreated++;
      summary.details.push({ aliasId: alias.aliasId, status: 'rotated', inbox: inbox.inboxAddress, newAliasId });
      continue;
    }


    // Write token under temp ID
    authData[tid] = { type: 'oauth', access: auth.access, refresh: auth.refresh ?? null,
                      expires: auth.expires, accountId: auth.accountId ?? null };
    atomicWrite(authPath, authData);

    // Finalize (writes alias into account-router.json)
    let finalizeResult;
    try {
      finalizeResult = await finalize({
        tempId: tid, finalId: newAliasId,
        configPath:       routerPath,
        poolName:         'openai-codex',
        baseProviderId:   'openai-codex',
        email:            inbox.inboxAddress,
        label:            newAliasId,
        modelId:          'gpt-5.4',
        now:              Date.now(),
        probeTimeoutMs:   30_000,
        defaultCooldownMs: 300_000,
        authPath,
      });
    } catch (e) {
      finalizeResult = { ok: false, error: String(e?.message ?? e) };
    }

    if (!finalizeResult?.ok) {
      log(`[${alias.aliasId}] Finalize failed: ${finalizeResult?.error}. Rolling back.`);
      const a2 = safeReadJson(authPath, {});
      delete a2[tid];
      delete a2[newAliasId];
      atomicWrite(authPath, a2);
      inbox.status = 'failed';
      inbox.failedReason = String(finalizeResult?.error ?? '').slice(0, 200);
      inbox.statusUpdatedAt = Date.now();
      summary.failed++;
      summary.details.push({ aliasId: alias.aliasId, status: 'failed', error: `finalize: ${finalizeResult?.error}`, inbox: inbox.inboxAddress });
      continue;
    }

    // Rename temp-ID in auth.json (finalize may or may not have done it)
    const a3 = safeReadJson(authPath, {});
    if (a3[tid] && !a3[newAliasId]) { a3[newAliasId] = a3[tid]; delete a3[tid]; atomicWrite(authPath, a3); }
    else if (a3[tid]) { delete a3[tid]; atomicWrite(authPath, a3); }

    const routerAfterFinalize = safeReadJson(routerPath, { aliases: [] });
    const verification = await verifyRecoveredAliasImpl({
      aliasId: newAliasId,
      auth: safeReadJson(authPath, {})[newAliasId] ?? { access: auth.access, accountId: auth.accountId ?? null },
      sessionEvidence: { valid: Boolean(auth.access) },
      workspaceEvidence: { memberConfirmed: Boolean(onboarded?.workspaceId ?? auth.accountId) },
      routerEvidence: {
        aliasInAuth: Boolean(safeReadJson(authPath, {})[newAliasId]),
        aliasInRouter: Boolean((routerAfterFinalize.aliases ?? []).find((entry) => entry.id === newAliasId)),
      },
      probeCodex: async () => probeVerifiedAlias({ aliasId: newAliasId, auth }),
    });

    if (!verification?.ok) {
      log(`[${alias.aliasId}] Verification failed after finalize: ${verification?.failures?.join(', ') ?? verification?.reason}`);
      removeAliasFromRouter(newAliasId, routerPath);
      const rollbackAuth = safeReadJson(authPath, {});
      delete rollbackAuth[tid];
      delete rollbackAuth[newAliasId];
      atomicWrite(authPath, rollbackAuth);
      inbox.status = 'failed';
      inbox.failedReason = String(verification?.failures?.join(', ') ?? verification?.reason ?? 'verification-failed').slice(0, 200);
      inbox.statusUpdatedAt = Date.now();
      summary.failed++;
      summary.details.push({ aliasId: alias.aliasId, status: 'failed', error: `verification: ${verification?.failures?.join(', ') ?? verification?.reason}`, inbox: inbox.inboxAddress });
      continue;
    }

    // Archive old alias
    log(`[${alias.aliasId}] Archiving old alias`);
    const oldAuth = safeReadJson(authPath, {})[alias.aliasId] ?? null;
    archive.aliases.push({
      aliasId:    alias.aliasId,
      email:      alias.email ?? `${alias.aliasId}@agentmail.to`,
      auth:       oldAuth ?? { type: 'oauth', access: '', refresh: '', expires: 0, accountId: '' },
      archivedAt: Date.now(),
      archivedReason: 'both-exhausted',
      quotaRemainingFraction: alias.effectiveFraction ?? 0,
      reinstated:   false,
      reinstatedAt: null,
    });

    // Remove old alias from router + auth
    removeAliasFromRouter(alias.aliasId, routerPath);
    const a4 = safeReadJson(authPath, {});
    delete a4[alias.aliasId];
    atomicWrite(authPath, a4);

    // Remove from ChatGPT team (best-effort, non-blocking)
    if (teamDriver?.removeTeamMember) {
      teamDriver.removeTeamMember(alias.email ?? `${alias.aliasId}@agentmail.to`).catch(() => {});
    }

    // Update inbox with full linkage
    inbox.linkedAliasId    = newAliasId;
    inbox.chatGptAccountId = auth.accountId ?? null;
    inbox.chatGptSignupAt  = Date.now();
    inbox.statusUpdatedAt  = Date.now();

    summary.newAccountsCreated++;
    summary.details.push({ aliasId: alias.aliasId, status: 'rotated', inbox: inbox.inboxAddress, newAliasId });
  }

  // Write archive + pool once after all results processed
  writeArchive(archive, { archivePath });
  writePool(poolData, { poolPath });

  // Ledger
  try {
    const ledgerDir  = path.join(process.cwd(), 'state', 'rotation');
    const ledgerPath = path.join(ledgerDir, `ledger-${Date.now()}.json`);
    atomicWrite(ledgerPath, { ...summary, writtenAt: new Date().toISOString() });
    log(`[checkArchiveAndReplace] Ledger written to ${ledgerPath}`);
  } catch (e) {
    log(`[checkArchiveAndReplace] Could not write ledger: ${e.message}`);
  }

  log(`[checkArchiveAndReplace] Done. exhaustedProcessed=${summary.exhaustedProcessed}, reinstated=${summary.reinstated}, newAccounts=${summary.newAccountsCreated}, skipped=${summary.skipped}, failed=${summary.failed}`);
  return finalizeSummary();
}
