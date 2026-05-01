import { analyzeOpenAiAuthTelemetry } from './openaiAuthTelemetryAnalysis.js';
import { replayOpenAiAuthFlow } from './openaiAuthReplay.js';
import { renderCookieHeader, updateCookieJarFromHeader } from './httpCookies.js';

function getSessionFromReplay(replay) {
  if (replay?.session?.accessToken) return replay.session;
  return replay?.steps?.find((step) => step.name === 'chatgpt_session')?.responseJson ?? null;
}

function extractAuthFromReplay(replay, email) {
  const session = getSessionFromReplay(replay);
  if (!session?.accessToken) return null;

  return {
    accessToken: session.accessToken,
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function runWithTransientRetry(fn, context, { maxAttempts = 3 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(context);
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientFetchError(error)) {
        throw error;
      }
      await sleep(1_000 * attempt);
    }
  }
  throw new Error('unreachable recovery retry state');
}

function setCookieHeader(headers, value) {
  if (!value) return headers;
  return {
    ...headers,
    cookie: value,
  };
}

async function submitOpenAiPasswordLogin({ email, password, redirectLocation, jar, fetchImpl, now }) {
  const url = 'https://auth.openai.com/api/accounts/password/login';
  const headers = setCookieHeader({
    accept: 'application/json',
    'content-type': 'application/json',
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
  updateCookieJarFromHeader(jar, response.headers, url);

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
        'set-cookie': response.headers.get('set-cookie'),
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
  resendApiKey = null,
  analysis = null,
  authTraceDir = null,
  replayAuth = replayOpenAiAuthFlow,
  analyzeAuthTrace = analyzeOpenAiAuthTelemetry,
  runExistingLogin = null,
  runPasswordLogin = null,
  runForgotPassword = null,
  runPasswordInit = null,
  fetchImpl = fetch,
} = {}) {
  if (!email || !String(email).includes('@')) {
    throw new Error('recoverBrowserlessIdentity requires a valid email');
  }

  const effectiveAnalysis = analysis ?? (authTraceDir ? await analyzeAuthTrace(authTraceDir, { dryRun: true }) : null);
  const attempts = [];

  const branches = [
    {
      branch: 'existing-login-otp',
      run: runExistingLogin ?? ((context) => replayAuth({
        email: context.email,
        mode: 'existing-login-otp',
        analysis: context.analysis,
        agentMailApiKey: context.agentMailApiKey,
        resendApiKey: context.resendApiKey,
        fetchImpl: context.fetchImpl,
      })),
    },
    {
      branch: 'password-login',
      run: runPasswordLogin ?? ((context) => replayAuth({
        email: context.email,
        mode: 'password-login',
        analysis: context.analysis,
        agentMailApiKey: context.agentMailApiKey,
        resendApiKey: context.resendApiKey,
        fetchImpl: context.fetchImpl,
        password: deterministicPasswordForEmail(context.email),
        submitPasswordLogin: submitOpenAiPasswordLogin,
      })),
    },
    {
      branch: 'forgot-password',
      run: runForgotPassword ?? ((context) => replayAuth({
        email: context.email,
        mode: 'forgot-password',
        analysis: context.analysis,
        agentMailApiKey: context.agentMailApiKey,
        resendApiKey: context.resendApiKey,
        fetchImpl: context.fetchImpl,
      })),
    },
    {
      branch: 'password-init',
      run: runPasswordInit ?? (async () => ({
        verdict: 'recreate-needed',
        reason: 'password-init-not-implemented',
      })),
    },
  ];

  for (const candidate of branches) {
    try {
      const replay = await runWithTransientRetry(candidate.run, {
        email,
        analysis: effectiveAnalysis,
        agentMailApiKey,
        resendApiKey,
        fetchImpl,
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
