#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { replayOpenAiAuthFlow } from '../pipeline/authTrace/openaiAuthReplay.js';
import { assertBrowserlessNetwork, checkBrowserlessNetwork } from '../pipeline/net/browserlessNetworkPreflight.js';
import { ensureWorkspaceInvite } from '../pipeline/rotation/browserlessInvitePolicy.js';
import { onboardBrowserlessInboxToPiRouter } from '../pipeline/rotation/browserlessRouterOnboarder.js';
import { createBrowserlessWorkspaceClient } from '../pipeline/rotation/browserlessWorkspaceClient.js';
import { createCodexLbLocalImportClientFromEnv } from '../pipeline/rotation/codexLbLocalImportClient.js';
import { findNextSafeAlias } from '../pipeline/rotation/aliasStateResolver.js';

const DEFAULT_OWNER_EMAIL = 'openai_1@epistemophile.store';
const DEFAULT_DOMAIN = 'epistemophile.store';

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    ownerEmail: process.env.OPENAI_OWNER_EMAIL ?? DEFAULT_OWNER_EMAIL,
    aliasEmail: null,
    aliasPrefix: 'openai',
    domain: process.env.RESEND_RECEIVING_DOMAIN ?? DEFAULT_DOMAIN,
    workspaceName: process.env.WORKSPACE_NAME ?? null,
    authJsonPath: path.join(os.homedir(), '.pi', 'agent', 'auth.json'),
    routerJsonPath: path.join(os.homedir(), '.pi', 'agent', 'account-router.json'),
    archiveJsonPath: path.join(os.homedir(), '.pi', 'agent', 'codex-alias-archive.json'),
    skipNetworkPreflight: false,
    skipCodexLb: false,
    requireCodexLb: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--owner-email') parsed.ownerEmail = argv[++index];
    else if (arg === '--alias-email') parsed.aliasEmail = argv[++index];
    else if (arg === '--alias-prefix') parsed.aliasPrefix = argv[++index];
    else if (arg === '--domain') parsed.domain = argv[++index];
    else if (arg === '--workspace-name') parsed.workspaceName = argv[++index];
    else if (arg === '--auth-json-path') parsed.authJsonPath = argv[++index];
    else if (arg === '--router-json-path') parsed.routerJsonPath = argv[++index];
    else if (arg === '--archive-json-path') parsed.archiveJsonPath = argv[++index];
    else if (arg === '--skip-network-preflight') parsed.skipNetworkPreflight = true;
    else if (arg === '--skip-codex-lb') parsed.skipCodexLb = true;
    else if (arg === '--require-codex-lb') parsed.requireCodexLb = true;
    else if (arg === '--dry-run') parsed.dryRun = true;
  }

  return parsed;
}

function getSessionJson(replay) {
  return replay?.steps?.find((step) => step.name === 'chatgpt_session')?.responseJson ?? null;
}

function decodeJwtPayload(token) {
  try {
    const [, payload] = String(token ?? '').split('.');
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function readJsonIfExists(filePath, fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function aliasIdFromEmail(email) {
  return String(email ?? '').split('@')[0].toLowerCase();
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function archivePoisonedAlias({ archiveJsonPath, email, reason, detail = null }) {
  const archive = readJsonIfExists(archiveJsonPath, { version: 1, aliases: [] }) ?? { version: 1, aliases: [] };
  const aliases = Array.isArray(archive.aliases) ? archive.aliases : [];
  const normalizedEmail = String(email ?? '').toLowerCase();
  const existingIndex = aliases.findIndex((entry) => String(entry.email ?? '').toLowerCase() === normalizedEmail);
  const entry = {
    ...(existingIndex >= 0 ? aliases[existingIndex] : {}),
    aliasId: aliasIdFromEmail(email),
    email: normalizedEmail,
    reinstated: false,
    reason,
    detail,
    archivedAt: new Date().toISOString(),
  };
  if (existingIndex >= 0) aliases[existingIndex] = entry;
  else aliases.push(entry);
  atomicWriteJson(archiveJsonPath, {
    ...archive,
    version: archive.version ?? 1,
    aliases,
  });
  return entry;
}

function classifyAutoSkippableAliasError(error) {
  const message = String(error?.message ?? error);
  if (message.includes('NO_EMAIL_CODE_OPTION')) return 'NO_EMAIL_CODE_OPTION';
  if (/Resend OTP poll timeout/i.test(message)) return 'RESEND_OTP_TIMEOUT';
  return null;
}

export function nextAliasEmail({
  routerJsonPath,
  authJsonPath = null,
  archiveJsonPath = null,
  prefix,
  domain,
  extraReservedEmails = [],
  invites = [],
  codexLbAccounts = [],
}) {
  const router = readJsonIfExists(routerJsonPath, { aliases: [] });
  const auth = readJsonIfExists(authJsonPath, {});
  const archive = readJsonIfExists(archiveJsonPath, { aliases: [] });
  return findNextSafeAlias({
    prefix,
    domain,
    router,
    auth,
    archive,
    workspaceMembers: extraReservedEmails,
    invites,
    codexLbAccounts,
  }).email;
}

function loadOwnerAuthFromAuthJson({ email, authJsonPath, nowMs = Date.now() }) {
  const aliasId = email.split('@')[0].toLowerCase();
  const auth = readJsonIfExists(authJsonPath, {});
  const credential = auth?.[aliasId];
  const accessToken = String(credential?.access ?? '').trim();
  if (!accessToken) return null;

  const payload = decodeJwtPayload(accessToken);
  const tokenEmail = payload?.['https://api.openai.com/profile']?.email ?? null;
  if (String(tokenEmail ?? '').toLowerCase() !== String(email).toLowerCase()) return null;

  const expiresAt = Number(credential.expires ?? (payload?.exp ? payload.exp * 1000 : 0));
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs + 60_000) return null;

  const accountId = credential.accountId
    ?? payload?.['https://api.openai.com/auth']?.chatgpt_account_id
    ?? null;

  return {
    source: 'auth-json',
    replay: { verdict: 'authenticated-existing-owner-auth', finalCookies: { cookies: [] } },
    session: {
      accessToken,
      expires: new Date(expiresAt).toISOString(),
      account: accountId ? { id: accountId } : null,
      user: { email },
    },
  };
}

async function signInWithResendOtp(email, { fetchImpl = fetch, log = () => {} } = {}) {
  log(`[resend-owner] Signing in ${email} through Resend OTP`);
  const replay = await replayOpenAiAuthFlow({
    email,
    mode: 'existing-login-otp',
    analysis: { report: {}, plan: {} },
    resendApiKey: process.env.RESEND_API_KEY,
    fetchImpl,
  });

  const session = getSessionJson(replay);
  if (replay.verdict !== 'authenticated' || !session?.accessToken) {
    throw new Error(`Resend OTP sign-in failed for ${email}: ${replay.verdict}`);
  }

  return { replay, session };
}

export function selectWorkspace(accounts, { workspaceName = null } = {}) {
  const workspaces = (accounts?.items ?? []).filter((account) => account.structure === 'workspace');
  if (workspaces.length === 0) {
    throw new Error('Owner account has no workspace accounts');
  }

  if (workspaceName) {
    const match = workspaces.find((workspace) => String(workspace.name ?? '').toLowerCase() === workspaceName.toLowerCase());
    if (!match) throw new Error(`Owner account has no workspace named ${workspaceName}`);
    return match;
  }

  if (workspaces.length > 1) {
    const names = workspaces.map((workspace) => workspace.name ?? workspace.id).join(', ');
    throw new Error(`Owner account has multiple workspace accounts; pass --workspace-name. Available: ${names}`);
  }

  return workspaces[0];
}

function extractEmailEntries(payload) {
  return (payload?.items ?? payload?.data ?? [])
    .map((entry) => entry?.email_address ?? entry?.email ?? null)
    .filter(Boolean);
}

async function listWorkspaceMemberEmails(ownerClient, workspaceId) {
  const users = await ownerClient.listUsers(workspaceId).catch(() => ({ items: [] }));
  return extractEmailEntries(users);
}

function archivedEmailSet(archiveJsonPath) {
  const archive = readJsonIfExists(archiveJsonPath, { aliases: [] });
  return new Set((archive.aliases ?? [])
    .filter((entry) => entry.reinstated !== true)
    .map((entry) => String(entry.email ?? '').toLowerCase())
    .filter(Boolean));
}

function isInviteActive(invite) {
  const status = String(invite?.status ?? '').toLowerCase();
  return Boolean(invite?.id ?? invite?.invite_id) && status !== 'cancelled' && status !== 'canceled';
}

async function cancelArchivedPendingInvites({ ownerClient, workspaceId, archiveJsonPath, excludeEmail = null, log }) {
  const archived = archivedEmailSet(archiveJsonPath);
  const excluded = String(excludeEmail ?? '').toLowerCase();
  if (archived.size === 0) return 0;
  const invites = await ownerClient.listInvites(workspaceId).catch(() => ({ items: [] }));
  let cancelled = 0;
  let stillActive = 0;
  for (const invite of invites.items ?? []) {
    const email = String(invite.email_address ?? invite.email ?? '').toLowerCase();
    const inviteId = invite.id ?? invite.invite_id ?? null;
    if (email && email === excluded) continue;
    if (!inviteId || !archived.has(email)) continue;
    await ownerClient.cancelInvite(workspaceId, inviteId).catch(() => null);
    const after = await ownerClient.listInvites(workspaceId).catch(() => ({ items: [] }));
    const activeAfterCancel = (after.items ?? []).some((candidate) => (candidate.id ?? candidate.invite_id) === inviteId && isInviteActive(candidate));
    if (activeAfterCancel) stillActive += 1;
    else cancelled += 1;
  }
  if (cancelled > 0) {
    log(`[resend-owner] Cancelled and verified ${cancelled} archived pending workspace invite(s)`);
  }
  if (stillActive > 0) {
    log(`[resend-owner] ${stillActive} archived invite cancel request(s) returned but remained active`);
  }
  return cancelled;
}

async function maybeImportCodexLb({
  options,
  result,
  workspaceId,
  log,
}) {
  if (options.skipCodexLb) {
    return { configured: false, imported: false, skipped: true, reason: 'skip-codex-lb' };
  }
  const client = createCodexLbLocalImportClientFromEnv();
  const status = client.getStatus();
  if (!client.isConfigured()) {
    if (options.requireCodexLb) {
      throw new Error(`Codex LB import required but unavailable: ${status.reason}`);
    }
    return { configured: false, imported: false, skipped: true, reason: status.reason };
  }
  log(`[resend-owner] Importing ${result.email} into codex-lb-local`);
  try {
    const imported = await client.importAccount({
      email: result.email,
      aliasId: result.aliasId,
      workspaceId,
      auth: result.auth,
      onboarded: result.onboarded,
    });
    return {
      configured: true,
      imported: true,
      accountId: imported.accountId,
      email: imported.email,
      planType: imported.planType,
    };
  } catch (error) {
    if (options.requireCodexLb) throw error;
    return {
      configured: true,
      imported: false,
      skipped: true,
      reason: String(error?.message ?? error),
    };
  }
}

export async function runResendOwnerOnboardAlias(argv = process.argv.slice(2), { log = console.log } = {}) {
  const options = parseArgs(argv);
  let aliasEmail = options.aliasEmail ?? nextAliasEmail({
    routerJsonPath: options.routerJsonPath,
    authJsonPath: options.authJsonPath,
    archiveJsonPath: options.archiveJsonPath,
    prefix: options.aliasPrefix,
    domain: options.domain,
  });

  if (options.dryRun) {
    return {
      status: 'dry-run',
      ownerEmail: options.ownerEmail,
      aliasEmail,
    };
  }

  if (!options.skipNetworkPreflight) {
    const preflight = await checkBrowserlessNetwork();
    assertBrowserlessNetwork(preflight);
  }

  const ownerAuth = loadOwnerAuthFromAuthJson({
    email: options.ownerEmail,
    authJsonPath: options.authJsonPath,
  }) ?? await signInWithResendOtp(options.ownerEmail, { log });
  if (ownerAuth.source === 'auth-json') {
    log(`[resend-owner] Reusing valid owner auth from ${options.authJsonPath}`);
  }
  const ownerClient = createBrowserlessWorkspaceClient({
    accessToken: ownerAuth.session.accessToken,
    accountId: ownerAuth.session.account?.id ?? null,
    cookies: ownerAuth.replay.finalCookies?.cookies ?? [],
  });
  const ownerAccounts = await ownerClient.getAccounts();
  const workspace = selectWorkspace(ownerAccounts, { workspaceName: options.workspaceName });
  log(`[resend-owner] Using workspace ${workspace.name ?? workspace.id} (${workspace.id})`);

  const [workspaceMemberEmails, workspaceInvites] = await Promise.all([
    listWorkspaceMemberEmails(ownerClient, workspace.id),
    ownerClient.listInvites(workspace.id).catch(() => ({ items: [] })),
  ]);
  let aliasAlreadyWorkspaceMember = false;
  if (options.aliasEmail) {
    aliasAlreadyWorkspaceMember = workspaceMemberEmails
      .some((email) => String(email).toLowerCase() === String(options.aliasEmail).toLowerCase());
    if (aliasAlreadyWorkspaceMember) {
      log(`[resend-owner] Explicit alias ${options.aliasEmail} is already a workspace member; resuming auth/router/Codex LB onboarding`);
    }
  } else {
    const workspaceAwareAliasEmail = nextAliasEmail({
      routerJsonPath: options.routerJsonPath,
      authJsonPath: options.authJsonPath,
      archiveJsonPath: options.archiveJsonPath,
      prefix: options.aliasPrefix,
        domain: options.domain,
        extraReservedEmails: workspaceMemberEmails,
        invites: workspaceInvites?.items ?? workspaceInvites,
      });
    if (workspaceAwareAliasEmail !== aliasEmail) {
      log(`[resend-owner] Skipping ${aliasEmail}; already present in workspace membership`);
      aliasEmail = workspaceAwareAliasEmail;
    }
  }

  const inviteMember = async (email) => {
    await cancelArchivedPendingInvites({
      ownerClient,
      workspaceId: workspace.id,
      archiveJsonPath: options.archiveJsonPath,
      excludeEmail: email,
      log,
    });
    const inviteResult = await ensureWorkspaceInvite({
      workspaceId: workspace.id,
      email,
      listInvites: (workspaceId) => ownerClient.listInvites(workspaceId),
      createInvite: (workspaceId, targetEmail) => ownerClient.createInvite(workspaceId, targetEmail),
      cancelInvite: (workspaceId, inviteId) => ownerClient.cancelInvite(workspaceId, inviteId),
      maxCreateAttempts: 6,
      log,
    });
    if (!inviteResult.invite) {
      throw new Error(
        `Workspace invite failed for ${email}: ${inviteResult.erroredInvite?.error ?? 'unknown error'}`
        + ` (${inviteResult.action}; failedPrunes=${inviteResult.failedPrunes?.length ?? 0})`,
      );
    }
    return inviteResult.invite;
  };

  const failedAliasEmails = [];
  let result = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      result = await onboardBrowserlessInboxToPiRouter({
        email: aliasEmail,
        apiKey: null,
        authJsonPath: options.authJsonPath,
        routerJsonPath: options.routerJsonPath,
        browserlessOnboardMember: (input) => onboardResendMember(input),
        inviteMember: aliasAlreadyWorkspaceMember ? null : inviteMember,
        ownerClient,
        selectedWorkspace: {
          workspaceId: workspace.id,
          workspaceName: workspace.name ?? null,
        },
        placementContext: {
          source: 'resend-owner',
          ownerEmail: options.ownerEmail,
          workspaceId: workspace.id,
          workspaceName: workspace.name ?? null,
        },
        log,
      });
      break;
    } catch (error) {
      const skipReason = classifyAutoSkippableAliasError(error);
      if (options.aliasEmail || !skipReason) {
        throw error;
      }
      failedAliasEmails.push(aliasEmail);
      archivePoisonedAlias({
        archiveJsonPath: options.archiveJsonPath,
        email: aliasEmail,
        reason: skipReason,
        detail: String(error?.message ?? error).split('\n')[0],
      });
      const nextAlias = nextAliasEmail({
        routerJsonPath: options.routerJsonPath,
        authJsonPath: options.authJsonPath,
        archiveJsonPath: options.archiveJsonPath,
        prefix: options.aliasPrefix,
          domain: options.domain,
          extraReservedEmails: [
            ...workspaceMemberEmails,
            ...failedAliasEmails,
          ],
          invites: workspaceInvites?.items ?? workspaceInvites,
        });
      log(`[resend-owner] Skipping ${aliasEmail}; ${skipReason}`);
      aliasEmail = nextAlias;
    }
  }
  if (!result) {
    throw new Error('Unable to onboard an alias after retrying browserless candidates');
  }
  const codexLb = await maybeImportCodexLb({
    options,
    result,
    workspaceId: workspace.id,
    log,
  });

  return {
    status: 'onboarded',
    ownerEmail: options.ownerEmail,
    aliasEmail,
    workspaceId: workspace.id,
    aliasId: result.aliasId,
    verification: result.verification,
    codexLb,
  };
}

async function onboardResendMember(input) {
  const { onboardBrowserlessWorkspaceMember } = await import('../pipeline/rotation/browserlessMemberOnboarder.js');
  return onboardBrowserlessWorkspaceMember({
    ...input,
    agentMailApiKey: null,
    resendApiKey: process.env.RESEND_API_KEY,
  });
}

if (process.argv[1]?.endsWith('resend-owner-onboard-alias.js')) {
  runResendOwnerOnboardAlias().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
