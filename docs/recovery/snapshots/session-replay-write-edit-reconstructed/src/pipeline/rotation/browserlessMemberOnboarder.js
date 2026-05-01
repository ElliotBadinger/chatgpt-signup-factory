import path from 'node:path';

import { analyzeOpenAiAuthTelemetry } from '../authTrace/openaiAuthTelemetryAnalysis.js';
import { replayOpenAiAuthFlow } from '../authTrace/openaiAuthReplay.js';
import { recoverBrowserlessIdentity } from '../authTrace/recoverBrowserlessIdentity.js';
import { createBrowserlessWorkspaceClient, parseWorkspaceInviteLink } from './browserlessWorkspaceClient.js';

const DEFAULT_TRACE_DIR = path.join('artifacts', 'auth-traces', '2026-03-15T20-01-44-099Z-deep-golden-signup-v2');

function getSessionJson(replay) {
  return replay?.steps?.find((step) => step.name === 'chatgpt_session')?.responseJson ?? null;
}

function getAuthorizeRedirect(replay) {
  return replay?.steps?.find((step) => step.name === 'authorize_with_login_hint')?.responseHeaders?.location ?? null;
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

function findWorkspaceAccount(accounts, workspaceId) {
  return (accounts?.items ?? []).find((account) => account.id === workspaceId && account.structure === 'workspace') ?? null;
}

export async function onboardBrowserlessWorkspaceMember({
  email,
  agentMailApiKey,
  authTraceDir = DEFAULT_TRACE_DIR,
  analyzeAuthTrace = analyzeOpenAiAuthTelemetry,
  replayAuth = replayOpenAiAuthFlow,
  workspaceClientFactory = createBrowserlessWorkspaceClient,
  inviteMember = null,
  ownerClient = null,
  selectedWorkspace = null,
  selectWorkspace = null,
  placementContext = null,
  pollInviteMessage = pollWorkspaceInviteMessage,
  fetchImpl = fetch,
  membershipPollIntervalMs = 1_000,
  membershipTimeoutMs = 15_000,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!email || !String(email).includes('@')) {
    throw new Error('onboardBrowserlessWorkspaceMember requires a valid email');
  }
  if (!agentMailApiKey) {
    throw new Error(`onboardBrowserlessWorkspaceMember requires an AgentMail API key for ${email}`);
  }

  const analysis = await analyzeAuthTrace(authTraceDir, { dryRun: true });
  let replay = await replayAuth({
    email,
    analysis,
    agentMailApiKey,
  });

  try {
    ensureAuthenticatedReplay(replay, email);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!message.includes('NO_EMAIL_CODE_OPTION')) {
      throw error;
    }
    const recovery = await recoverBrowserlessIdentity({
      email,
      analysis,
      agentMailApiKey,
      replayAuth,
      analyzeAuthTrace: async () => analysis,
      fetchImpl,
    });
    if (recovery?.status !== 'recovered' || recovery?.replay?.verdict !== 'authenticated') {
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

  let inviteDetails = null;
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
    if (inviteMember) {
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

    inviteDetails = await pollInviteMessage({
      inboxId: email,
      apiKey: agentMailApiKey,
      fetchImpl,
      sinceMs: inviteRequestedAt,
    });

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

  return {
    email,
    identityEmail: me.email,
    accessToken: session.accessToken,
    expiresAt: session.expires ? new Date(session.expires).getTime() : null,
    personalAccountId: session.account.id,
    workspaceId,
    workspaceName: inviteDetails?.workspaceName ?? workspaceAccount.name ?? resolvedWorkspace?.workspaceName ?? null,
    accountId: workspaceId,
    selectedWorkspace: resolvedWorkspace,
    authBranch: replay.branch,
    joinedVia: joinResult.acceptedVia,
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
