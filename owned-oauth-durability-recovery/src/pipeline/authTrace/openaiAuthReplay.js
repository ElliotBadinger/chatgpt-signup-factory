import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { waitForInboundOtp } from './agentMailOtp.js';
import {
  createCookieJar,
  updateCookieJarFromHeader,
  renderCookieHeader,
  snapshotCookies,
} from './httpCookies.js';
import { createOpenAiSentinelProvider } from './openaiSentinelProvider.js';

function parseJsonSafe(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function toDate(now) {
  return typeof now === 'function' ? now() : new Date();
}

function serializeTimestamp(now) {
  return toDate(now).toISOString();
}

function summarizeSession(session) {
  return {
    hasAccessToken: Boolean(session?.accessToken),
    userEmail: session?.user?.email ?? null,
    userId: session?.user?.id ?? null,
    accountId: session?.account?.id ?? null,
    expires: session?.expires ?? null,
    keys: Object.keys(session ?? {}),
  };
}

function bootstrapSigninUrl() {
  return 'https://chatgpt.com/api/auth/signin/openai?prompt=login';
}

function bootstrapBody(csrfToken) {
  return `callbackUrl=https%3A%2F%2Fchatgpt.com%2Fauth%2Flogin_with&csrfToken=${encodeURIComponent(csrfToken)}&json=true`;
}

function getSetCookieHeader(headers) {
  if (typeof headers.getSetCookie === 'function') {
    const values = headers.getSetCookie();
    if (values.length > 0) return values;
  }
  return headers.get('set-cookie');
}

function finalizeHeaders(headers) {
  const result = {};
  for (const [key, value] of headers.entries()) {
    result[key] = value;
  }
  const setCookie = getSetCookieHeader(headers);
  return {
    location: result.location ?? null,
    'set-cookie': Array.isArray(setCookie) ? setCookie.join('\n') : setCookie,
    'content-type': result['content-type'] ?? null,
    'openai-processing-ms': result['openai-processing-ms'] ?? null,
    'openai-version': result['openai-version'] ?? null,
    'x-request-id': result['x-request-id'] ?? null,
    'x-oai-request-id': result['x-oai-request-id'] ?? null,
    'server-timing': result['server-timing'] ?? null,
    'cf-ray': result['cf-ray'] ?? null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseUrlSafe(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function resolveAuthUrl(value, baseUrl = 'https://auth.openai.com/') {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function isTransientFetchError(error) {
  const code = String(error?.code ?? error?.cause?.code ?? '').toUpperCase();
  const message = String(error?.message ?? '');
  return code === 'ETIMEDOUT'
    || code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === 'EAI_AGAIN'
    || error?.name === 'AbortError'
    || /fetch failed/i.test(message)
    || /\bETIMEDOUT\b/i.test(message);
}

async function performRequest({ jar, url, method = 'GET', headers = {}, body, fetchImpl, now, stepName }) {
  if (!url) {
    throw new Error(`performRequest missing url for step ${stepName}`);
  }

  const mergedHeaders = {
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    'accept-language': 'en-US,en;q=0.9',
    ...headers,
  };
  const cookieHeader = renderCookieHeader(jar, url);
  if (cookieHeader) mergedHeaders.cookie = cookieHeader;

  let response;
  let startedAtMs = Date.now();
  let attempts = 0;
  const maxAttempts = 3;
  while (attempts < maxAttempts) {
    attempts += 1;
    startedAtMs = Date.now();
    try {
      const timeoutSignal = typeof AbortSignal?.timeout === 'function'
        ? AbortSignal.timeout(30_000)
        : undefined;
      response = await fetchImpl(url, {
        method,
        headers: mergedHeaders,
        body,
        redirect: 'manual',
        ...(timeoutSignal ? { signal: timeoutSignal } : {}),
      });
      break;
    } catch (error) {
      if (attempts >= maxAttempts || !isTransientFetchError(error)) {
        throw error;
      }
      await sleep(250 * attempts);
    }
  }
  const text = await response.text();
  const elapsedMs = Date.now() - startedAtMs;
  updateCookieJarFromHeader(jar, getSetCookieHeader(response.headers), url);
  const responseJson = parseJsonSafe(text, null);

  return {
    step: {
      name: stepName,
      url,
      method,
      requestedAt: serializeTimestamp(now),
      elapsedMs,
      status: response.status,
      requestHeaders: mergedHeaders,
      requestBody: body ?? null,
      responseHeaders: finalizeHeaders(response.headers),
      responseJson,
      responseTextPreview: text.slice(0, 400),
    },
    responseJson,
    location: response.headers.get('location'),
  };
}

function extractAuthorizeConfig(authorizeUrl) {
  const parsed = parseUrlSafe(authorizeUrl);
  if (!parsed) return null;

  return {
    clientId: parsed.searchParams.get('client_id') ?? null,
    redirectUri: parsed.searchParams.get('redirect_uri') ?? null,
  };
}

function extractAuthorizationCode(continueUrl) {
  const parsed = parseUrlSafe(continueUrl);
  if (!parsed) return null;
  return parsed.searchParams.get('code') ?? null;
}

function mergeSessionWithOAuthTokens(sessionJson, tokenBundle) {
  if (!sessionJson || !tokenBundle?.refreshToken) return sessionJson;
  if (sessionJson.refreshToken || sessionJson.refresh_token) return sessionJson;

  return {
    ...sessionJson,
    refreshToken: tokenBundle.refreshToken,
  };
}

async function exchangeAuthorizationCode({
  jar,
  continueUrl,
  authorizeUrl,
  fetchImpl,
  now,
}) {
  const authorizeConfig = extractAuthorizeConfig(authorizeUrl);
  const authorizationCode = extractAuthorizationCode(continueUrl);
  if (!authorizeConfig?.clientId || !authorizeConfig?.redirectUri || !authorizationCode) {
    return { tokenBundle: null, step: null };
  }

  const url = 'https://auth.openai.com/oauth/token';
  const headers = {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
    origin: 'https://auth.openai.com',
    referer: 'https://auth.openai.com/',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    'accept-language': 'en-US,en;q=0.9',
  };
  const cookieHeader = renderCookieHeader(jar, url);
  if (cookieHeader) headers.cookie = cookieHeader;

  const bodyParams = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: authorizeConfig.clientId,
    code: authorizationCode,
    redirect_uri: authorizeConfig.redirectUri,
  });
  const codeVerifier = extractPkceCodeVerifier(jar);
  if (codeVerifier) {
    bodyParams.set('code_verifier', codeVerifier);
  }
  const body = bodyParams.toString();

  const startedAtMs = Date.now();
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body,
    redirect: 'manual',
  });
  const text = await response.text();
  const elapsedMs = Date.now() - startedAtMs;
  updateCookieJarFromHeader(jar, getSetCookieHeader(response.headers), url);
  const responseJson = parseJsonSafe(text, null);

  const tokenBundle = response.status < 400 && responseJson?.access_token && responseJson?.refresh_token
    ? {
        accessToken: responseJson.access_token,
        refreshToken: responseJson.refresh_token,
        idToken: responseJson.id_token ?? null,
      }
    : null;

  return {
    tokenBundle,
    step: {
      name: 'oauth_token_exchange',
      url,
      method: 'POST',
      requestedAt: serializeTimestamp(now),
      elapsedMs,
      status: response.status,
      requestHeaders: {
        ...headers,
        cookie: headers.cookie ? '[redacted]' : undefined,
      },
      requestBody: '[redacted oauth authorization_code exchange]',
      responseHeaders: finalizeHeaders(response.headers),
      responseJson: responseJson
        ? {
            hasAccessToken: Boolean(responseJson.access_token),
            hasRefreshToken: Boolean(responseJson.refresh_token),
            hasIdToken: Boolean(responseJson.id_token),
            tokenType: responseJson.token_type ?? null,
            error: responseJson.error ?? null,
            errorDescription: responseJson.error_description ?? null,
          }
        : null,
      responseTextPreview: responseJson ? '[redacted oauth token response]' : text.slice(0, 400),
    },
  };
}

function loadPoolEntry(email, poolPath) {
  const parsed = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
  return parsed.entries?.find((entry) => entry.inboxAddress === email || entry.agentMailInboxId === email) ?? null;
}

async function provideOtp({ email, sinceMs, otpProvider, poolPath, fetchImpl, agentMailApiKey }) {
  if (otpProvider) {
    return otpProvider({ email, sinceMs });
  }

  const effectiveApiKey = agentMailApiKey
    ?? loadPoolEntry(email, poolPath || path.join(os.homedir(), '.pi', 'agent', 'codex-inbox-pool.json'))?.rootApiKey
    ?? null;
  if (!effectiveApiKey) {
    throw new Error(`No AgentMail API key available for ${email}`);
  }

  return waitForInboundOtp({
    inboxId: email,
    apiKey: effectiveApiKey,
    sinceMs,
    fetchImpl,
  });
}

function buildAuthorizeUrl(authorizeUrl, email) {
  const url = new URL(authorizeUrl);
  url.searchParams.set('screen_hint', 'login_or_signup');
  url.searchParams.set('login_hint', email);
  return url.toString();
}

function buildReplayResult({ branch, verdict, steps, jar, sessionJson, now, startedAt = null }) {
  const effectiveStartedAt = startedAt
    ?? new Date(steps[0]?.requestedAt ?? serializeTimestamp(now));
  const completedAt = toDate(now);
  return {
    branch,
    verdict,
    startedAt: effectiveStartedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    latencyMs: completedAt.getTime() - effectiveStartedAt.getTime(),
    steps,
    finalCookies: { cookies: snapshotCookies(jar) },
    finalSession: summarizeSession(sessionJson),
  };
}

function createEmptySession() {
  return { hasAccessToken: false, userEmail: null, userId: null, accountId: null, expires: null, keys: [] };
}

export function buildSignupPassword(email) {
  const local = String(email ?? '')
    .split('@')[0]
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 10)
    || 'agent';
  return `Replay!${local}A9`;
}

function buildPasswordResetContinuationBlocker(detail = null) {
  return {
    branch: 'forgot-password',
    verdict: 'blocked',
    blockerReason: 'password-reset-continuation-missing',
    blockerDetail: detail,
  };
}

function resolveSentinelProvider({ sentinelProvider, analysis, fetchImpl, now }) {
  if (sentinelProvider) return sentinelProvider;
  const sentinel = analysis?.report?.sentinel ?? analysis?.sentinel ?? null;
  if (!sentinel) return null;
  return createOpenAiSentinelProvider({ sentinel, fetchImpl, now });
}

function decodeSignedJsonCookie(cookieValue) {
  if (typeof cookieValue !== 'string' || !cookieValue) return null;
  const [payloadSegment] = cookieValue.split('.');
  if (!payloadSegment) return null;

  const candidates = [
    payloadSegment,
    payloadSegment.replace(/-/g, '+').replace(/_/g, '/'),
  ];

  for (const candidate of candidates) {
    try {
      const padded = `${candidate}${'='.repeat((4 - (candidate.length % 4)) % 4)}`;
      return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

function decodeBase64Value(value) {
  if (typeof value !== 'string' || !value) return null;

  const candidates = [
    value,
    value.replace(/-/g, '+').replace(/_/g, '/'),
  ];

  for (const candidate of candidates) {
    try {
      const padded = `${candidate}${'='.repeat((4 - (candidate.length % 4)) % 4)}`;
      return Buffer.from(padded, 'base64').toString('utf8');
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

function extractCodeVerifierFromSessionCookieValue(cookieValue) {
  const decoded = decodeBase64Value(cookieValue);
  if (!decoded) return null;

  const [, verifier] = decoded.split('|');
  const normalizedVerifier = String(verifier ?? '').trim();
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(normalizedVerifier)) {
    return null;
  }

  return normalizedVerifier;
}

function extractPkceCodeVerifier(jar) {
  const cookies = snapshotCookies(jar);
  const directSessionCookie = cookies.find((cookie) => /^oai-session/i.test(String(cookie?.name ?? '')));
  const directVerifier = extractCodeVerifierFromSessionCookieValue(directSessionCookie?.value ?? null);
  if (directVerifier) return directVerifier;

  const hydraRedirectCookie = cookies.find((cookie) => cookie?.name === 'hydra_redirect');
  const hydraPayload = decodeSignedJsonCookie(hydraRedirectCookie?.value ?? null);
  if (!hydraPayload || typeof hydraPayload !== 'object') return null;

  const nestedSessionEntry = Object.entries(hydraPayload)
    .find(([key]) => /^oai-session/i.test(String(key ?? '')));
  if (!nestedSessionEntry) return null;

  return extractCodeVerifierFromSessionCookieValue(nestedSessionEntry[1]);
}

function extractWorkspaceIdFromAuthSessionCookie(jar) {
  const authSessionCookie = snapshotCookies(jar)
    .find((cookie) => cookie?.name === 'oai-client-auth-session')
    ?? null;
  const payload = decodeSignedJsonCookie(authSessionCookie?.value ?? null);
  const workspaces = Array.isArray(payload?.workspaces) ? payload.workspaces : [];
  if (workspaces.length === 0) return null;

  const organizationWorkspace = workspaces.find((workspace) => workspace?.kind === 'organization');
  return organizationWorkspace?.id ?? workspaces[0]?.id ?? null;
}

async function resolveCallbackContinueUrl({ jar, continueUrl, fetchImpl, now, steps }) {
  const currentContinueUrl = String(continueUrl ?? '');
  if (!currentContinueUrl.includes('auth.openai.com/workspace')) {
    return continueUrl;
  }

  const workspacePage = await performRequest({
    jar,
    url: currentContinueUrl,
    fetchImpl,
    now,
    stepName: 'load_workspace_selection',
  });
  steps.push(workspacePage.step);

  const workspaceId = extractWorkspaceIdFromAuthSessionCookie(jar);
  if (!workspaceId) {
    return continueUrl;
  }

  const workspaceSelect = await performRequest({
    jar,
    url: 'https://auth.openai.com/api/accounts/workspace/select',
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      origin: 'https://auth.openai.com',
      referer: 'https://auth.openai.com/workspace',
    },
    body: JSON.stringify({ workspace_id: workspaceId }),
    fetchImpl,
    now,
    stepName: 'workspace_select',
  });
  steps.push(workspaceSelect.step);

  return continueUrlFromResult(workspaceSelect) ?? continueUrl;
}

async function completeCallbackAndSession({ jar, continueUrl, authorizeUrl = null, fetchImpl, now, steps }) {
  const { tokenBundle, step: tokenStep } = await exchangeAuthorizationCode({
    jar,
    continueUrl,
    authorizeUrl,
    fetchImpl,
    now,
  });
  if (tokenStep) {
    steps.push(tokenStep);
  }

  const callbackContinueUrl = await resolveCallbackContinueUrl({
    jar,
    continueUrl,
    fetchImpl,
    now,
    steps,
  });
  const callback = await performRequest({
    jar,
    url: callbackContinueUrl,
    fetchImpl,
    now,
    stepName: 'chatgpt_callback',
  });
  steps.push(callback.step);

  if (callback.location) {
    const callbackRedirect = await performRequest({
      jar,
      url: callback.location,
      fetchImpl,
      now,
      stepName: 'chatgpt_callback_redirect',
    });
    steps.push(callbackRedirect.step);
  }

  const session = await performRequest({
    jar,
    url: 'https://chatgpt.com/api/auth/session',
    headers: { accept: 'application/json', referer: 'https://chatgpt.com/' },
    fetchImpl,
    now,
    stepName: 'chatgpt_session',
  });
  steps.push(session.step);

  const mergedSession = mergeSessionWithOAuthTokens(session.responseJson, tokenBundle);
  session.step.responseJson = mergedSession;
  return mergedSession;
}

function pushHookStep(steps, result) {
  if (Array.isArray(result?.steps)) {
    steps.push(...result.steps);
    return;
  }
  if (result?.step) {
    steps.push(result.step);
  }
}

function continueUrlFromResult(result) {
  return result?.continueUrl
    ?? result?.continue_url
    ?? result?.responseJson?.continue_url
    ?? result?.responseJson?.page?.payload?.url
    ?? result?.responseJson?.page?.payload?.continue_url
    ?? result?.responseJson?.url
    ?? result?.responseHeaders?.location
    ?? result?.step?.responseJson?.continue_url
    ?? result?.step?.responseJson?.page?.payload?.url
    ?? result?.step?.responseHeaders?.location
    ?? null;
}

async function runPasswordLoginBranch({
  email,
  password,
  redirectLocation,
  jar,
  authorizeUrl = null,
  fetchImpl,
  now,
  steps,
  submitPasswordLogin,
  otpProvider,
  poolPath,
  agentMailApiKey,
  allowPasswordlessOtpFallback = true,
}) {
  const passwordPage = await performRequest({
    jar,
    url: redirectLocation,
    fetchImpl,
    now,
    stepName: 'load_password_login',
  });
  steps.push(passwordPage.step);

  let loginResult = null;
  if (typeof submitPasswordLogin === 'function') {
    loginResult = await submitPasswordLogin({
      email,
      password,
      redirectLocation,
      page: passwordPage,
      jar,
      fetchImpl,
      now,
    });
    pushHookStep(steps, loginResult);
  }

  const nextAction = loginResult?.next ?? loginResult?.responseJson?.next ?? null;
  const continueUrl = continueUrlFromResult(loginResult);
  if (continueUrl) {
    const sessionJson = await completeCallbackAndSession({
      jar,
      continueUrl,
      authorizeUrl,
      fetchImpl,
      now,
      steps,
    });

    return {
      branch: 'password-login',
      verdict: sessionJson?.accessToken ? 'authenticated' : 'callback-failed',
      sessionJson,
    };
  }

  if (nextAction === 'forgot-password') {
    return {
      branch: 'password-login',
      verdict: 'forgot-password-required',
      blockerReason: 'forgot-password-required',
    };
  }

  if (!allowPasswordlessOtpFallback) {
    return {
      branch: 'password-login',
      verdict: 'blocked',
      blockerReason: 'password-login-unsupported',
    };
  }

  const passwordlessOtpResult = await runPasswordlessOtpFromPasswordPage({
    email,
    redirectLocation,
    jar,
    authorizeUrl,
    fetchImpl,
    now,
    steps,
    otpProvider,
    poolPath,
    agentMailApiKey,
  });
  if (passwordlessOtpResult.verdict !== 'blocked') {
    return passwordlessOtpResult;
  }

  return {
    branch: 'password-login',
    verdict: 'blocked',
    blockerReason: 'password-login-unsupported',
    blockerDetail: passwordlessOtpResult.blockerReason ?? null,
  };
}

async function runPasswordlessOtpFromPasswordPage({
  email,
  redirectLocation,
  jar,
  authorizeUrl = null,
  fetchImpl,
  now,
  steps,
  otpProvider,
  poolPath,
  agentMailApiKey,
}) {
  const otpSinceMs = toDate(now).getTime();
  let sendOtp;
  try {
    sendOtp = await performRequest({
      jar,
      url: 'https://auth.openai.com/api/accounts/passwordless/send-otp',
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        origin: 'https://auth.openai.com',
        referer: redirectLocation,
      },
      fetchImpl,
      now,
      stepName: 'passwordless_send_otp_from_password',
    });
  } catch {
    return {
      branch: 'password-login',
      verdict: 'blocked',
      blockerReason: 'passwordless-otp-unsupported',
    };
  }
  steps.push(sendOtp.step);

  if (sendOtp.step.status >= 400) {
    return {
      branch: 'password-login',
      verdict: 'blocked',
      blockerReason: 'passwordless-otp-unsupported',
    };
  }

  const emailVerificationUrl = continueUrlFromResult(sendOtp) ?? sendOtp.location ?? 'https://auth.openai.com/email-verification';
  let emailVerification;
  try {
    emailVerification = await performRequest({
      jar,
      url: emailVerificationUrl,
      fetchImpl,
      now,
      stepName: 'load_email_verification_from_password',
    });
  } catch {
    return {
      branch: 'password-login',
      verdict: 'blocked',
      blockerReason: 'passwordless-otp-unsupported',
    };
  }
  steps.push(emailVerification.step);

  const otpResult = await provideOtp({
    email,
    sinceMs: otpSinceMs,
    otpProvider,
    poolPath,
    fetchImpl,
    agentMailApiKey,
  });
  const otpCode = otpResult?.otp ?? otpResult?.code ?? null;
  if (!otpCode) {
    return {
      branch: 'password-login',
      verdict: 'blocked',
      blockerReason: 'passwordless-otp-missing',
    };
  }

  let validate;
  try {
    validate = await performRequest({
      jar,
      url: 'https://auth.openai.com/api/accounts/email-otp/validate',
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        origin: 'https://auth.openai.com',
        referer: 'https://auth.openai.com/email-verification',
      },
      body: JSON.stringify({ code: otpCode }),
      fetchImpl,
      now,
      stepName: 'email_otp_validate_from_password',
    });
  } catch {
    return {
      branch: 'password-login',
      verdict: 'blocked',
      blockerReason: 'passwordless-otp-unsupported',
    };
  }
  steps.push(validate.step);

  const continueUrl = continueUrlFromResult(validate);
  if (!continueUrl) {
    return {
      branch: 'password-login',
      verdict: 'blocked',
      blockerReason: 'passwordless-otp-unsupported',
    };
  }

  const sessionJson = await completeCallbackAndSession({
    jar,
    continueUrl,
    authorizeUrl,
    fetchImpl,
    now,
    steps,
  });

  return {
    branch: 'password-login',
    verdict: sessionJson?.accessToken ? 'authenticated' : 'callback-failed',
    sessionJson,
  };
}

async function runForgotPasswordBranch({
  email,
  password,
  redirectLocation,
  jar,
  authorizeUrl = null,
  fetchImpl,
  now,
  steps,
  submitPasswordLogin,
  initiateForgotPassword,
  consumeResetEmail,
  completeForgotPassword,
  otpProvider,
  poolPath,
  agentMailApiKey,
  sentinelProvider = null,
}) {
  const passwordResult = await runPasswordLoginBranch({
    email,
    password,
    redirectLocation,
    jar,
    authorizeUrl,
    fetchImpl,
    now,
    steps,
    submitPasswordLogin,
    otpProvider,
    poolPath,
    agentMailApiKey,
    allowPasswordlessOtpFallback: false,
  });

  if (passwordResult.verdict === 'authenticated') {
    return {
      branch: 'forgot-password',
      verdict: 'authenticated',
      sessionJson: passwordResult.sessionJson,
    };
  }

  const shouldAttemptResetContinuation = passwordResult.verdict === 'forgot-password-required'
    || passwordResult.verdict === 'blocked';
  if (!shouldAttemptResetContinuation) {
    return buildPasswordResetContinuationBlocker(passwordResult.blockerReason ?? passwordResult.verdict ?? 'password-login-blocked');
  }

  const initiateForgotPasswordImpl = initiateForgotPassword ?? defaultInitiateForgotPassword;
  const consumeResetEmailImpl = consumeResetEmail ?? defaultConsumeResetEmail;
  const completeForgotPasswordImpl = completeForgotPassword ?? defaultCompleteForgotPassword;

  let initiateResult;
  try {
    initiateResult = await initiateForgotPasswordImpl({
      email,
      redirectLocation,
      jar,
      fetchImpl,
      now,
    });
  } catch (error) {
    return buildPasswordResetContinuationBlocker(String(error?.message ?? error));
  }
  pushHookStep(steps, initiateResult);
  if ((initiateResult?.step?.status ?? initiateResult?.steps?.at(-1)?.status ?? 0) >= 400) {
    return buildPasswordResetContinuationBlocker('password-reset-send-otp-failed');
  }

  let resetEmailResult;
  try {
    resetEmailResult = await consumeResetEmailImpl({
      email,
      initiateResult,
      jar,
      fetchImpl,
      now,
      otpProvider,
      poolPath,
      agentMailApiKey,
    });
  } catch (error) {
    return buildPasswordResetContinuationBlocker(String(error?.message ?? error));
  }
  pushHookStep(steps, resetEmailResult);
  if ((resetEmailResult?.step?.status ?? resetEmailResult?.steps?.at(-1)?.status ?? 0) >= 400) {
    return buildPasswordResetContinuationBlocker('password-reset-otp-validation-failed');
  }

  let completeResult;
  try {
    completeResult = await completeForgotPasswordImpl({
      email,
      resetUrl: resetEmailResult?.resetUrl ?? null,
      newPassword: password,
      initiateResult,
      resetEmailResult,
      jar,
      fetchImpl,
      now,
      sentinelProvider,
    });
  } catch (error) {
    return buildPasswordResetContinuationBlocker(String(error?.message ?? error));
  }
  pushHookStep(steps, completeResult);
  if ((completeResult?.step?.status ?? completeResult?.steps?.at(-1)?.status ?? 0) >= 400) {
    return buildPasswordResetContinuationBlocker('password-reset-complete-failed');
  }

  const continueUrl = continueUrlFromResult(completeResult);
  if (!continueUrl) {
    return buildPasswordResetContinuationBlocker('forgot-password-continue-url-missing');
  }

  const sessionJson = await completeCallbackAndSession({
    jar,
    continueUrl,
    authorizeUrl,
    fetchImpl,
    now,
    steps,
  });

  return {
    branch: 'forgot-password',
    verdict: sessionJson?.accessToken ? 'authenticated' : 'callback-failed',
    sessionJson,
  };
}

export async function defaultInitiateForgotPassword({
  redirectLocation,
  jar,
  fetchImpl,
  now,
}) {
  const resetUrl = 'https://auth.openai.com/reset-password';
  const resetPage = await performRequest({
    jar,
    url: resetUrl,
    fetchImpl,
    now,
    stepName: 'load_reset_password',
  });

  const sendOtp = await performRequest({
    jar,
    url: 'https://auth.openai.com/api/accounts/password/send-otp',
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      origin: 'https://auth.openai.com',
      referer: resetUrl,
    },
    fetchImpl,
    now,
    stepName: 'password_reset_send_otp',
  });

  return {
    steps: [resetPage.step, sendOtp.step],
    resetUrl,
    continueUrl: resolveAuthUrl(continueUrlFromResult(sendOtp), resetUrl),
    responseJson: sendOtp.responseJson,
    otpSinceMs: Date.parse(sendOtp.step.requestedAt),
  };
}

export async function defaultConsumeResetEmail({
  email,
  initiateResult,
  jar,
  fetchImpl,
  now,
  otpProvider,
  poolPath,
  agentMailApiKey,
}) {
  const emailVerificationUrl = resolveAuthUrl(
    continueUrlFromResult(initiateResult),
    initiateResult?.resetUrl ?? 'https://auth.openai.com/reset-password',
  ) ?? 'https://auth.openai.com/email-verification';
  const emailVerification = await performRequest({
    jar,
    url: emailVerificationUrl,
    fetchImpl,
    now,
    stepName: 'load_password_reset_email_verification',
  });

  const otpResult = await provideOtp({
    email,
    sinceMs: initiateResult?.otpSinceMs ?? toDate(now).getTime(),
    otpProvider,
    poolPath,
    fetchImpl,
    agentMailApiKey,
  });
  const otpCode = otpResult?.otp ?? otpResult?.code ?? null;
  if (!otpCode) {
    throw new Error(`Password reset OTP provider did not return an otp for ${email}`);
  }

  const validate = await performRequest({
    jar,
    url: 'https://auth.openai.com/api/accounts/email-otp/validate',
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      origin: 'https://auth.openai.com',
      referer: 'https://auth.openai.com/email-verification',
    },
    body: JSON.stringify({ code: otpCode }),
    fetchImpl,
    now,
    stepName: 'email_otp_validate_password_reset',
  });

  const resetUrl = resolveAuthUrl(
    continueUrlFromResult(validate),
    emailVerificationUrl,
  );
  if (!resetUrl) {
    return {
      steps: [emailVerification.step, validate.step],
      resetUrl: null,
      responseJson: validate.responseJson,
    };
  }

  const resetPasswordPage = await performRequest({
    jar,
    url: resetUrl,
    fetchImpl,
    now,
    stepName: 'load_password_reset_new_password',
  });

  return {
    steps: [emailVerification.step, validate.step, resetPasswordPage.step],
    resetUrl,
    responseJson: validate.responseJson,
  };
}

async function maybeBuildSentinelHeaders({ sentinelProvider, requestPath, steps }) {
  if (!sentinelProvider) return {};
  try {
    const sentinelHeaders = await sentinelProvider.buildHeadersForPath(requestPath);
    pushHookStep(steps, sentinelHeaders);
    return sentinelHeaders.headers ?? {};
  } catch {
    return {};
  }
}

export async function defaultCompleteForgotPassword({
  resetUrl,
  newPassword,
  jar,
  fetchImpl,
  now,
  sentinelProvider,
}) {
  const requestPath = String(resetUrl ?? '').includes('post_login_add_password')
    ? '/api/accounts/password/add'
    : '/api/accounts/password/reset';
  const endpointUrl = `https://auth.openai.com${requestPath}`;
  const steps = [];
  const sentinelHeaders = await maybeBuildSentinelHeaders({ sentinelProvider, requestPath, steps });
  const complete = await performRequest({
    jar,
    url: endpointUrl,
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      origin: 'https://auth.openai.com',
      referer: resetUrl ?? 'https://auth.openai.com/reset-password/new-password',
      ...sentinelHeaders,
    },
    body: JSON.stringify({ password: newPassword }),
    fetchImpl,
    now,
    stepName: 'complete_password_reset',
  });
  steps.push(complete.step);

  return {
    steps,
    responseJson: complete.responseJson,
    continueUrl: continueUrlFromResult(complete),
  };
}

export async function deriveOpenAiAuthorizeRedirect({
  email,
  fetchImpl = fetch,
  now = null,
}) {
  if (!email || !String(email).includes('@')) {
    throw new Error('deriveOpenAiAuthorizeRedirect requires a valid email');
  }

  const jar = createCookieJar();
  const steps = [];

  const loginWith = await performRequest({
    jar,
    url: 'https://chatgpt.com/auth/login_with',
    fetchImpl,
    now,
    stepName: 'bootstrap_login_with',
  });
  steps.push(loginWith.step);

  const providers = await performRequest({
    jar,
    url: 'https://chatgpt.com/api/auth/providers',
    fetchImpl,
    now,
    stepName: 'bootstrap_providers',
  });
  steps.push(providers.step);

  const csrf = await performRequest({
    jar,
    url: 'https://chatgpt.com/api/auth/csrf',
    fetchImpl,
    now,
    stepName: 'bootstrap_csrf',
  });
  steps.push(csrf.step);

  const signin = await performRequest({
    jar,
    url: bootstrapSigninUrl(),
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: bootstrapBody(csrf.responseJson?.csrfToken ?? ''),
    fetchImpl,
    now,
    stepName: 'bootstrap_signin_openai',
  });
  steps.push(signin.step);

  const authorizeUrl = buildAuthorizeUrl(signin.responseJson?.url, email);
  const authorize = await performRequest({
    jar,
    url: authorizeUrl,
    fetchImpl,
    now,
    stepName: 'authorize_with_login_hint',
  });
  steps.push(authorize.step);

  return {
    authorizeUrl,
    redirectLocation: authorize.location ?? null,
    steps,
    finalCookies: { cookies: snapshotCookies(jar) },
  };
}

export async function replayOpenAiAuthFlow({
  email,
  mode = 'auto',
  inviteUrl = null,
  fetchImpl = fetch,
  otpProvider = null,
  poolPath = null,
  now = null,
  sentinelProvider = null,
  analysis = null,
  agentMailApiKey = null,
  password = null,
  profileName = 'Codex Agent',
  birthdate = '2003-03-15',
  allowPasswordlessOtpFallback = true,
  submitPasswordLogin = null,
  initiateForgotPassword = null,
  consumeResetEmail = null,
  completeForgotPassword = null,
}) {
  if (!email || !String(email).includes('@')) {
    throw new Error('replayOpenAiAuthFlow requires a valid email');
  }

  const startedAt = null;
  const jar = createCookieJar();
  const steps = [];

  if (inviteUrl) {
    const inviteBootstrap = await performRequest({
      jar,
      url: inviteUrl,
      fetchImpl,
      now,
      stepName: 'preload_invite_url',
    });
    steps.push(inviteBootstrap.step);
  }

  const loginWith = await performRequest({
    jar,
    url: 'https://chatgpt.com/auth/login_with',
    fetchImpl,
    now,
    stepName: 'bootstrap_login_with',
  });
  steps.push(loginWith.step);

  const providers = await performRequest({
    jar,
    url: 'https://chatgpt.com/api/auth/providers',
    fetchImpl,
    now,
    stepName: 'bootstrap_providers',
  });
  steps.push(providers.step);

  const csrf = await performRequest({
    jar,
    url: 'https://chatgpt.com/api/auth/csrf',
    fetchImpl,
    now,
    stepName: 'bootstrap_csrf',
  });
  steps.push(csrf.step);

  const signin = await performRequest({
    jar,
    url: bootstrapSigninUrl(),
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: bootstrapBody(csrf.responseJson?.csrfToken ?? ''),
    fetchImpl,
    now,
    stepName: 'bootstrap_signin_openai',
  });
  steps.push(signin.step);

  const authorizeUrl = buildAuthorizeUrl(signin.responseJson?.url, email);
  const existingLoginOtpSinceMs = toDate(now).getTime();
  const authorize = await performRequest({
    jar,
    url: authorizeUrl,
    fetchImpl,
    now,
    stepName: 'authorize_with_login_hint',
  });
  steps.push(authorize.step);

  const redirectLocation = authorize.location;
  if (!redirectLocation) {
    return {
      ...buildReplayResult({
        branch: 'unknown',
        verdict: 'authorize-missing-redirect',
        steps,
        jar,
        sessionJson: null,
        now,
        startedAt,
      }),
      finalSession: createEmptySession(),
    };
  }

  if (redirectLocation.includes('/email-verification')) {
    const emailVerification = await performRequest({
      jar,
      url: redirectLocation,
      fetchImpl,
      now,
      stepName: 'load_email_verification',
    });
    steps.push(emailVerification.step);

    const otpResult = await provideOtp({
      email,
      sinceMs: existingLoginOtpSinceMs,
      otpProvider,
      poolPath,
      fetchImpl,
      agentMailApiKey,
    });
    const otpCode = otpResult?.otp ?? otpResult?.code ?? null;
    if (!otpCode) {
      throw new Error(`OTP provider did not return an otp for ${email}`);
    }

    const validate = await performRequest({
      jar,
      url: 'https://auth.openai.com/api/accounts/email-otp/validate',
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        origin: 'https://auth.openai.com',
        referer: 'https://auth.openai.com/email-verification',
      },
      body: JSON.stringify({ code: otpCode }),
      fetchImpl,
      now,
      stepName: 'email_otp_validate',
    });
    steps.push(validate.step);

    const sessionJson = await completeCallbackAndSession({
      jar,
      continueUrl: continueUrlFromResult(validate),
      authorizeUrl,
      fetchImpl,
      now,
      steps,
    });

    return buildReplayResult({
      branch: 'existing-login-otp',
      verdict: sessionJson?.accessToken ? 'authenticated' : 'callback-failed',
      steps,
      jar,
      sessionJson,
      now,
      startedAt,
    });
  }

  if (redirectLocation.includes('/log-in/password')) {
    const branchResult = mode === 'forgot-password'
      ? await runForgotPasswordBranch({
          email,
          password,
          redirectLocation,
          jar,
          authorizeUrl,
          fetchImpl,
          now,
          steps,
          submitPasswordLogin,
          initiateForgotPassword,
          consumeResetEmail,
          completeForgotPassword,
          otpProvider,
          poolPath,
          agentMailApiKey,
          sentinelProvider: resolveSentinelProvider({ sentinelProvider, analysis, fetchImpl, now }),
        })
      : await runPasswordLoginBranch({
          email,
          password,
          redirectLocation,
          jar,
          authorizeUrl,
          fetchImpl,
          now,
          steps,
          submitPasswordLogin,
          otpProvider,
          poolPath,
          agentMailApiKey,
          allowPasswordlessOtpFallback,
        });

    return {
      ...buildReplayResult({
        branch: branchResult.branch,
        verdict: branchResult.verdict,
        steps,
        jar,
        sessionJson: branchResult.sessionJson ?? null,
        now,
        startedAt,
      }),
      blockerReason: branchResult.blockerReason ?? null,
    };
  }

  if (redirectLocation.includes('/create-account/password')) {
    const passwordPage = await performRequest({
      jar,
      url: redirectLocation,
      fetchImpl,
      now,
      stepName: 'load_create_account_password',
    });
    steps.push(passwordPage.step);

    const effectiveSentinelProvider = resolveSentinelProvider({ sentinelProvider, analysis, fetchImpl, now });
    if (!effectiveSentinelProvider) {
      return {
        ...buildReplayResult({
          branch: 'signup-new',
          verdict: 'needs-sentinel-provider',
          steps,
          jar,
          sessionJson: null,
          now,
          startedAt,
        }),
        unmetPrerequisite: 'sentinel-provider',
        finalSession: createEmptySession(),
      };
    }

    const registerSentinel = await effectiveSentinelProvider.buildHeadersForPath('/api/accounts/user/register');
    steps.push(registerSentinel.step);

    const register = await performRequest({
      jar,
      url: 'https://auth.openai.com/api/accounts/user/register',
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        origin: 'https://auth.openai.com',
        referer: 'https://auth.openai.com/create-account/password',
        ...registerSentinel.headers,
      },
      body: JSON.stringify({
        password: password ?? buildSignupPassword(email),
        username: email,
      }),
      fetchImpl,
      now,
      stepName: 'user_register',
    });
    steps.push(register.step);

    const signupOtpSinceMs = toDate(now).getTime();
    const emailOtpSend = await performRequest({
      jar,
      url: register.responseJson?.continue_url ?? 'https://auth.openai.com/api/accounts/email-otp/send',
      fetchImpl,
      now,
      stepName: 'email_otp_send',
    });
    steps.push(emailOtpSend.step);

    const emailVerification = await performRequest({
      jar,
      url: emailOtpSend.location ?? 'https://auth.openai.com/email-verification',
      fetchImpl,
      now,
      stepName: 'load_email_verification',
    });
    steps.push(emailVerification.step);

    const otpResult = await provideOtp({
      email,
      sinceMs: signupOtpSinceMs,
      otpProvider,
      poolPath,
      fetchImpl,
      agentMailApiKey,
    });
    const otpCode = otpResult?.otp ?? otpResult?.code ?? null;
    if (!otpCode) {
      throw new Error(`OTP provider did not return an otp for ${email}`);
    }

    const validate = await performRequest({
      jar,
      url: 'https://auth.openai.com/api/accounts/email-otp/validate',
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        origin: 'https://auth.openai.com',
        referer: 'https://auth.openai.com/email-verification',
      },
      body: JSON.stringify({ code: otpCode }),
      fetchImpl,
      now,
      stepName: 'email_otp_validate',
    });
    steps.push(validate.step);

    const aboutYou = await performRequest({
      jar,
      url: continueUrlFromResult(validate),
      fetchImpl,
      now,
      stepName: 'load_about_you',
    });
    steps.push(aboutYou.step);

    const createAccountSentinel = await effectiveSentinelProvider.buildHeadersForPath('/api/accounts/create_account');
    steps.push(createAccountSentinel.step);

    const createAccount = await performRequest({
      jar,
      url: 'https://auth.openai.com/api/accounts/create_account',
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        origin: 'https://auth.openai.com',
        referer: 'https://auth.openai.com/about-you',
        ...createAccountSentinel.headers,
      },
      body: JSON.stringify({
        name: profileName,
        birthdate,
      }),
      fetchImpl,
      now,
      stepName: 'create_account',
    });
    steps.push(createAccount.step);

    const sessionJson = await completeCallbackAndSession({
      jar,
      continueUrl: continueUrlFromResult(createAccount),
      fetchImpl,
      now,
      steps,
    });

    return buildReplayResult({
      branch: 'signup-new',
      verdict: sessionJson?.accessToken ? 'authenticated' : 'callback-failed',
      steps,
      jar,
      sessionJson,
      now,
      startedAt,
    });
  }

  return {
    ...buildReplayResult({
      branch: mode === 'auto' ? 'unknown' : mode,
      verdict: 'unsupported-authorize-redirect',
      steps,
      jar,
      sessionJson: null,
      now,
      startedAt,
    }),
    finalSession: createEmptySession(),
  };
}
