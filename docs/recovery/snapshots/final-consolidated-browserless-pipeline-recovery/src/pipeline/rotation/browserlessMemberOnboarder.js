import path from 'node:path';
import fs from 'node:fs';

import { analyzeOpenAiAuthTelemetry } from '../authTrace/openaiAuthTelemetryAnalysis.js';
import { replayOpenAiAuthFlow } from '../authTrace/openaiAuthReplay.js';
import { recoverBrowserlessIdentity } from '../authTrace/recoverBrowserlessIdentity.js';
import { fetchLatestResendReceivedEmail, isResendReceivingAddress } from '../authTrace/resendReceiving.js';
import { createBrowserlessWorkspaceClient, parseWorkspaceInviteLink } from './browserlessWorkspaceClient.js';

const DEFAULT_TRACE_DIR = path.join('artifacts', 'auth-traces', '2026-03-15T20-01-44-099Z-deep-golden-signup-v2');
const RECOVERED_GOLDEN_TRACE_DIR = path.resolve(
  '..',
  'golden-sentinel-json-recovery',
  'artifacts',
  'auth-traces',
  '2026-03-15T20-01-44-099Z-deep-golden-signup-v2',
);

function buildStaticExistingLoginAnalysis(authTraceDir) {
  return {
    report: {
      traceDir: authTraceDir,
      actualScenario: 'static-existing-login-fallback',
      sentinel: null,
      existingLoginOtp: {
        browserlessCapable: true,
        notes: 'Static fallback used because golden trace artifacts were unavailable. Existing-account OTP replay remains browserless; signup branches still require live sentinel metadata.',
      },
    },
    plan: {
      sourceTraceDir: authTraceDir,
      existingLoginOtp: {
        branch: 'existing-login-otp',
        description: 'Blank-jar ChatGPT bootstrap, authorize with login_hint, OTP validate, ChatGPT callback, session verification.',
      },
      signup: {
        branch: 'signup-new',
        unmetPrerequisite: 'sentinel-provider',
      },
    },
  };
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function buildRecoveredGoldenAnalysis(authTraceDir) {
  const traceDirs = [
    path.resolve(authTraceDir),
    RECOVERED_GOLDEN_TRACE_DIR,
  ];

  for (const traceDir of traceDirs) {
    const report = readJsonIfExists(path.join(traceDir, 'openai-auth-report.json'));
    const plan = readJsonIfExists(path.join(traceDir, 'openai-auth-plan.json'));
    if (report?.sentinel) {
      return {
        report: {
          ...report,
          traceDir,
          recoveredFromSummary: true,
        },
        plan: plan ?? {
          sourceTraceDir: traceDir,
          existingLoginOtp: buildStaticExistingLoginAnalysis(traceDir).plan.existingLoginOtp,
          signup: {
            branch: 'signup-new',
            description: 'Recovered golden summary provides sentinel flow/header schema; live replay synthesizes per-session templates from the current authorize device id.',
          },
        },
      };
    }
  }

  return null;
}

async function resolveAuthAnalysis(analyzeAuthTrace, authTraceDir) {
  try {
    return await analyzeAuthTrace(authTraceDir, { dryRun: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return buildRecoveredGoldenAnalysis(authTraceDir) ?? buildStaticExistingLoginAnalysis(authTraceDir);
  }
}

function getSessionJson(replay) {
  return replay?.steps?.find((step) => step.name === 'chatgpt_session')?.responseJson ?? null;
}

function getRefreshToken(value) {
  if (typeof value?.refreshToken === 'string') return value.refreshToken;
  if (typeof value?.refresh_token === 'string') return value.refresh_token;
  if (typeof value?.refresh === 'string') return value.refresh;
  return null;
}

function getAuthorizeRedirect(replay) {
  return replay?.steps?.find((step) => step.name === 'authorize_with_login_hint')?.responseHeaders?.location ?? null;
}

function isTransientFetchError(error) {
  const code = String(error?.code ?? error?.cause?.code ?? '').toUpperCase();
  const message = String(error?.message ?? '');
  return code === 'ETIMEDOUT'
    || code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === 'EAI_AGAIN'
    || error?.name === 'AbortError'
    || error?.name === 'TimeoutError'
    || /fetch failed/i.test(message)
    || /\bETIMEDOUT\b/i.test(message);
}

async function replayAuthWithTransientRetry({
  replayAuth,
  replayArgs,
  sleepImpl,
  maxAttempts = 3,
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await replayAuth(replayArgs);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransientFetchError(error)) {
        throw error;
      }
      await sleepImpl(1_000 * attempt);
    }
  }
  throw lastError;
}

function buildNoEmailCodeError(email, replay) {
  const redirect = getAuthorizeRedirect(replay) ?? '(unknown)';
  return new Error(`NO_EMAIL_CODE_OPTION: browserless auth replay hit password-only login for ${email} at ${redirect}`);
}

function ensureAuthenticatedReplay(replay, email) {
  if (replay?.verdict === 'authenticated') return;
  if (
    (replay?.verdict === 'unsupported-authorize-redirect' && String(getAuthorizeRedirect(replay)).includes('/log-in/password'))
    || (replay?.branch === 'password-login' && replay?.blockerReason === 'password-login-unsupported')
  ) {
    throw buildNoEmailCodeError(email, replay);
  }
  throw new Error(`Auth replay failed for ${email}: ${replay?.verdict ?? 'unknown verdict'}`);
}

function isRecoverableReplayVerdict(replay) {
  return replay?.verdict === 'signup-register-failed'
    || replay?.verdict === 'signup-otp-send-failed'
    || replay?.verdict === 'signup-otp-missing';
}

async function fetchInboxMessage({ inboxId, messageId, apiKey, fetchImpl = fetch }) {
  const response = await fetchImpl(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`AgentMail message fetch failed for ${inboxId}/${messageId}: ${response.status}`);
  }
  return response.json();
}

async function pollWorkspaceInviteMessage({
  inboxId,
  apiKey,
  fetchImpl = fetch,
  sinceMs = Date.now(),
  pollIntervalMs = 1_000,
  timeoutMs = 120_000,
}) {
  const deadline = Date.now() + timeoutMs;
  const listUrl = `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages?limit=10`;

  while (Date.now() < deadline) {
    const response = await fetchImpl(listUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (response.ok) {
      const data = await response.json();
      const messages = (data.messages ?? [])
        .map((message) => ({
          ...message,
          receivedAtMs: message.timestamp ? new Date(message.timestamp).getTime() : 0,
        }))
        .filter((message) => message.receivedAtMs >= Math.max(0, sinceMs - 30_000))
        .sort((left, right) => right.receivedAtMs - left.receivedAtMs);

      for (const message of messages) {
        const fullMessage = message.message_id
          ? await fetchInboxMessage({ inboxId, messageId: message.message_id, apiKey, fetchImpl }).catch(() => message)
          : message;
        try {
          const parsed = parseWorkspaceInviteLink([
            fullMessage.subject ?? '',
            fullMessage.preview ?? '',
            fullMessage.text ?? '',
            fullMessage.html ?? '',
            fullMessage.extracted_text ?? '',
          ].join(' '));
          return { ...parsed, rawMessage: fullMessage };
        } catch {
          // Not an invite email — keep polling newer/other messages.
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
  }

  throw new Error(`Workspace invite email not received for ${inboxId}`);
}

async function pollResendWorkspaceInviteMessage({
  inboxId,
  apiKey = process.env.RESEND_API_KEY,
  fetchImpl = fetch,
  sinceMs = Date.now(),
  pollIntervalMs = 1_000,
  timeoutMs = 120_000,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const message = await fetchLatestResendReceivedEmail({
        email: inboxId,
        apiKey,
        fetchImpl,
        sinceMs: Math.max(0, sinceMs - 30_000),
        limit: 100,
        matcher: (candidate) => String(candidate.subject ?? '').toLowerCase().includes('invited you to chatgpt'),
      });
      const parsed = parseWorkspaceInviteLink([
        message.subject ?? '',
        message.text ?? '',
        message.html ?? '',
      ].join(' '));
      if (String(parsed.inviteEmail ?? '').toLowerCase() !== String(inboxId).toLowerCase()) {
        throw new Error(`Invite email mismatch: expected ${inboxId}, got ${parsed.inviteEmail}`);
      }
      return { ...parsed, rawMessage: message };
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
  }

  throw new Error(`Workspace invite email not received for ${inboxId}: ${lastError?.message ?? 'no fresh invite'}`);
}

function findWorkspaceAccount(accounts, workspaceId) {
  return (accounts?.items ?? []).find((account) => account.id === workspaceId && account.structure === 'workspace') ?? null;
}

export async function onboardBrowserlessWorkspaceMember({
  email,
  agentMailApiKey,
  resendApiKey = process.env.RESEND_API_KEY ?? null,
  authTraceDir = DEFAULT_TRACE_DIR,
  analyzeAuthTrace = analyzeOpenAiAuthTelemetry,
  replayAuth = replayOpenAiAuthFlow,
  workspaceClientFactory = createBrowserlessWorkspaceClient,
  inviteMember = null,
  ownerClient = null,
  selectedWorkspace = null,
  selectWorkspace = null,
  placementContext = null,
  pollInviteMessage = null,
  acquireOwnedOAuth = null,
  fetchImpl = fetch,
  membershipPollIntervalMs = 1_000,
  membershipTimeoutMs = 15_000,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!email || !String(email).includes('@')) {
    throw new Error('onboardBrowserlessWorkspaceMember requires a valid email');
  }
  const usesResend = isResendReceivingAddress(email);
  if (!agentMailApiKey && !usesResend) {
    throw new Error(`onboardBrowserlessWorkspaceMember requires an AgentMail API key or Resend receiving address for ${email}`);
  }
  const effectivePollInviteMessage = pollInviteMessage ?? (usesResend ? pollResendWorkspaceInviteMessage : pollWorkspaceInviteMessage);

  const analysis = await resolveAuthAnalysis(analyzeAuthTrace, authTraceDir);
  let inviteDetails = null;
  if (inviteMember && selectedWorkspace) {
    await inviteMember(email, {
      workspace: selectedWorkspace,
      placementContext,
    });
    inviteDetails = await effectivePollInviteMessage({
      inboxId: email,
      apiKey: usesResend ? resendApiKey : agentMailApiKey,
      fetchImpl,
      sinceMs: 0,
    });
  }

  let replay = await replayAuthWithTransientRetry({
    replayAuth,
    sleepImpl,
    replayArgs: {
      email,
      analysis,
      agentMailApiKey,
      resendApiKey,
      callbackUrl: inviteDetails?.inviteUrl,
    },
  });

  try {
    ensureAuthenticatedReplay(replay, email);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!message.includes('NO_EMAIL_CODE_OPTION') && !isRecoverableReplayVerdict(replay)) {
      throw error;
    }
    const recovery = await recoverBrowserlessIdentity({
      email,
      analysis,
      agentMailApiKey,
      resendApiKey,
      replayAuth,
      analyzeAuthTrace: async () => analysis,
      fetchImpl,
    });
    if (recovery?.status !== 'recovered' || recovery?.replay?.verdict !== 'authenticated') {
      if (recovery?.attempts) {
        error.message = `${message}; recovery=${JSON.stringify(recovery.attempts)}`;
      }
      throw error;
    }
    replay = recovery.replay;
  }

  const session = getSessionJson(replay);
  if (!session?.accessToken) throw new Error(`Authenticated replay for ${email} did not expose accessToken`);
  if (!session?.account?.id) throw new Error(`Authenticated replay for ${email} did not expose account.id`);
  if (!session?.user?.email) throw new Error(`Authenticated replay for ${email} did not expose user.email`);

  const client = workspaceClientFactory({
    accessToken: session.accessToken,
    accountId: session.account.id,
    cookies: replay.finalCookies?.cookies ?? [],
    fetchImpl,
  });

  const [validatedSession, me, accountsBefore, accountCheck, granularConsent] = await Promise.all([
    client.getSession(),
    client.getMe(),
    client.getAccounts(),
    client.getAccountCheck(),
    client.getUserGranularConsent(),
  ]);

  if (String(validatedSession?.user?.email ?? '').toLowerCase() !== String(email).toLowerCase()) {
    throw new Error(`Validated session email mismatch for ${email}`);
  }
  if (String(me?.email ?? '').toLowerCase() !== String(email).toLowerCase()) {
    throw new Error(`Bearer identity mismatch for ${email}`);
  }

  let joinResult = null;
  let accountsAfter = accountsBefore;
  const resolvedWorkspace = selectedWorkspace ?? (typeof selectWorkspace === 'function'
    ? await selectWorkspace({
        email,
        replay,
        session,
        validatedSession,
        me,
        accountsBefore,
        placementContext,
        ownerClient,
      })
    : null);

  const existingWorkspace = (accountsBefore?.items ?? []).find((account) => account.structure === 'workspace');
  if (
    existingWorkspace
    && (!resolvedWorkspace || existingWorkspace.id === resolvedWorkspace.workspaceId)
    && await client.canAccessWorkspace(existingWorkspace.id)
  ) {
    joinResult = { acceptedVia: 'already-member', status: 200, ok: true, body: { success: true } };
  } else {
    const inviteRequestedAt = Date.now();
    if (inviteMember && !inviteDetails) {
      if (resolvedWorkspace || placementContext) {
        await inviteMember(email, {
          workspace: resolvedWorkspace,
          placementContext,
          replay,
          session: validatedSession,
          me,
        });
      } else {
        await inviteMember(email);
      }
    }

    if (!inviteDetails) {
      inviteDetails = await effectivePollInviteMessage({
        inboxId: email,
        apiKey: usesResend ? resendApiKey : agentMailApiKey,
        fetchImpl,
        sinceMs: inviteRequestedAt,
      });
    }

    const inviteWorkspaceId = inviteDetails.acceptWorkspaceId || inviteDetails.workspaceId;
    if (resolvedWorkspace?.workspaceId && inviteWorkspaceId && inviteWorkspaceId !== resolvedWorkspace.workspaceId) {
      throw new Error(`Workspace invite mismatch for ${email}: selected workspace ${resolvedWorkspace.workspaceId} but invite targeted ${inviteWorkspaceId}`);
    }

    const targetWorkspaceId = resolvedWorkspace?.workspaceId || inviteWorkspaceId;
    joinResult = await client.acceptInvite({
      workspaceId: targetWorkspaceId,
      email,
    });
    accountsAfter = await client.getAccounts();
  }

  const workspaceId = resolvedWorkspace?.workspaceId
    ?? inviteDetails?.acceptWorkspaceId
    ?? inviteDetails?.workspaceId
    ?? existingWorkspace?.id
    ?? (accountsAfter?.items ?? []).find((account) => account.structure === 'workspace')?.id
    ?? null;
  if (!workspaceId) {
    throw new Error(`Workspace membership validation failed for ${email}: workspace id missing`);
  }

  const membershipDeadline = Date.now() + Math.max(0, membershipTimeoutMs);
  let canAccessWorkspace = false;
  let workspaceAccount = findWorkspaceAccount(accountsAfter, workspaceId);
  let ownerMembership = null;
  let ownerSeesMember = false;

  while (true) {
    canAccessWorkspace = await client.canAccessWorkspace(workspaceId);
    if (!workspaceAccount) {
      accountsAfter = await client.getAccounts();
      workspaceAccount = findWorkspaceAccount(accountsAfter, workspaceId);
    }
    ownerMembership = ownerClient
      ? await (resolvedWorkspace || placementContext
          ? ownerClient.listUsers(workspaceId, { workspace: resolvedWorkspace, placementContext })
          : ownerClient.listUsers(workspaceId))
      : null;
    ownerSeesMember = ownerMembership
      ? (ownerMembership.items ?? []).some((user) => String(user.email ?? '').toLowerCase() === String(email).toLowerCase())
      : true;

    if (canAccessWorkspace && workspaceAccount && ownerSeesMember) {
      break;
    }
    if (Date.now() >= membershipDeadline) {
      throw new Error(`Workspace membership validation failed for ${email}: membership not confirmed`);
    }
    await sleepImpl(Math.min(membershipPollIntervalMs, Math.max(0, membershipDeadline - Date.now())));
  }

  const ownedOAuth = !getRefreshToken(validatedSession)
    && !getRefreshToken(session)
    && typeof acquireOwnedOAuth === 'function'
    ? await acquireOwnedOAuth({
        email,
        workspaceId,
        replay,
        session: validatedSession,
        cookies: typeof client.getCookies === 'function'
          ? client.getCookies()
          : (replay.finalCookies?.cookies ?? []),
        agentMailApiKey,
        resendApiKey,
        fetchImpl,
      })
    : null;
  if (ownedOAuth) {
    if (String(ownedOAuth.identityEmail ?? '').toLowerCase() !== String(email).toLowerCase()) {
      throw new Error(`Owned OAuth identity mismatch for ${email}`);
    }
    if (ownedOAuth.accountId !== workspaceId) {
      throw new Error(`Owned OAuth account mismatch for ${email}: expected ${workspaceId}, got ${ownedOAuth.accountId ?? 'missing'}`);
    }
    if (ownedOAuth.planType === 'free' || ownedOAuth.planType === 'guest' || ownedOAuth.planType == null) {
      throw new Error(`Owned OAuth returned non-workspace plan ${ownedOAuth.planType ?? 'missing'} for ${email}`);
    }
  }

  return {
    email,
    identityEmail: ownedOAuth?.identityEmail ?? me.email,
    accessToken: ownedOAuth?.accessToken ?? validatedSession?.accessToken ?? session.accessToken,
    refreshToken: ownedOAuth?.refreshToken ?? getRefreshToken(validatedSession) ?? getRefreshToken(session),
    expiresAt: ownedOAuth?.expiresAt ?? (validatedSession?.expires
      ? new Date(validatedSession.expires).getTime()
      : (session.expires ? new Date(session.expires).getTime() : null)),
    personalAccountId: session.account.id,
    workspaceId,
    workspaceName: inviteDetails?.workspaceName ?? workspaceAccount.name ?? resolvedWorkspace?.workspaceName ?? null,
    accountId: ownedOAuth?.accountId ?? workspaceId,
    selectedWorkspace: resolvedWorkspace,
    authBranch: replay.branch,
    joinedVia: joinResult.acceptedVia,
    ownedOAuth,
    inviteDetails,
    preJoin: {
      session: validatedSession,
      me,
      accounts: accountsBefore,
      accountCheck,
      granularConsent,
    },
    postJoin: {
      accounts: accountsAfter,
      ownerMembership,
    },
  };
}

export { pollWorkspaceInviteMessage, parseWorkspaceInviteLink };
