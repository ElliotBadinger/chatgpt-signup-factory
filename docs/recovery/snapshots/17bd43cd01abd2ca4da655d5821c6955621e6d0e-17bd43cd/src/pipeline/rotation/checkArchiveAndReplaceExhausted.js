/**
 * checkArchiveAndReplaceExhausted.js
 *
 * Main orchestrator for the Codex alias rotation pipeline.
 *
 * Algorithm (from spec Section 8):
 *  1. Assess quotas → find exhausted/atRisk aliases
 *  2. Check archive reinstatements → reinstate renewed aliases
 *  3. For each alias to rotate:
 *     a. Get next available inbox (bootstrap new root if pool empty)
 *     b. Create ChatGPT account (handle already-registered → try next inbox)
 *     c. Write temp auth → finalize → upsert route
 *     d. Archive old alias, remove from router
 *     e. Mark inbox in-use
 *  4. Write ledger entry
 *  5. Return summary
 *
 * All external I/O is injectable for testability.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { assessCodexQuotas } from './quotaDetector.js';
import {
  readArchive,
  archiveAlias,
  checkReinstatements,
  markReinstated,
} from './archiveManager.js';
import {
  readPool,
  nextAvailableInbox,
  markInboxInUse,
  markInboxFailed,
  markInboxChatGptUsed,
  addNewInboxes,
} from './inboxPoolManager.js';
import { createChatGptAccount } from './chatGptAccountCreator.js';
import {
  writeAuthCredential,
  removeAuthCredential,
  emailToAliasId,
} from './piAccountRegistrar.js';

const PI_AGENT_DIR = path.join(os.homedir(), '.pi', 'agent');
const DEFAULT_ARCHIVE_PATH = path.join(PI_AGENT_DIR, 'codex-alias-archive.json');
const DEFAULT_POOL_PATH    = path.join(PI_AGENT_DIR, 'codex-inbox-pool.json');
const DEFAULT_HEALTH_PATH  = path.join(PI_AGENT_DIR, 'account-router-health.json');
const DEFAULT_ROUTER_PATH  = path.join(PI_AGENT_DIR, 'account-router.json');
const DEFAULT_AUTH_PATH    = path.join(PI_AGENT_DIR, 'auth.json');

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function atomicWrite(filePath, data) {
  ensureDir(filePath);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function tempId() {
  return `temp-${randomBytes(6).toString('hex')}`;
}

/**
 * Reinstate an archived alias back into the router and auth.json.
 */
function reinstateAlias(archivedEntry, { routerPath, authPath, finalize, log }) {
  const aliasId = archivedEntry.aliasId;
  log(`[reinstateAlias] Reinstating ${aliasId}`);

  // Write the refreshed auth credential
  writeAuthCredential({
    aliasId,
    accessToken: archivedEntry.auth.access,
    refreshToken: archivedEntry.auth.refresh ?? null,
    expiresAt: archivedEntry.auth.expires ?? null,
    accountId: archivedEntry.auth.accountId ?? null,
    authJsonPath: authPath,
  });
}

/**
 * Remove an alias from account-router.json (aliases list + pool providers + pool routes).
 */
function removeAliasFromRouter(aliasId, routerPath) {
  try {
    if (!fs.existsSync(routerPath)) return;
    const config = JSON.parse(fs.readFileSync(routerPath, 'utf8'));

    config.aliases = (config.aliases ?? []).filter((a) => a.id !== aliasId);
    config.pools = (config.pools ?? []).map((p) => ({
      ...p,
      providers: (p.providers ?? []).filter((x) => x !== aliasId),
      routes: (p.routes ?? []).filter((r) => r.provider !== aliasId),
    }));

    atomicWrite(routerPath, config);
  } catch (e) {
    // Non-fatal — log and continue
  }
}

/**
 * Main orchestration function.
 *
 * @param {object} opts
 * @param {boolean}  [opts.dryRun=false]            - Simulate only, no writes
 * @param {boolean}  [opts.forceReplaceAll9=false]  - Replace all inboxes proactively
 * @param {Function} [opts.log=console.log]         - Logger
 *
 * Injectable overrides (for testing):
 * @param {string}   [opts.archivePath]
 * @param {string}   [opts.poolPath]
 * @param {string}   [opts.healthPath]
 * @param {string}   [opts.routerPath]
 * @param {string}   [opts.authPath]
 * @param {Function} [opts.createBrowserSession]    - async (profileDir?) => { page, cleanup }
 * @param {Function} [opts.finalize]                - async (input) => { ok, validation, error }
 * @param {object}   [opts.teamDriver]              - { inviteTeamMember, removeTeamMember }
 * @param {Function} [opts.bootstrapNewRoot]        - async () => InboxPoolEntry[]
 * @param {Function} [opts._probeQuotaOverride]     - Override probeQuota for checkReinstatements
 * @param {number}   [opts.agentMailPollIntervalMs]
 * @param {number}   [opts.agentMailTimeoutMs]
 *
 * @returns {Promise<{
 *   exhaustedProcessed: number,
 *   reinstated: number,
 *   newAccountsCreated: number,
 *   failed: number,
 *   dryRun: boolean,
 *   details: Array
 * }>}
 */
export async function runCheckArchiveAndReplace({
  dryRun = false,
  forceReplaceAll9 = false,
  log = console.log,

  // Path overrides
  archivePath = DEFAULT_ARCHIVE_PATH,
  poolPath    = DEFAULT_POOL_PATH,
  healthPath  = DEFAULT_HEALTH_PATH,
  routerPath  = DEFAULT_ROUTER_PATH,
  authPath    = DEFAULT_AUTH_PATH,

  // Injectable deps
  createBrowserSession,
  finalize,
  teamDriver,
  bootstrapNewRoot,
  _probeQuotaOverride,

  agentMailPollIntervalMs = 5_000,
  agentMailTimeoutMs = 300_000,
  navigationDelayMs = 3_000,
  pageStateCheckRetries = 6,
  pageStateCheckIntervalMs = 2_000,
} = {}) {
  const summary = {
    exhaustedProcessed: 0,
    reinstated: 0,
    newAccountsCreated: 0,
    failed: 0,
    dryRun,
    details: [],
  };

  // ── STEP 1: Assess quotas ────────────────────────────────────────────────────────
  log('[checkArchiveAndReplace] Step 1: Assessing quotas...');
  const assessment = assessCodexQuotas({ healthPath, routerPath });
  let toRotate = [...assessment.exhausted];

  if (forceReplaceAll9) {
    // Include healthy aliases too (proactive provisioning)
    toRotate = [...assessment.aliases];
    log(`[checkArchiveAndReplace] forceReplaceAll9: queuing ${toRotate.length} aliases`);
  }

  log(`[checkArchiveAndReplace] Exhausted: ${assessment.exhausted.length}, at-risk: ${assessment.atRisk.length}, healthy: ${assessment.healthy.length}`);

  // ── STEP 2: Archive reinstatement check ─────────────────────────────────────────
  log('[checkArchiveAndReplace] Step 2: Checking archive reinstatements...');

  const probeQuota = _probeQuotaOverride ?? (async (aliasId, auth) => {
    // Default: return 0 (no renewal detected without a real probe)
    return 0;
  });

  const readyToReinstate = await checkReinstatements(probeQuota, { archivePath });
  log(`[checkArchiveAndReplace] ${readyToReinstate.length} archived aliases have renewed quota`);

  for (const archived of readyToReinstate) {
    log(`[checkArchiveAndReplace] Reinstating archived alias: ${archived.aliasId}`);

    if (!dryRun) {
      reinstateAlias(archived, { routerPath, authPath, finalize, log });
      // Re-add to router using finalize if available
      if (finalize) {
        try {
          await finalize({
            tempId: archived.aliasId,
            finalId: archived.aliasId,
            configPath: routerPath,
            poolName: 'openai-codex',
            baseProviderId: 'openai-codex',
            email: archived.email,
            label: archived.aliasId,
            modelId: 'gpt-5.4',
            now: Date.now(),
            probeTimeoutMs: 30_000,
            defaultCooldownMs: 300_000,
          });
        } catch { /* Non-fatal */ }
      }
      markReinstated(archived.aliasId, { archivePath });
    }

    summary.reinstated++;
    summary.details.push({ aliasId: archived.aliasId, status: 'reinstated' });

    // Remove this alias from the toRotate list if it covers an exhausted alias
    // (The archived alias being reinstated fills the quota gap)
    if (toRotate.length > 0) {
      toRotate.shift(); // consume one rotation slot
    }
  }

  if (toRotate.length === 0 && !forceReplaceAll9) {
    log('[checkArchiveAndReplace] All exhausted aliases covered by reinstatements. Done.');
    return summary;
  }

  // ── STEP 3: For each alias to rotate ────────────────────────────────────────────
  log(`[checkArchiveAndReplace] Step 3: Rotating ${toRotate.length} alias(es)...`);

  for (const exhaustedAlias of toRotate) {
    summary.exhaustedProcessed++;
    log(`[checkArchiveAndReplace] Processing exhausted alias: ${exhaustedAlias.aliasId}`);

    let inbox = null;

    // ── 3a: Get next available inbox ──────────────────────────────────────────────
    // Try up to 3 times to handle already-registered inboxes
    let inboxAttempts = 0;
    const MAX_INBOX_ATTEMPTS = 5;

    let sessionResult = null;

    while (inboxAttempts < MAX_INBOX_ATTEMPTS) {
      inbox = nextAvailableInbox({ poolPath });

      // ── 3b: Pool empty → bootstrap new root ───────────────────────────────────
      if (!inbox) {
        log('[checkArchiveAndReplace] Pool exhausted. Calling bootstrapNewRoot...');
        if (dryRun) {
          log('[checkArchiveAndReplace] [dry-run] Would bootstrap new root mailbox');
          summary.details.push({ aliasId: exhaustedAlias.aliasId, status: 'dry-run-would-bootstrap' });
          break;
        }
        if (!bootstrapNewRoot) {
          log('[checkArchiveAndReplace] No bootstrapNewRoot provided and pool is empty. Skipping.');
          summary.failed++;
          summary.details.push({ aliasId: exhaustedAlias.aliasId, status: 'failed', error: 'pool-exhausted-no-bootstrap' });
          break;
        }
        try {
          const newInboxes = await bootstrapNewRoot();
          addNewInboxes(newInboxes, { poolPath });
          log(`[checkArchiveAndReplace] Bootstrapped ${newInboxes.length} new inbox(es)`);
          inbox = nextAvailableInbox({ poolPath });
        } catch (e) {
          log(`[checkArchiveAndReplace] bootstrapNewRoot failed: ${e.message}`);
          summary.failed++;
          summary.details.push({ aliasId: exhaustedAlias.aliasId, status: 'failed', error: `bootstrap: ${e.message}` });
          break;
        }
        if (!inbox) {
          log('[checkArchiveAndReplace] Still no inbox after bootstrap. Giving up.');
          summary.failed++;
          break;
        }
      }

      if (dryRun) {
        log(`[checkArchiveAndReplace] [dry-run] Would use inbox ${inbox.inboxAddress} for ${exhaustedAlias.aliasId}`);
        summary.details.push({ aliasId: exhaustedAlias.aliasId, status: 'dry-run', inbox: inbox.inboxAddress });
        inbox = null;
        break;
      }

      // ── 3c: Create ChatGPT account via browser ────────────────────────────────
      log(`[checkArchiveAndReplace] Creating ChatGPT account with inbox ${inbox.inboxAddress}...`);

      let page, cleanup;
      try {
        const session = await createBrowserSession();
        page = session.page;
        cleanup = session.cleanup;
      } catch (e) {
        log(`[checkArchiveAndReplace] Failed to create browser session: ${e.message}`);
        summary.failed++;
        summary.details.push({ aliasId: exhaustedAlias.aliasId, status: 'failed', error: `browser: ${e.message}` });
        break;
      }

      let createResult;
      try {
        createResult = await createChatGptAccount(page, {
          email: inbox.inboxAddress,
          agentMailApiKey: inbox.rootApiKey ?? inbox.rootApiKeyPrefix ?? '',
          agentMailInboxId: inbox.agentMailInboxId ?? inbox.inboxAddress,
          teamInviteCallback: teamDriver?.inviteTeamMember
            ? async (e) => teamDriver.inviteTeamMember(e)
            : undefined,
          agentMailPollIntervalMs,
          agentMailTimeoutMs,
          navigationDelayMs,
          pageStateCheckRetries,
          pageStateCheckIntervalMs,
        });
      } catch (e) {
        createResult = { success: false, error: String(e.message ?? e) };
      } finally {
        if (cleanup) await cleanup().catch(() => {});
      }

      // ── 3d: Handle already-registered → try next inbox ────────────────────────
      if (!createResult.success && createResult.error === 'already-registered') {
        log(`[checkArchiveAndReplace] Inbox ${inbox.inboxAddress} already registered with ChatGPT. Skipping.`);
        markInboxChatGptUsed(inbox.inboxAddress, { poolPath });
        inboxAttempts++;
        continue; // try next available inbox
      }

      if (!createResult.success) {
        log(`[checkArchiveAndReplace] Account creation failed: ${createResult.error}`);
        markInboxFailed(inbox.inboxAddress, createResult.error, { poolPath });
        summary.failed++;
        summary.details.push({ aliasId: exhaustedAlias.aliasId, status: 'failed', error: createResult.error, inbox: inbox.inboxAddress });
        inbox = null;
        break;
      }

      // ── 3e: Write temp auth + finalize ────────────────────────────────────────
      const newAliasId = emailToAliasId(inbox.inboxAddress);
      const tid = tempId();
      log(`[checkArchiveAndReplace] Writing temp auth ${tid} for ${inbox.inboxAddress} → ${newAliasId}`);

      // Write token under temp ID
      writeAuthCredential({
        aliasId: tid,
        accessToken: createResult.auth.access,
        refreshToken: createResult.auth.refresh ?? null,
        expiresAt: createResult.auth.expires ?? null,
        accountId: createResult.auth.accountId ?? null,
        authJsonPath: authPath,
      });

      let finalizeResult;
      try {
        finalizeResult = await finalize({
          tempId: tid,
          finalId: newAliasId,
          configPath: routerPath,
          poolName: 'openai-codex',
          baseProviderId: 'openai-codex',
          email: inbox.inboxAddress,
          label: newAliasId,
          modelId: 'gpt-5.4',
          now: Date.now(),
          probeTimeoutMs: 30_000,
          defaultCooldownMs: 300_000,
          authPath,
        });
      } catch (e) {
        finalizeResult = { ok: false, error: String(e.message ?? e) };
      }

      if (!finalizeResult?.ok) {
        log(`[checkArchiveAndReplace] Finalize failed: ${finalizeResult?.error}. Rolling back.`);
        // Cleanup temp auth
        removeAuthCredential(tid, authPath);
        markInboxFailed(inbox.inboxAddress, finalizeResult?.error ?? 'finalize-failed', { poolPath });
        summary.failed++;
        summary.details.push({ aliasId: exhaustedAlias.aliasId, status: 'failed', error: finalizeResult?.error, inbox: inbox.inboxAddress });
        inbox = null;
        break;
      }

      // Ensure no temp ID remains (finalize may or may not rename; we clean up defensively)
      try {
        const authData = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        if (authData[tid] && !authData[newAliasId]) {
          // finalize didn't rename — do it now
          authData[newAliasId] = authData[tid];
          delete authData[tid];
          atomicWrite(authPath, authData);
        } else if (authData[tid]) {
          // Both exist (shouldn't happen), remove temp
          delete authData[tid];
          atomicWrite(authPath, authData);
        }
      } catch { /* non-fatal */ }

      // ── 3f: Archive exhausted alias + remove from router ──────────────────────
      log(`[checkArchiveAndReplace] Archiving exhausted alias ${exhaustedAlias.aliasId}...`);
      const oldAuth = (() => {
        try {
          const data = JSON.parse(fs.readFileSync(authPath, 'utf8'));
          return data[exhaustedAlias.aliasId] ?? null;
        } catch { return null; }
      })();

      archiveAlias({
        aliasId: exhaustedAlias.aliasId,
        email: `${exhaustedAlias.aliasId}@agentmail.to`,
        auth: oldAuth ?? { type: 'oauth', access: '', refresh: '', expires: 0, accountId: '' },
        reason: 'both-exhausted',
        quotaFraction: exhaustedAlias.effectiveFraction ?? 0,
        archivePath,
      });

      removeAliasFromRouter(exhaustedAlias.aliasId, routerPath);
      removeAuthCredential(exhaustedAlias.aliasId, authPath);

      // Remove exhausted alias from ChatGPT team
      if (teamDriver?.removeTeamMember) {
        try {
          await teamDriver.removeTeamMember(`${exhaustedAlias.aliasId}@agentmail.to`);
        } catch { /* Non-fatal */ }
      }

      // ── 3g: Mark inbox in-use ─────────────────────────────────────────────────
      markInboxInUse(inbox.inboxAddress, {
        linkedAliasId: newAliasId,
        chatGptAccountId: createResult.auth.accountId,
        chatGptSignupAt: Date.now(),
        poolPath,
      });

      summary.newAccountsCreated++;
      summary.details.push({
        aliasId: exhaustedAlias.aliasId,
        status: 'rotated',
        inbox: inbox.inboxAddress,
        newAliasId,
      });
      sessionResult = { newAliasId };
      break; // Done with this alias
    }
  }

  // ── STEP 4: Write ledger ─────────────────────────────────────────────────────────
  if (!dryRun) {
    try {
      const ledgerDir = path.join(process.cwd(), 'state', 'rotation');
      const ledgerPath = path.join(ledgerDir, `ledger-${Date.now()}.json`);
      atomicWrite(ledgerPath, { ...summary, writtenAt: new Date().toISOString() });
      log(`[checkArchiveAndReplace] Ledger written to ${ledgerPath}`);
    } catch (e) {
      log(`[checkArchiveAndReplace] Could not write ledger: ${e.message}`);
    }
  }

  log(`[checkArchiveAndReplace] Done. exhaustedProcessed=${summary.exhaustedProcessed}, reinstated=${summary.reinstated}, newAccounts=${summary.newAccountsCreated}, failed=${summary.failed}`);
  return summary;
}
