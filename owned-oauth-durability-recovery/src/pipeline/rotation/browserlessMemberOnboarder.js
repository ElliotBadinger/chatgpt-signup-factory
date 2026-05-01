import path from 'node:path';

import { createAgentMailInboundTransport } from '../authTrace/agentMailInboundTransport.js';
import { analyzeOpenAiAuthTelemetry } from '../authTrace/openaiAuthTelemetryAnalysis.js';
import { acquireOwnedOpenAiOauth } from '../authTrace/openaiOwnedOauth.js';
import { replayOpenAiAuthFlow } from '../authTrace/openaiAuthReplay.js';
import { recoverBrowserlessIdentity } from '../authTrace/recoverBrowserlessIdentity.js';
import {
  createBrowserlessWorkspaceClient,
  isTransientFetchError,
  isWorkspaceSessionRestartRequiredError,
  parseWorkspaceInviteLink,
} from './browserlessWorkspaceClient.js';

const DEFAULT_TRACE_DIR = path.join('artifacts', 'auth-traces', '2026-03-15T20-01-44-099Z-deep-golden-signup-v2');

function normalizeReplaySession(session) {
  if (!session || typeof session !== 'object') return null;

  const accessToken = session.accessToken ?? session.access ?? null;
  const refreshToken = session.refreshToken ?? session.refresh_token ?? session.refresh ?? null;
  const expires = session.expires ?? session.expiresAt ?? null;
  const accountId = session.account?.id ?? session.accountId ?? session.workspaceId ?? null;
  const userEmail = session.user?.email ?? session.identityEmail ?? session.userEmail ?? null;

  return {
    ...session,
    accessToken,
    refreshToken,
    expires,
    user: session.user ?? (userEmail ? { email: userEmail, id: session.userId ?? null } : null),
    account: session.account ?? (accountId ? { id: accountId, planType: session.planType ?? null } : null),
  };
}

function getSessionJson(replay) {
  const session = replay?.steps?.find((step) => step.name === 'chatgpt_session')?.responseJson ?? null;
  return normalizeReplaySession(session);
}

function getAuthorizeRedirect(replay) {
  return replay?.steps?.find((step) => step.name === 'authorize_with_login_hint')?.responseHeaders?.location ?? null;
}

function buildNoEmailCodeError(email, replay) {
  const redirect = getAuthorizeRedirect(replay) ?? '(unknown)';
  return new Error(`NO_EMAIL_CODE_OPTION: browserless auth replay hit password-only login for ${email} at ${redirect}`);
}

function buildReplayFailureError(email, replay) {
  const blockerReason = replay?.blockerReason ?? replay?.reason ?? null;
  const error = new Error(
    `Auth replay failed for ${email}: ${replay?.verdict ?? 'unknown verdict'}${blockerReason ? ` (${blockerReason})` : ''}`
  );
  error.blockerReason = blockerReason;
  error.replay = replay;
  return error;
}

function buildRecoveryFailureError(email, recovery) {
  const recoveryReason = recovery?.reason ?? recovery?.blockerReason ?? null;
  const error = new Error(
    `Browserless recovery failed for ${email}: ${recovery?.status ?? 'unknown'}${recoveryReason ? ` (${recoveryReason})` : ''}`
  );
  error.recovery = recovery;
  error.blockerReason = recoveryReason;
  return error;
}

function isPasswordLoginOtpStarvationError(error) {
  const message = String(error?.message ?? error);
  const stack = String(error?.stack ?? '');
  return message.includes('No OTP-bearing AgentMail message found')
    && stack.includes('runPasswordlessOtpFromPasswordPage')
    && stack.includes('runPasswordLoginBranch');
}

function buildPasswordLoginOtpStarvationFailure(email, cause) {
  const error = new Error(`PASSWORDLESS_OTP_MISSING: browserless auth replay exhausted password-page OTP for ${email}`);
  error.branch = 'password-login';
  error.verdict = 'blocked';
  error.blockerReason = 'passwordless-otp-missing';
  error.cause = cause;
  return error;
}

function classifyRecoverableReplayFailure(error, email) {
  const message = String(error?.message ?? error);
  if (message.includes('NO_EMAIL_CODE_OPTION')) {
    return error;
  }
  if (isPasswordLoginOtpStarvationError(error)) {
    return buildPasswordLoginOtpStarvationFailure(email, error);
  }
  return null;
}

function ensureAuthenticatedReplay(replay, email) {
  if (replay?.verdict === 'authenticated') return;
  if (
    (replay?.verdict === 'unsupported-authorize-redirect' && String(getAuthorizeRedirect(replay)).includes('/log-in/password'))
    || (replay?.branch === 'password-login' && replay?.blockerReason === 'password-login-unsupported')
  ) {
    throw buildNoEmailCodeError(email, replay);
  }
  throw buildReplayFailureError(email, replay);
}

function buildInviteParseText({ message = {}, content = {} } = {}) {
  return [
    message.subject ?? '',
    message.preview ?? '',
    content.text ?? message.text ?? '',
    content.html ?? message.html ?? '',
    content.preferredBody ?? '',
    message.extracted_text ?? '',
  ].join(' ');
}

function isTransientMembershipProbeError(error) {
  const code = String(error?.code ?? error?.cause?.code ?? '').toUpperCase();
  const status = Number(
    error?.status
    ?? error?.statusCode
    ?? error?.response?.status
    ?? NaN,
  );
  const message = String(error?.message ?? '');

  if (code === 'ETIMEDOUT'
    || code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === 'EAI_AGAIN'
    || code === 'ENOTFOUND'
    || error?.name === 'AbortError') {
    return true;
  }

  if (Number.isFinite(status)) {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }

  return /\btransient\b/i.test(message)
    || /\btimeout\b/i.test(message)
    || /\btimed out\b/i.test(message)
    || /\btemporar(?:y|ily)\b/i.test(message)
    || /\brate limit/i.test(message)
    || /\btoo many requests\b/i.test(message)
    || /\bfetch failed\b/i.test(message)
    || /\bservice unavailable\b/i.test(message)
    || /\bbad gateway\b/i.test(message)
    || /\bgateway timeout\b/i.test(message)
    || /\bnetwork\b/i.test(message);
}

async function pollWorkspaceInviteMessage({
  inboxId,
  apiKey,
  fetchImpl = fetch,
  createTransport = createAgentMailInboundTransport,
  sinceMs = Date.now(),
  pollIntervalMs = 1_000,
  timeoutMs = 120_000,
}) {
  const parseInvite = ({ message = {}, content = {} } = {}) => parseWorkspaceInviteLink(buildInviteParseText({ message, content }));
  const receivedSinceThresholdMs = Math.max(0, sinceMs);
  const toReceivedAtMs = (value) => {
    if (!value) return null;
    const receivedAtMs = new Date(value).getTime();
    return Number.isFinite(receivedAtMs) ? receivedAtMs : null;
  };

  const transport = createTransport({ apiKey, fetchImpl, pollIntervalMs });
  try {
    const inboundEvent = await transport.waitForMatchingMessage({
      inboxId,
      timeoutMs,
      matcher: (event) => {
        const message = event?.message ?? {};
        const receivedAtMs = toReceivedAtMs(
          event?.receivedAt
          ?? message.timestamp
          ?? message.receivedAt
          ?? message.received_at
          ?? null,
        );
        if (receivedAtMs == null && sinceMs > 0) {
          return false;
        }
        if (receivedAtMs != null && receivedAtMs < receivedSinceThresholdMs) {
          return false;
        }
        try {
          parseInvite({ message, content: event?.content ?? {} });
          return true;
        } catch {
          return false;
        }
      }
    });
    const parsed = parseInvite({
      message: inboundEvent?.message ?? {},
      content: inboundEvent?.content ?? {},
    });
    return { ...parsed, rawMessage: inboundEvent?.message ?? null, event: inboundEvent };
  } catch (error) {
    if (String(error?.message ?? '') === `Timed out waiting for AgentMail message in ${inboxId}`) {
      throw new Error(`Workspace invite email not received for ${inboxId}`);
    }
    throw error;
  } finally {
    await transport.shutdown?.();
  }
}

function findWorkspaceAccount(accounts, workspaceId) {
  return (accounts?.items ?? []).find((account) => account.id === workspaceId && account.structure === 'workspace') ?? null;
}

function shouldSelectWorkspaceSession({ session = null, workspaceId = null } = {}) {
  if (!workspaceId) return false;
  return session?.account?.id !== workspaceId;
}

function getRefreshToken(value) {
  if (typeof value?.refreshToken === 'string') return value.refreshToken;
  if (typeof value?.refresh_token === 'string') return value.refresh_token;
  return null;
}

function resolveKnownWorkspace({
  selectedWorkspace = null,
  placementContext = null,
} = {}) {
  if (selectedWorkspace?.workspaceId) {
    return {
      ...selectedWorkspace,
      workspaceId: selectedWorkspace.workspaceId,
      workspaceName: selectedWorkspace.workspaceName ?? null,
    };
  }
  if (placementContext?.workspaceId) {
    return {
      ...placementContext,
      workspaceId: placementContext.workspaceId,
      workspaceName: placementContext.workspaceName ?? null,
    };
  }
  return null;
}

function buildInviteAcceptanceContext({
  workspaceId = null,
  inviteDetails = null,
  resolvedWorkspace = null,
  placementContext = null,
  email = null,
} = {}) {
  return {
    workspaceId,
    workspaceName: inviteDetails?.workspaceName
      ?? resolvedWorkspace?.workspaceName
      ?? placementContext?.workspaceName
      ?? null,
    inviteEmail: inviteDetails?.inviteEmail ?? email ?? null,
    inviteUrl: inviteDetails?.inviteUrl ?? null,
  };
}

function buildWorkspaceInviteMismatchError(email, expectedWorkspaceId, observedWorkspaceId) {
  const observedLabel = observedWorkspaceId ?? 'missing-workspace-identity';
  const error = new Error(
    `Workspace invite mismatch for ${email}: selected workspace ${expectedWorkspaceId} but invite targeted ${observedLabel}`
  );
  error.blockerReason = 'workspace-account-mismatch';
  error.expectedWorkspaceId = expectedWorkspaceId ?? null;
  error.observedWorkspaceId = observedWorkspaceId ?? null;
  return error;
}

function buildWorkspaceSelectionRecoveryFailure(email, workspaceId, cause) {
  const error = new Error(
    `Workspace session recovery failed for ${email}: could not activate ${workspaceId ?? 'unknown-workspace'}`
  );
  error.blockerReason = 'workspace-session-recovery-failed';
  error.workspaceId = workspaceId ?? null;
  error.cause = cause;
  return error;
}

function isWorkspaceSelectionRecoveryRetryableError(error) {
  return isWorkspaceSessionRestartRequiredError(error) || isTransientFetchError(error);
}

function buildSyntheticInviteUrl({
  workspaceId = null,
  workspaceName = null,
  email = null,
} = {}) {
  if (!workspaceId || !workspaceName || !email) return null;

  const inviteUrl = new URL('https://chatgpt.com/auth/login');
  inviteUrl.searchParams.set('inv_ws_name', workspaceName);
  inviteUrl.searchParams.set('inv_email', email);
  inviteUrl.searchParams.set('wId', workspaceId);
  inviteUrl.searchParams.set('accept_wId', workspaceId);
  return inviteUrl.toString();
}

function hasActualInviteContext({
  inviteDetails = null,
  workspaceId = null,
  workspaceName = null,
  email = null,
} = {}) {
  if (inviteDetails?.synthetic === true) return false;
  if (inviteDetails?.synthetic === false) return true;
  const inviteUrl = inviteDetails?.inviteUrl ?? null;
  if (!inviteUrl) return false;
  return inviteUrl !== buildSyntheticInviteUrl({
    workspaceId,
    workspaceName,
    email,
  });
}

function inviteResponseHasError(inviteResponse, email) {
  const errored = Array.isArray(inviteResponse?.errored_emails) ? inviteResponse.errored_emails : [];
  return errored.some((entry) => String(entry?.email_address ?? '').toLowerCase() === String(email).toLowerCase());
}

function assertInviteResponseUsable(inviteResponse, email) {
  if (!inviteResponse) return;
  if (inviteResponseHasError(inviteResponse, email)) {
    throw new Error(`Workspace invite creation failed for ${email}: ${JSON.stringify(inviteResponse.errored_emails)}`);
  }

  const action = String(inviteResponse?.action ?? '');
  if (action !== 'create-errored' && action !== 'pruned-but-still-errored') {
    return;
  }

  const erroredInvite = inviteResponse?.erroredInvite ?? null;
  const erroredMessage = erroredInvite?.error ?? 'invite creation errored';
  throw new Error(
    `Workspace invite unavailable for ${email}: ${erroredMessage}`
    + ` (action=${action}, prunedInviteId=${inviteResponse?.prunedInvite?.id ?? 'none'})`,
  );
}

function summarizeInviteDispatch(inviteResponse = null, { targetWorkspaceId = null } = {}) {
  if (!inviteResponse) return null;

  const createdInviteItems = Array.isArray(inviteResponse?.createdInvite?.account_invites)
    ? inviteResponse.createdInvite.account_invites
    : [];
  const createdInvite = createdInviteItems[0] ?? null;
  const invite = inviteResponse?.invite ?? createdInvite ?? null;

  return {
    action: inviteResponse?.action ?? 'unspecified',
    attempts: inviteResponse?.attempts ?? null,
    inviteId: invite?.id ?? inviteResponse?.id ?? null,
    createdInviteId: createdInvite?.id ?? inviteResponse?.id ?? null,
    prunedInviteId: inviteResponse?.prunedInvite?.id ?? null,
    targetWorkspaceId,
  };
}

async function acceptInviteWithRetry({
  client,
  workspaceId,
  email,
  sleepImpl,
  timeoutMs = 30_000,
  pollIntervalMs = 1_000,
  log = () => {},
}) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let lastError = null;

  do {
    try {
      return await client.acceptInvite({ workspaceId, email });
    } catch (error) {
      if (!isTransientMembershipProbeError(error)) {
        throw error;
      }
      lastError = error;
      log(`[browserlessMemberOnboarder] invite accept retry for ${email}: ${error.message}`);
      if (Date.now() >= deadline) break;
      await sleepImpl(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
  } while (Date.now() <= deadline);

  throw lastError ?? new Error(`Invite acceptance failed for ${email}`);
}

function buildMembershipMaterializationError({
  email,
  workspaceId,
  acceptedVia = null,
  canAccessWorkspace = false,
  workspaceAccountObserved = false,
  ownerSeesMember = false,
  postAcceptMaterializationAttempted = false,
}) {
  return new Error(
    `MEMBERSHIP_NOT_MATERIALIZED: invite accepted for ${email} in ${workspaceId ?? 'unknown-workspace'}`
    + ` via ${acceptedVia ?? 'unknown'} but membership did not materialize`
    + ` (canAccessWorkspace=${canAccessWorkspace}, workspaceAccountObserved=${workspaceAccountObserved}, ownerSeesMember=${ownerSeesMember}, postAcceptMaterializationAttempted=${postAcceptMaterializationAttempted})`,
  );
}

async function probeMembershipState({
  client,
  workspaceId,
  accountsAfter,
  workspaceAccount,
  ownerClient,
  resolvedWorkspace,
  placementContext,
  email,
  log,
}) {
  let nextAccountsAfter = accountsAfter;
  let nextWorkspaceAccount = workspaceAccount;
  let canAccessWorkspace = false;
  let ownerMembership = null;
  let ownerSeesMember = false;

  try {
    canAccessWorkspace = await client.canAccessWorkspace(workspaceId);
  } catch (error) {
    if (!isTransientMembershipProbeError(error)) throw error;
    log(`[browserlessMemberOnboarder] transient canAccessWorkspace probe failure for ${email}: ${error.message}`);
  }

  if (!nextWorkspaceAccount) {
    try {
      nextAccountsAfter = await client.getAccounts();
      nextWorkspaceAccount = findWorkspaceAccount(nextAccountsAfter, workspaceId);
    } catch (error) {
      if (!isTransientMembershipProbeError(error)) throw error;
      log(`[browserlessMemberOnboarder] transient getAccounts probe failure for ${email}: ${error.message}`);
    }
  }

  try {
    ownerMembership = ownerClient
      ? await (resolvedWorkspace || placementContext
          ? ownerClient.listUsers(workspaceId, { workspace: resolvedWorkspace, placementContext })
          : ownerClient.listUsers(workspaceId))
      : null;
    ownerSeesMember = ownerMembership
      ? (ownerMembership.items ?? []).some((user) => String(user.email ?? '').toLowerCase() === String(email).toLowerCase())
      : true;
  } catch (error) {
    if (!isTransientMembershipProbeError(error)) throw error;
    log(`[browserlessMemberOnboarder] transient owner membership probe failure for ${email}: ${error.message}`);
  }

  return {
    accountsAfter: nextAccountsAfter,
    workspaceAccount: nextWorkspaceAccount,
    canAccessWorkspace,
    ownerMembership,
    ownerSeesMember,
  };
}

async function continueInviteMaterialization({
  client,
  workspaceId,
  inviteDetails,
  resolvedWorkspace,
  placementContext,
  email,
  ownerClient,
  accountsAfter,
  pollInviteMessage,
  agentMailApiKey,
  fetchImpl,
  inviteRequestedAt = null,
  log = () => {},
  recoverWorkspaceSelection = null,
}) {
  let nextInviteDetails = inviteDetails;
  let nextAccountsAfter = accountsAfter;
  let nextClient = client;

  const runMembershipProbe = async () => probeMembershipState({
    client: nextClient,
    workspaceId,
    accountsAfter: nextAccountsAfter,
    workspaceAccount: null,
    ownerClient,
    resolvedWorkspace,
    placementContext,
    email,
    log,
  });

  const refreshWorkspaceSession = async (stageLabel) => {
    if (!workspaceId) return;
    try {
      if (typeof recoverWorkspaceSelection === 'function') {
        const recoveredSelection = await recoverWorkspaceSelection({
          client: nextClient,
          workspaceId,
          inviteDetails: nextInviteDetails,
          stageLabel,
        });
        nextClient = recoveredSelection.client;
        const refreshedSession = recoveredSelection.selectedSession;
        log(
          `[browserlessMemberOnboarder] workspace session refresh after ${stageLabel} for ${email}:`
          + ` accountId=${refreshedSession?.account?.id ?? 'missing'}`
        );
        return;
      }

      await nextClient.selectWorkspace({ workspaceId });
      const refreshedSession = await nextClient.getSession();
      log(
        `[browserlessMemberOnboarder] workspace session refresh after ${stageLabel} for ${email}:`
        + ` accountId=${refreshedSession?.account?.id ?? 'missing'}`
      );
    } catch (error) {
      log(`[browserlessMemberOnboarder] workspace session refresh failed after ${stageLabel} for ${email}: ${error.message}`);
    }
  };

  const materializeAndProbe = async (stageLabel, continuationInviteDetails) => {
    log(`[browserlessMemberOnboarder] materializing accepted invite (${stageLabel}) for ${email}; workspaceId=${workspaceId}`);
    await nextClient.materializeInviteAcceptance(buildInviteAcceptanceContext({
      workspaceId,
      inviteDetails: continuationInviteDetails,
      resolvedWorkspace,
      placementContext,
      email,
    }));
    await refreshWorkspaceSession(stageLabel);
    const membershipState = await runMembershipProbe();
    nextAccountsAfter = membershipState.accountsAfter;
    log(
      `[browserlessMemberOnboarder] membership probe after ${stageLabel} for ${email}:`
      + ` canAccess=${membershipState.canAccessWorkspace}`
      + ` workspaceAccount=${Boolean(membershipState.workspaceAccount)}`
      + ` ownerSeesMember=${membershipState.ownerSeesMember}`
    );
    return membershipState;
  };

  let membershipState = await materializeAndProbe('materialization', nextInviteDetails);

  if (
    !(membershipState.canAccessWorkspace && membershipState.workspaceAccount && membershipState.ownerSeesMember)
    && !hasActualInviteContext({
      inviteDetails: nextInviteDetails,
      workspaceId,
      workspaceName: resolvedWorkspace?.workspaceName ?? placementContext?.workspaceName ?? null,
      email,
    })
    && typeof pollInviteMessage === 'function'
    && agentMailApiKey
    && inviteRequestedAt != null
  ) {
    try {
      log(`[browserlessMemberOnboarder] fetching actual invite context after synthetic materialization for ${email}`);
      const fetchedInviteDetails = await pollInviteMessage({
        inboxId: email,
        apiKey: agentMailApiKey,
        fetchImpl,
        sinceMs: inviteRequestedAt,
      });
      const fetchedWorkspaceId = fetchedInviteDetails?.acceptWorkspaceId ?? fetchedInviteDetails?.workspaceId ?? null;
      if (fetchedWorkspaceId === workspaceId) {
        nextInviteDetails = {
          ...fetchedInviteDetails,
          synthetic: false,
        };
        membershipState = await materializeAndProbe('invite-context continuation', nextInviteDetails);
      } else {
        throw buildWorkspaceInviteMismatchError(email, workspaceId, fetchedWorkspaceId);
      }
    } catch (error) {
      if (error?.blockerReason === 'workspace-account-mismatch') {
        throw error;
      }
      log(`[browserlessMemberOnboarder] actual invite context fetch/continuation failed for ${email}: ${error.message}`);
    }
  }

  return {
    client: nextClient,
    inviteDetails: nextInviteDetails,
    ...membershipState,
  };
}

export async function onboardBrowserlessWorkspaceMember({
  email,
  agentMailApiKey,
  authTraceDir = DEFAULT_TRACE_DIR,
  analyzeAuthTrace = analyzeOpenAiAuthTelemetry,
  replayAuth = replayOpenAiAuthFlow,
  recoverIdentity = recoverBrowserlessIdentity,
  workspaceClientFactory = createBrowserlessWorkspaceClient,
  inviteMember = null,
  ownerClient = null,
  selectedWorkspace = null,
  selectWorkspace = null,
  placementContext = null,
  pollInviteMessage = pollWorkspaceInviteMessage,
  acquireOwnedOAuth = acquireOwnedOpenAiOauth,
  fetchImpl = fetch,
  membershipPollIntervalMs = 1_000,
  membershipTimeoutMs = 15_000,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
}) {
  if (!email || !String(email).includes('@')) {
    throw new Error('onboardBrowserlessWorkspaceMember requires a valid email');
  }
  if (!agentMailApiKey) {
    throw new Error(`onboardBrowserlessWorkspaceMember requires an AgentMail API key for ${email}`);
  }

  const analysis = await analyzeAuthTrace(authTraceDir, { dryRun: true });
  log(`[browserlessMemberOnboarder] analyzed auth trace for ${email}`);
  const preselectedWorkspace = resolveKnownWorkspace({
    selectedWorkspace,
    placementContext,
  });
  let inviteDetails = preselectedWorkspace
    ? {
        workspaceId: preselectedWorkspace.workspaceId,
        acceptWorkspaceId: preselectedWorkspace.workspaceId,
        inviteEmail: email,
        workspaceName: preselectedWorkspace.workspaceName ?? null,
        synthetic: true,
        inviteUrl: buildSyntheticInviteUrl({
          workspaceId: preselectedWorkspace.workspaceId,
          workspaceName: preselectedWorkspace.workspaceName ?? null,
          email,
        }),
      }
    : null;
  let inviteDispatch = null;

  let replay = null;
  try {
    replay = await replayAuth({
      email,
      analysis,
      agentMailApiKey,
      fetchImpl,
    });
    log(`[browserlessMemberOnboarder] replay verdict for ${email}: ${replay?.verdict ?? 'unknown'} (branch=${replay?.branch ?? 'unknown'})`);
    ensureAuthenticatedReplay(replay, email);
  } catch (error) {
    const recoveryFailure = classifyRecoverableReplayFailure(error, email);
    if (!recoveryFailure) {
      throw error;
    }
    const recovery = await recoverIdentity({
      email,
      analysis,
      agentMailApiKey,
      replayAuth,
      analyzeAuthTrace: async () => analysis,
      replayContext: {
        inviteUrl: inviteDetails?.inviteUrl ?? null,
        selectedWorkspace: preselectedWorkspace,
        placementContext,
      },
      fetchImpl,
      failure: recoveryFailure,
    });
    if (recovery?.status !== 'recovered' || recovery?.replay?.verdict !== 'authenticated') {
      if (recovery?.reason || recovery?.blockerReason) {
        throw buildRecoveryFailureError(email, recovery);
      }
      throw error;
    }
    replay = recovery.replay;
    log(`[browserlessMemberOnboarder] recovered ${email} via ${recovery?.branch ?? 'unknown'}`);
  }

  const session = getSessionJson(replay);
  if (!session?.accessToken) throw new Error(`Authenticated replay for ${email} did not expose accessToken`);
  if (!session?.user?.email) throw new Error(`Authenticated replay for ${email} did not expose user.email`);

  const buildClientFromReplay = (nextReplay) => {
    const nextSession = getSessionJson(nextReplay);
    if (!nextSession?.accessToken) {
      throw new Error(`Authenticated replay for ${email} did not expose accessToken`);
    }
    if (!nextSession?.user?.email) {
      throw new Error(`Authenticated replay for ${email} did not expose user.email`);
    }
    return workspaceClientFactory({
      accessToken: nextSession.accessToken,
      accountId: nextSession.account?.id ?? null,
      cookies: nextReplay.finalCookies?.cookies ?? [],
      fetchImpl,
    });
  };

  let client = buildClientFromReplay(replay);

  const [validatedSession, me, accountsBefore, accountCheck, granularConsent] = await Promise.all([
    client.getSession(),
    client.getMe(),
    client.getAccounts(),
    client.getAccountCheck(),
    client.getUserGranularConsent(),
  ]);
  log(`[browserlessMemberOnboarder] session validated for ${email}; personalAccountId=${session.account?.id ?? 'missing'}`);

  if (String(validatedSession?.user?.email ?? '').toLowerCase() !== String(email).toLowerCase()) {
    throw new Error(`Validated session email mismatch for ${email}`);
  }
  if (String(me?.email ?? '').toLowerCase() !== String(email).toLowerCase()) {
    throw new Error(`Bearer identity mismatch for ${email}`);
  }

  let joinResult = null;
  let accountsAfter = accountsBefore;
  let inviteRequestedAt = null;
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

  const intendedWorkspaceId = resolvedWorkspace?.workspaceId ?? placementContext?.workspaceId ?? null;
  const recoverWorkspaceSelection = async ({
    client: currentClient,
    workspaceId: retryWorkspaceId,
    inviteDetails: retryInviteDetails = inviteDetails,
    stageLabel = 'workspace selection',
    originalError = null,
  } = {}) => {
    const attemptWorkspaceSelection = async (targetClient) => {
      await targetClient.selectWorkspace({ workspaceId: retryWorkspaceId });
      return targetClient.getSession();
    };

    try {
      return {
        client: currentClient,
        replay,
        selectedSession: await attemptWorkspaceSelection(currentClient),
      };
    } catch (error) {
      if (!isWorkspaceSelectionRecoveryRetryableError(error)) {
        throw error;
      }

      log(
        `[browserlessMemberOnboarder] restarting auth session after ${stageLabel} for ${email}:`
        + ` workspaceId=${retryWorkspaceId}`
      );

      let refreshedReplay = null;
      try {
        refreshedReplay = await replayAuth({
          email,
          analysis,
          agentMailApiKey,
          fetchImpl,
          inviteUrl: retryInviteDetails?.inviteUrl ?? null,
          selectedWorkspace: resolvedWorkspace ?? preselectedWorkspace,
          placementContext,
        });
        log(
          `[browserlessMemberOnboarder] replay refresh verdict after ${stageLabel} for ${email}:`
          + ` ${refreshedReplay?.verdict ?? 'unknown'} (branch=${refreshedReplay?.branch ?? 'unknown'})`
        );
        ensureAuthenticatedReplay(refreshedReplay, email);
      } catch (refreshError) {
        const recoveryFailure = classifyRecoverableReplayFailure(refreshError, email);
        if (!recoveryFailure) {
          throw buildWorkspaceSelectionRecoveryFailure(email, retryWorkspaceId, refreshError);
        }
        const recovery = await recoverIdentity({
          email,
          analysis,
          agentMailApiKey,
          replayAuth,
          analyzeAuthTrace: async () => analysis,
          replayContext: {
            inviteUrl: retryInviteDetails?.inviteUrl ?? null,
            selectedWorkspace: resolvedWorkspace ?? preselectedWorkspace,
            placementContext,
          },
          fetchImpl,
          failure: recoveryFailure,
        });
        if (recovery?.status !== 'recovered' || recovery?.replay?.verdict !== 'authenticated') {
          if (recovery?.reason || recovery?.blockerReason) {
            throw buildRecoveryFailureError(email, recovery);
          }
          throw buildWorkspaceSelectionRecoveryFailure(email, retryWorkspaceId, refreshError);
        }
        refreshedReplay = recovery.replay;
        log(
          `[browserlessMemberOnboarder] recovered auth session after ${stageLabel} for ${email}`
          + ` via ${recovery?.branch ?? 'unknown'}`
        );
      }

      const refreshedClient = buildClientFromReplay(refreshedReplay);
      const recoveredInviteContext = buildInviteAcceptanceContext({
        workspaceId: retryWorkspaceId,
        inviteDetails: retryInviteDetails,
        resolvedWorkspace,
        placementContext,
        email,
      });
      if (recoveredInviteContext.inviteUrl || recoveredInviteContext.workspaceName || recoveredInviteContext.inviteEmail) {
        await refreshedClient.materializeInviteAcceptance(recoveredInviteContext);
      }

      const selectedSession = await attemptWorkspaceSelection(refreshedClient);
      replay = refreshedReplay;
      return {
        client: refreshedClient,
        replay: refreshedReplay,
        selectedSession,
        recoveredFrom: error ?? originalError ?? null,
      };
    }
  };

  const existingWorkspace = intendedWorkspaceId
    ? findWorkspaceAccount(accountsBefore, intendedWorkspaceId)
    : (accountsBefore?.items ?? []).find((account) => account.structure === 'workspace');
  if (
    existingWorkspace
    && await client.canAccessWorkspace(existingWorkspace.id)
  ) {
    joinResult = { acceptedVia: 'already-member', status: 200, ok: true, body: { success: true } };
    log(`[browserlessMemberOnboarder] ${email} already had workspace access`);
  } else {
    inviteRequestedAt = Date.now();
    log(`[browserlessMemberOnboarder] requesting invite for ${email}`);
    if (inviteMember) {
      let inviteResponse = null;
      if (resolvedWorkspace || placementContext) {
        inviteResponse = await inviteMember(email, {
          workspace: resolvedWorkspace,
          placementContext,
          replay,
          session: validatedSession,
          me,
        });
      } else {
        inviteResponse = await inviteMember(email);
      }
      inviteDispatch = summarizeInviteDispatch(inviteResponse, {
        targetWorkspaceId: resolvedWorkspace?.workspaceId ?? placementContext?.workspaceId ?? null,
      });
      log(`[browserlessMemberOnboarder] invite dispatch for ${email}: ${JSON.stringify(inviteDispatch)}`);
      assertInviteResponseUsable(inviteResponse, email);
    }

    let targetWorkspaceId = resolvedWorkspace?.workspaceId ?? placementContext?.workspaceId ?? null;
    if (targetWorkspaceId) {
      log(`[browserlessMemberOnboarder] bypassing invite email wait for ${email}; using known workspaceId=${targetWorkspaceId}`);
    } else {
      log(`[browserlessMemberOnboarder] polling invite email for ${email}`);
      inviteDetails = await pollInviteMessage({
        inboxId: email,
        apiKey: agentMailApiKey,
        fetchImpl,
        sinceMs: inviteRequestedAt,
      });
      inviteDetails.synthetic = false;
      log(`[browserlessMemberOnboarder] invite email received for ${email}; workspaceId=${inviteDetails.acceptWorkspaceId || inviteDetails.workspaceId || 'unknown'}`);

      const inviteWorkspaceId = inviteDetails.acceptWorkspaceId || inviteDetails.workspaceId;
      if (resolvedWorkspace?.workspaceId && inviteWorkspaceId && inviteWorkspaceId !== resolvedWorkspace.workspaceId) {
        throw buildWorkspaceInviteMismatchError(email, resolvedWorkspace.workspaceId, inviteWorkspaceId);
      }
      targetWorkspaceId = inviteWorkspaceId;
    }

    log(`[browserlessMemberOnboarder] accepting invite for ${email}; workspaceId=${targetWorkspaceId ?? 'missing'}`);
    joinResult = await acceptInviteWithRetry({
      client,
      workspaceId: targetWorkspaceId,
      email,
      sleepImpl,
      timeoutMs: membershipTimeoutMs,
      pollIntervalMs: membershipPollIntervalMs,
      log,
    });
    log(`[browserlessMemberOnboarder] invite accepted for ${email} via ${joinResult.acceptedVia}: ${JSON.stringify(joinResult.body ?? null)}`);
    accountsAfter = await client.getAccounts();
    log(`[browserlessMemberOnboarder] accounts after accept for ${email}: ${JSON.stringify((accountsAfter?.items ?? []).map((account) => ({ id: account.id, structure: account.structure, name: account.name ?? null })))}`);
  }

  const workspaceId = resolvedWorkspace?.workspaceId
    ?? placementContext?.workspaceId
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
  let postAcceptMaterializationAttempted = false;
  let membershipProbeCount = 0;

  while (true) {
    membershipProbeCount += 1;
    ({
      accountsAfter,
      workspaceAccount,
      canAccessWorkspace,
      ownerMembership,
      ownerSeesMember,
    } = await probeMembershipState({
      client,
      workspaceId,
      accountsAfter,
      workspaceAccount,
      ownerClient,
      resolvedWorkspace,
      placementContext,
      email,
      log,
    }));
    log(`[browserlessMemberOnboarder] membership probe for ${email}: canAccess=${canAccessWorkspace} workspaceAccount=${Boolean(workspaceAccount)} ownerSeesMember=${ownerSeesMember}`);

    if (canAccessWorkspace && workspaceAccount && ownerSeesMember) {
      break;
    }
    if (Date.now() >= membershipDeadline) {
      if (membershipTimeoutMs > 0 && membershipProbeCount < 2) {
        await sleepImpl(0);
        continue;
      }
      if (!postAcceptMaterializationAttempted && joinResult?.acceptedVia === 'invites-accept') {
        postAcceptMaterializationAttempted = true;
        ({
          client,
          inviteDetails,
          accountsAfter,
          workspaceAccount,
          canAccessWorkspace,
          ownerMembership,
          ownerSeesMember,
        } = await continueInviteMaterialization({
          client,
          workspaceId,
          accountsAfter,
          inviteDetails,
          ownerClient,
          resolvedWorkspace,
          placementContext,
          email,
          pollInviteMessage,
          agentMailApiKey,
          fetchImpl,
          inviteRequestedAt,
          log,
          recoverWorkspaceSelection,
        }));
        if (canAccessWorkspace && workspaceAccount && ownerSeesMember) {
          break;
        }
      }
      throw buildMembershipMaterializationError({
        email,
        workspaceId,
        acceptedVia: joinResult?.acceptedVia ?? null,
        canAccessWorkspace,
        workspaceAccountObserved: Boolean(workspaceAccount),
        ownerSeesMember,
        postAcceptMaterializationAttempted,
      });
    }
    await sleepImpl(Math.min(membershipPollIntervalMs, Math.max(0, membershipDeadline - Date.now())));
  }

  let selectedSession = validatedSession;
  if (shouldSelectWorkspaceSession({ session: validatedSession, workspaceId })) {
    log(`[browserlessMemberOnboarder] selecting workspace session for ${email}; workspaceId=${workspaceId}`);
    const recoveredSelection = await recoverWorkspaceSelection({
      client,
      workspaceId,
      inviteDetails,
      stageLabel: 'post-invite workspace activation',
    });
    client = recoveredSelection.client;
    replay = recoveredSelection.replay ?? replay;
    selectedSession = recoveredSelection.selectedSession;
    if (String(selectedSession?.user?.email ?? '').toLowerCase() !== String(email).toLowerCase()) {
      throw new Error(`Workspace-selected session email mismatch for ${email}`);
    }
    if (selectedSession?.account?.id !== workspaceId) {
      throw new Error(`Workspace selection did not activate target workspace for ${email}: expected ${workspaceId}, got ${selectedSession?.account?.id ?? 'missing'}`);
    }
  }

  const ownedOAuth = !getRefreshToken(selectedSession)
    && !getRefreshToken(session)
    && typeof acquireOwnedOAuth === 'function'
    ? await acquireOwnedOAuth({
        email,
        workspaceId,
        replay,
        session: selectedSession,
        cookies: typeof client.getCookies === 'function'
          ? client.getCookies()
          : (replay.finalCookies?.cookies ?? []),
        agentMailApiKey,
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
    accessToken: ownedOAuth?.accessToken ?? selectedSession?.accessToken ?? session.accessToken,
    refreshToken: ownedOAuth?.refreshToken ?? getRefreshToken(selectedSession) ?? getRefreshToken(session),
    expiresAt: ownedOAuth?.expiresAt
      ?? (selectedSession?.expires ? new Date(selectedSession.expires).getTime() : (session.expires ? new Date(session.expires).getTime() : null)),
    personalAccountId: session.account?.id ?? null,
    workspaceId,
    workspaceName: inviteDetails?.workspaceName ?? workspaceAccount?.name ?? resolvedWorkspace?.workspaceName ?? placementContext?.workspaceName ?? null,
    accountId: ownedOAuth?.accountId ?? selectedSession?.account?.id ?? workspaceId,
    selectedWorkspace: resolvedWorkspace,
    authBranch: replay.branch,
    joinedVia: joinResult.acceptedVia,
    ownedOAuth,
    inviteDispatch,
    inviteDetails,
    preJoin: {
      session: validatedSession,
      me,
      accounts: accountsBefore,
      accountCheck,
      granularConsent,
    },
    postJoin: {
      session: selectedSession,
      accounts: accountsAfter,
      ownerMembership,
    },
  };
}

export { pollWorkspaceInviteMessage, parseWorkspaceInviteLink };
