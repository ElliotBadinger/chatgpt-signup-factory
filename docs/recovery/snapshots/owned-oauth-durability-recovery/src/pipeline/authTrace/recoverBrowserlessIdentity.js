import { analyzeOpenAiAuthTelemetry } from './openaiAuthTelemetryAnalysis.js';
import { replayOpenAiAuthFlow } from './openaiAuthReplay.js';
import { renderCookieHeader, updateCookieJarFromHeader } from './httpCookies.js';

function getSessionFromReplay(replay) {
  if (replay?.session?.accessToken) return replay.session;
  return replay?.steps?.find((step) => step.name === 'chatgpt_session')?.responseJson ?? null;
}

function getRefreshToken(value) {
  if (typeof value?.refreshToken === 'string') return value.refreshToken;
  if (typeof value?.refresh_token === 'string') return value.refresh_token;
  return null;
}

function extractAuthFromReplay(replay, email) {
  const session = getSessionFromReplay(replay);
  if (!session?.accessToken) return null;

  return {
    accessToken: session.accessToken,
    refreshToken: getRefreshToken(session),
    expiresAt: session.expires ? new Date(session.expires).getTime() : null,
    accountId: session.account?.id ?? null,
    identityEmail: session.user?.email ?? replay?.finalSession?.userEmail ?? email,
  };
}

function classifyAttempt(branch, replay, error) {
  if (error) {
    return {
      branch,
      verdict: 'blocked',
      reason: String(error?.message ?? error),
      error,
    };
  }

  const verdict = replay?.verdict ?? 'unknown';
  const reason = replay?.reason ?? replay?.blockerReason ?? verdict;
  return { branch, verdict, reason, replay };
}

function summarizeAttempts(attempts) {
  return attempts.map((attempt) => ({
    branch: attempt.branch,
    verdict: attempt.verdict,
    reason: attempt.reason ?? null,
  }));
}

function buildRecoveredResult(branch, replay, email, attempts) {
  return {
    status: 'recovered',
    branch,
    auth: extractAuthFromReplay(replay, email),
    replay,
    attempts: summarizeAttempts(attempts),
  };
}

function buildTerminalResult(status, reason, attempts) {
  return {
    status,
    reason,
    attempts: summarizeAttempts(attempts),
  };
}

function deterministicPasswordForEmail(email) {
  const local = String(email ?? '')
    .split('@')[0]
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 10)
    || 'agent';
  return `Replay!${local}A9`;
}

function shouldSkipExistingLoginAttempt(failure = null) {
  const message = String(failure?.message ?? failure?.reason ?? failure?.blockerReason ?? '');
  return message.includes('NO_EMAIL_CODE_OPTION')
    || message.includes('/log-in/password')
    || message.includes('Timed out waiting for AgentMail message')
    || failure?.branch === 'password-login'
    || failure?.blockerReason === 'password-login-unsupported';
}

const DEFAULT_AUTH_RECOVERY_ORDER = [
  'existing-login-otp',
  'password-login',
  'forgot-password',
  'password-init',
];

function buildRecoveryBranchPlan({
  email,
  analysis,
  agentMailApiKey,
  fetchImpl,
  replayContext = null,
  replayAuth,
  runExistingLogin,
  runPasswordLogin,
  runForgotPassword,
  runPasswordInit,
  authRecoveryOrder = DEFAULT_AUTH_RECOVERY_ORDER,
  failure = null,
} = {}) {
  const branches = new Map();

  if (!shouldSkipExistingLoginAttempt(failure)) {
    branches.set('existing-login-otp', {
      branch: 'existing-login-otp',
      run: runExistingLogin ?? ((context) => replayAuth({
        email: context.email,
        mode: 'existing-login-otp',
        analysis: context.analysis,
        agentMailApiKey: context.agentMailApiKey,
        fetchImpl: context.fetchImpl,
        inviteUrl: context.inviteUrl ?? null,
        selectedWorkspace: context.selectedWorkspace ?? null,
        placementContext: context.placementContext ?? null,
      })),
    });
  }

  branches.set('password-login', {
    branch: 'password-login',
    run: runPasswordLogin ?? ((context) => replayAuth({
      email: context.email,
      mode: 'password-login',
      analysis: context.analysis,
      agentMailApiKey: context.agentMailApiKey,
      fetchImpl: context.fetchImpl,
      password: deterministicPasswordForEmail(context.email),
      submitPasswordLogin: submitOpenAiPasswordLogin,
      inviteUrl: context.inviteUrl ?? null,
      selectedWorkspace: context.selectedWorkspace ?? null,
      placementContext: context.placementContext ?? null,
    })),
  });
  branches.set('forgot-password', {
    branch: 'forgot-password',
    run: runForgotPassword ?? ((context) => replayAuth({
      email: context.email,
      mode: 'forgot-password',
      analysis: context.analysis,
      agentMailApiKey: context.agentMailApiKey,
      fetchImpl: context.fetchImpl,
      password: deterministicPasswordForEmail(context.email),
      submitPasswordLogin: submitOpenAiPasswordLogin,
      inviteUrl: context.inviteUrl ?? null,
      selectedWorkspace: context.selectedWorkspace ?? null,
      placementContext: context.placementContext ?? null,
    })),
  });
  if (typeof runPasswordInit === 'function') {
    branches.set('password-init', {
      branch: 'password-init',
      run: runPasswordInit,
    });
  }

  const order = Array.isArray(authRecoveryOrder) && authRecoveryOrder.length > 0
    ? authRecoveryOrder
    : DEFAULT_AUTH_RECOVERY_ORDER;

  return order
    .map((branch) => branches.get(branch))
    .filter(Boolean);
}

function setCookieHeader(headers, value) {
  if (!value) return headers;
  return {
    ...headers,
    cookie: value,
  };
}

export async function submitOpenAiPasswordLogin({ email, password, redirectLocation, jar, fetchImpl, now }) {
  const url = 'https://auth.openai.com/api/accounts/password/login';
  const headers = setCookieHeader({
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    'accept-language': 'en-US,en;q=0.9',
    origin: 'https://auth.openai.com',
    referer: redirectLocation,
  }, renderCookieHeader(jar, redirectLocation));
  const startedAt = Date.now();
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: email, password }),
    redirect: 'manual',
  });
  const text = await response.text();
  const responseSetCookieHeader = typeof response.headers?.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : response.headers?.get?.('set-cookie') ?? null;
  updateCookieJarFromHeader(jar, responseSetCookieHeader, url);

  let responseJson = null;
  try {
    responseJson = text ? JSON.parse(text) : null;
  } catch {
    responseJson = null;
  }

  return {
    step: {
      name: 'submit_password_login',
      url,
      method: 'POST',
      requestedAt: new Date(typeof now === 'function' ? now() : Date.now()).toISOString(),
      elapsedMs: Date.now() - startedAt,
      status: response.status,
      requestHeaders: headers,
      requestBody: JSON.stringify({ username: email }),
      responseHeaders: {
        location: response.headers.get('location'),
        'set-cookie': responseSetCookieHeader,
        'content-type': response.headers.get('content-type'),
      },
      responseJson,
      responseTextPreview: text.slice(0, 400),
    },
    responseJson,
  };
}

export async function recoverBrowserlessIdentity({
  email,
  agentMailApiKey = null,
  analysis = null,
  authTraceDir = null,
  replayContext = null,
  replayAuth = replayOpenAiAuthFlow,
  analyzeAuthTrace = analyzeOpenAiAuthTelemetry,
  runExistingLogin = null,
  runPasswordLogin = null,
  runForgotPassword = null,
  runPasswordInit = null,
  authRecoveryOrder = DEFAULT_AUTH_RECOVERY_ORDER,
  fetchImpl = fetch,
  failure = null,
} = {}) {
  if (!email || !String(email).includes('@')) {
    throw new Error('recoverBrowserlessIdentity requires a valid email');
  }

  const effectiveAnalysis = analysis ?? (authTraceDir ? await analyzeAuthTrace(authTraceDir, { dryRun: true }) : null);
  const attempts = [];

  const branches = buildRecoveryBranchPlan({
    email,
    analysis: effectiveAnalysis,
    agentMailApiKey,
    fetchImpl,
    replayContext,
    replayAuth,
    runExistingLogin,
    runPasswordLogin,
    runForgotPassword,
    runPasswordInit,
    authRecoveryOrder,
    failure,
  });

  for (const candidate of branches) {
    try {
      const replay = await candidate.run({
        email,
        analysis: effectiveAnalysis,
        agentMailApiKey,
        fetchImpl,
        ...(replayContext ?? {}),
        replayContext,
      });
      const attempt = classifyAttempt(candidate.branch, replay, null);
      attempts.push(attempt);

      if (replay?.verdict === 'authenticated') {
        return buildRecoveredResult(candidate.branch, replay, email, attempts);
      }
    } catch (error) {
      attempts.push(classifyAttempt(candidate.branch, null, error));
    }
  }

  const resetContinuationAttempt = [...attempts].reverse().find((attempt) => (
    attempt.reason === 'password-reset-continuation-missing'
  ));
  if (resetContinuationAttempt) {
    return buildTerminalResult('blocked', resetContinuationAttempt.reason, attempts);
  }

  const recreateAttempt = [...attempts].reverse().find((attempt) => (
    attempt.verdict === 'recreate-needed'
    || attempt.reason === 'password-init-required'
    || attempt.reason === 'password-init-not-implemented'
    || attempt.reason === 'reset-not-available'
  ));
  if (recreateAttempt) {
    return buildTerminalResult('recreate-needed', recreateAttempt.reason, attempts);
  }

  const blockedAttempt = [...attempts].reverse().find((attempt) => attempt.verdict === 'blocked' || attempt.error);
  return buildTerminalResult('blocked', blockedAttempt?.reason ?? 'browserless-recovery-exhausted', attempts);
}
