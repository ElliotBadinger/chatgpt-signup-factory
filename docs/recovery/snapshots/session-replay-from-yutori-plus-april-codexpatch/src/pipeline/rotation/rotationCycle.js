/**
 * rotationCycle.js
 *
 * Orchestrates one complete account rotation cycle:
 *
 *  1. Detect exhausted Codex aliases via health store
 *  2. For each exhausted alias:
 *     a. Bootstrap a fresh @epistemophile.space AgentMail root (Stage 1)
 *     b. Bootstrap 1 inbox from that root (the inbox becomes the new member email)
 *     c. Use an active team session (owner or any member) to:
 *        - Remove the exhausted member from the Guardrail team
 *        - Invite the new inbox email
 *     d. Onboard the new inbox (sign up to ChatGPT, accept invite)
 *     e. Register the new alias in pi's account-router
 *  3. Persist a rotation ledger entry for audit/recovery
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { assessCodexQuotas, QUOTA_EXHAUSTED_THRESHOLD, QUOTA_PREEMPTIVE_THRESHOLD } from './quotaDetector.js';
import { rotateTeamMember, resolveEnv, ensureAuthenticatedChatGptSession, inviteTeamMember } from './teamDriver.js';
import { onboardNewTeamMember } from './memberOnboarder.js';
import { registerNewMember, retireMember, listCodexAliases, emailToAliasId } from './piAccountRegistrar.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = path.resolve(__dirname, '..', '..', '..');

const ROTATION_LEDGER_DIR = path.join(WORKTREE_ROOT, 'state', 'rotation');
const ARTIFACT_DIR = path.join(WORKTREE_ROOT, 'artifacts', 'rotation');

const OWNER_EMAIL = 'brightbeer360@agentmail.to';
const OWNER_PORT_START = 9860;
const ONBOARD_PORT_START = 9870;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function mkdirp(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteJson(filePath, data) {
  mkdirp(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function loadJsonOrNull(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Bootstrap a fresh AgentMail account by shelling out to the Stage 1 CLI.
 * Returns the inbox email to use as the new team member.
 */
async function bootstrapFreshAgentMailInbox({ env, log }) {
  const root = `agentmailroot${Date.now()}@epistemophile.space`;
  const stateDir = path.join(ROTATION_LEDGER_DIR, 'bootstrap-state');
  const artifactDir = path.join(ARTIFACT_DIR, 'bootstrap');

  mkdirp(stateDir);
  mkdirp(artifactDir);

  log(`[rotationCycle] Bootstrapping fresh AgentMail root: ${root}`);

  const { createRealStage1LiveHooks } = await import('../bootstrap/realStage1.js');
  const { runBootstrap } = await import('../bootstrap/runBootstrap.js');
  const { createPipelineStore } = await import('../state/store.js');

  const liveHooks = createRealStage1LiveHooks({
    artifactDir,
    cwd: WORKTREE_ROOT,
    inboxCount: 1,
  });

  const store = createPipelineStore({ stateDir });

  let bootstrapResult = null;
  try {
    bootstrapResult = await runBootstrap({
      candidateRootEmails: [root],
      store,
      artifactDir,
      verifyMailboxAuthority: liveHooks.verifyMailboxAuthority,
      createOrRecoverAgentMailController: liveHooks.createOrRecoverAgentMailController,
      captureApiKey: liveHooks.captureApiKey,
      createInboxes: liveHooks.createInboxes,
    });
  } finally {
    await liveHooks.cleanup().catch(() => {});
  }

  // Extract the inbox email from the bootstrap result
  const controllers = await store.listControllers();
  const controller = controllers.find((c) => c.email === root);

  if (!controller) throw new Error(`Bootstrap did not produce a controller for ${root}`);

  // Find the inbox artifact
  const controllerSlug = root.replace(/[@.]/g, '-');
  const inboxArtifact = loadJsonOrNull(
    path.join(artifactDir, `controller-${controllerSlug}`, 'inbox-creation.json'),
  );
  const inboxIds = inboxArtifact?.inboxIds ?? [];
  if (inboxIds.length === 0) throw new Error(`No inboxes created for ${root}`);

  const inboxEmail = inboxIds[0]; // e.g. "brainydesk135@agentmail.to"
  log(`[rotationCycle] Bootstrapped inbox: ${inboxEmail} (root: ${root})`);

  return {
    rootEmail: root,
    inboxEmail,
    bootstrapResult,
    artifactDir: path.join(artifactDir, `controller-${controllerSlug}`),
  };
}

/**
 * Execute a single rotation: retire one exhausted alias and onboard one fresh one.
 */
async function executeOneRotation({
  exhaustedAlias,
  env,
  ownerPort = OWNER_PORT_START,
  onboardPort = ONBOARD_PORT_START,
  dryRun = false,
  log = () => {},
}) {
  const cycleId = `rotation-${Date.now()}`;
  const ledgerPath = path.join(ROTATION_LEDGER_DIR, `${cycleId}.json`);
  const cycleArtifactDir = path.join(ARTIFACT_DIR, cycleId);
  mkdirp(cycleArtifactDir);

  const ledger = {
    cycleId,
    startedAt: new Date().toISOString(),
    exhaustedAlias: {
      id: exhaustedAlias.aliasId,
      email: exhaustedAlias.email,
      effectiveFraction: exhaustedAlias.effectiveFraction,
    },
    steps: [],
    status: 'in-progress',
  };

  function recordStep(name, data) {
    ledger.steps.push({ name, at: new Date().toISOString(), ...data });
    atomicWriteJson(ledgerPath, ledger);
  }

  log(`[rotationCycle] Starting rotation ${cycleId} for exhausted alias ${exhaustedAlias.email}`);
  recordStep('init', { dryRun });

  try {
    // Step 1: Bootstrap fresh AgentMail root + inbox
    log(`[rotationCycle] Step 1: Bootstrap fresh AgentMail inbox`);
    let bootstrapData;
    if (dryRun) {
      bootstrapData = { rootEmail: 'dry-run@epistemophile.space', inboxEmail: 'dry-run-inbox@agentmail.to' };
    } else {
      bootstrapData = await bootstrapFreshAgentMailInbox({ env, log });
    }
    recordStep('bootstrap', { inboxEmail: bootstrapData.inboxEmail, rootEmail: bootstrapData.rootEmail });

    const newInboxEmail = bootstrapData.inboxEmail;

    // Step 2: Remove exhausted member + invite new one (using owner session)
    log(`[rotationCycle] Step 2: Team rotation (remove ${exhaustedAlias.email}, invite ${newInboxEmail})`);
    let teamResult;
    if (dryRun) {
      teamResult = { ownerEmail: OWNER_EMAIL, removeResult: { outcome: 'dry-run' }, inviteResult: { success: true } };
    } else {
      teamResult = await rotateTeamMember({
        ownerEmail: OWNER_EMAIL,
        removeEmail: exhaustedAlias.email,
        inviteEmail: newInboxEmail,
        env,
        port: ownerPort,
        log,
      });
    }
    recordStep('team-rotation', {
      removeEmail: exhaustedAlias.email,
      inviteEmail: newInboxEmail,
      removeOutcome: teamResult.removeResult?.outcome,
      inviteSuccess: teamResult.inviteResult?.success,
    });

    // Step 3: Onboard new member (sign up + accept invite)
    log(`[rotationCycle] Step 3: Onboard new member ${newInboxEmail}`);
    let onboardResult;
    if (dryRun) {
      onboardResult = {
        email: newInboxEmail,
        accessToken: 'dry-run-token',
        accountId: 'dry-run-account-id',
        profileDir: '/tmp/dry-run-profile',
      };
    } else {
      // Wait briefly for invite email to arrive before polling
      await sleep(30_000);

      onboardResult = await onboardNewTeamMember({
        inviteeEmail: newInboxEmail,
        env,
        port: onboardPort,
        log,
      });
    }
    recordStep('onboard', {
      email: newInboxEmail,
      hasAccessToken: Boolean(onboardResult.accessToken),
      accountId: onboardResult.accountId,
      finalUrl: onboardResult.finalUrl,
    });

    // Step 4: Register in pi (auth.json + account-router.json)
    log(`[rotationCycle] Step 4: Register ${newInboxEmail} in pi account-router`);
    let piResult;
    if (!dryRun && onboardResult.accessToken) {
      piResult = registerNewMember({
        email: newInboxEmail,
        accessToken: onboardResult.accessToken,
        refreshToken: onboardResult.refreshToken,
        accountId: onboardResult.accountId,
        log,
      });
    } else if (dryRun) {
      piResult = { aliasId: emailToAliasId(newInboxEmail), email: newInboxEmail };
    } else {
      log(`[rotationCycle] WARNING: No access token captured - skipping pi registration`);
      piResult = null;
    }
    recordStep('pi-register', { result: piResult });

    // Step 5: Retire exhausted member from pi
    log(`[rotationCycle] Step 5: Retire exhausted member ${exhaustedAlias.email} from pi`);
    if (!dryRun) {
      const retireResult = retireMember({
        email: exhaustedAlias.email,
        log,
      });
      recordStep('pi-retire', { result: retireResult });
    } else {
      recordStep('pi-retire', { result: 'dry-run' });
    }

    ledger.status = 'complete';
    ledger.completedAt = new Date().toISOString();
    ledger.newMember = {
      email: newInboxEmail,
      aliasId: piResult?.aliasId,
    };
    atomicWriteJson(ledgerPath, ledger);

    log(`[rotationCycle] Rotation ${cycleId} complete: ${exhaustedAlias.email} → ${newInboxEmail}`);
    return { cycleId, status: 'complete', exhaustedAlias, newMember: ledger.newMember, ledgerPath };
  } catch (error) {
    ledger.status = 'failed';
    ledger.failedAt = new Date().toISOString();
    ledger.error = { message: error.message, code: error.code, stack: error.stack?.slice(0, 1000) };
    atomicWriteJson(ledgerPath, ledger);
    log(`[rotationCycle] Rotation ${cycleId} FAILED: ${error.message}`);
    throw error;
  }
}

/**
 * Run one full rotation pass:
 *   - Assess quotas
 *   - For each exhausted alias, run executeOneRotation
 *   - Optionally also rotate at-risk aliases if preemptive is enabled
 */
export async function runRotationCycle({
  env: explicitEnv,
  dryRun = false,
  preemptive = false,
  maxRotationsPerCycle = 3,
  ownerPortBase = OWNER_PORT_START,
  onboardPortBase = ONBOARD_PORT_START,
  forceAliases = [],        // explicitly requested aliases to rotate regardless of quota
  log = () => {},
} = {}) {
  const env = explicitEnv || resolveEnv(WORKTREE_ROOT);

  mkdirp(ROTATION_LEDGER_DIR);
  mkdirp(ARTIFACT_DIR);

  const assessment = assessCodexQuotas();
  log(`[rotationCycle] Quota assessment: ${assessment.exhausted.length} exhausted, ${assessment.atRisk.length} at-risk, ${assessment.healthy.length} healthy`);

  // Build forced candidates from explicit override list
  const forcedCandidates = forceAliases
    .map((email) => assessment.aliases.find((a) => a.email === email))
    .filter(Boolean);

  const candidates = [
    ...forcedCandidates,
    ...assessment.exhausted.filter((a) => !forcedCandidates.some((f) => f.email === a.email)),
    ...(preemptive ? assessment.atRisk.filter((a) => !forcedCandidates.some((f) => f.email === a.email)) : []),
  ].slice(0, maxRotationsPerCycle);

  if (candidates.length === 0) {
    log(`[rotationCycle] No accounts need rotation`);
    return { cycleAt: new Date().toISOString(), rotations: [], status: 'idle' };
  }

  const results = [];
  for (let i = 0; i < candidates.length; i++) {
    const alias = candidates[i];
    const ownerPort = ownerPortBase + i;
    const onboardPort = onboardPortBase + i;

    try {
      const result = await executeOneRotation({
        exhaustedAlias: alias,
        env,
        ownerPort,
        onboardPort,
        dryRun,
        log,
      });
      results.push({ status: 'success', exhaustedAlias: alias, newMember: result.newMember, cycleId: result.cycleId, ledgerPath: result.ledgerPath });
    } catch (error) {
      results.push({
        status: 'failed',
        aliasId: alias.aliasId,
        email: alias.email,
        error: error.message,
        code: error.code,
      });
    }
  }

  const summary = {
    cycleAt: new Date().toISOString(),
    rotations: results,
    status: results.every((r) => r.status === 'success') ? 'complete' : 'partial',
    assessment: {
      exhausted: assessment.exhausted.map((a) => a.email),
      atRisk: assessment.atRisk.map((a) => a.email),
    },
  };

  const summaryPath = path.join(ROTATION_LEDGER_DIR, `cycle-${Date.now()}.json`);
  atomicWriteJson(summaryPath, summary);
  log(`[rotationCycle] Cycle complete: ${results.filter((r) => r.status === 'success').length}/${results.length} rotations succeeded`);

  return summary;
}

export { assessCodexQuotas, QUOTA_EXHAUSTED_THRESHOLD, QUOTA_PREEMPTIVE_THRESHOLD };
