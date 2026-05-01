import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { pollFreshInboxOtp } from './agentMailOtp.js';
import { isResendReceivingAddress, pollResendReceivedOtp } from './resendReceiving.js';
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

  const startedAtMs = Date.now();
  const response = await fetchImpl(url, {
    method,
    headers: mergedHeaders,
    body,
    redirect: 'manual',
  });
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

function loadPoolEntry(email, poolPath) {
  const parsed = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
  return parsed.entries?.find((entry) => entry.inboxAddress === email || entry.agentMailInboxId === email) ?? null;
}

async function provideOtp({ email, sinceMs, otpProvider, poolPath, fetchImpl, agentMailApiKey, resendApiKey }) {
  if (otpProvider) {
    return otpProvider({ email, sinceMs });
  }

  if (isResendReceivingAddress(email)) {
    return pollResendReceivedOtp({
      email,
      apiKey: resendApiKey,
      sinceMs,
      fetchImpl,
    });
  }

  const effectiveApiKey = agentMailApiKey
    ?? loadPoolEntry(email, poolPath || path.join(os.homedir(), '.pi', 'agent', 'codex-inbox-pool.json'))?.rootApiKey
    ?? null;
  if (!effectiveApiKey) {
    throw new Error(`No AgentMail API key available for ${email}`);
  }

  return pollFreshInboxOtp({
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

function buildSignupPassword(email) {
  const local = String(email ?? '')
    .split('@')[0]
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 10)
    || 'agent';
  return `Replay!${local}A9`;
}

function resolveSentinelProvider({ sentinelProvider, analysis, fetchImpl, now }) {
  if (sentinelProvider) return sentinelProvider;
  const sentinel = analysis?.report?.sentinel ?? analysis?.sentinel ?? null;
  if (!sentinel) return null;
  return createOpenAiSentinelProvider({ sentinel, fetchImpl, now });
}

async function completeCallbackAndSession({ jar, continueUrl, fetchImpl, now, steps }) {
  const callback = await performRequest({
    jar,
    url: continueUrl,
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

  return session.responseJson;
}

function pushHookStep(steps, result) {
  if (result?.step) {
    steps.push(result.step);
  }
}

function continueUrlFromResult(result) {
  return result?.continueUrl ?? result?.continue_url ?? result?.responseJson?.continue_url ?? null;
}

async function runPasswordLoginBranch({
  email,
  password,
  redirectLocation,
  jar,
  fetchImpl,
  now,
  steps,
  submitPasswordLogin,
}) {
  const passwordPage = await performRequest({
    jar,
    url: redirectLocation,
    fetchImpl,
    now,
    stepName: 'load_password_login',
  });
  steps.push(passwordPage.step);

  if (typeof submitPasswordLogin !== 'function') {
    return {
      branch: 'password-login',
      verdict: 'blocked',
      blockerReason: 'password-login-unsupported',
    };
  }

  const loginResult = await submitPasswordLogin({
    email,
    password,
    redirectLocation,
    page: passwordPage,
    jar,
    fetchImpl,
    now,
  });
  pushHookStep(steps, loginResult);

  const nextAction = loginResult?.next ?? loginResult?.responseJson?.next ?? null;
  if (nextAction === 'forgot-password') {
    return {
      branch: 'password-login',
      verdict: 'forgot-password-required',
      blockerReason: 'forgot-password-required',
    };
  }

  const continueUrl = continueUrlFromResult(loginResult);
  if (!continueUrl) {
    return {
      branch: 'password-login',
      verdict: 'blocked',
      blockerReason: 'password-login-unsupported',
    };
  }

  const sessionJson = await completeCallbackAndSession({
    jar,
    continueUrl,
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
  fetchImpl,
  now,
  steps,
  submitPasswordLogin,
  initiateForgotPassword,
  consumeResetEmail,
  completeForgotPassword,
}) {
  const passwordResult = await runPasswordLoginBranch({
    email,
    password,
    redirectLocation,
    jar,
    fetchImpl,
    now,
    steps,
    submitPasswordLogin,
  });

  if (passwordResult.verdict === 'authenticated') {
    return {
      branch: 'forgot-password',
      verdict: 'authenticated',
      sessionJson: passwordResult.sessionJson,
    };
  }

  if (passwordResult.verdict !== 'forgot-password-required') {
    return {
      branch: 'forgot-password',
      verdict: 'blocked',
      blockerReason: 'forgot-password-unsupported',
    };
  }

  if (typeof initiateForgotPassword !== 'function' || typeof consumeResetEmail !== 'function' || typeof completeForgotPassword !== 'function') {
    return {
      branch: 'forgot-password',
      verdict: 'blocked',
      blockerReason: 'forgot-password-unsupported',
    };
  }

  const initiateResult = await initiateForgotPassword({
    email,
    redirectLocation,
    jar,
    fetchImpl,
    now,
  });
  pushHookStep(steps, initiateResult);

  const resetEmailResult = await consumeResetEmail({
    email,
    initiateResult,
    jar,
    fetchImpl,
    now,
  });
  pushHookStep(steps, resetEmailResult);

  const completeResult = await completeForgotPassword({
    email,
    resetUrl: resetEmailResult?.resetUrl ?? null,
    newPassword: password,
    initiateResult,
    resetEmailResult,
    jar,
    fetchImpl,
    now,
  });
  pushHookStep(steps, completeResult);

  const continueUrl = continueUrlFromResult(completeResult);
  if (!continueUrl) {
    return {
      branch: 'forgot-password',
      verdict: 'blocked',
      blockerReason: 'forgot-password-unsupported',
    };
  }

  const sessionJson = await completeCallbackAndSession({
    jar,
    continueUrl,
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

export async function replayOpenAiAuthFlow({
  email,
  mode = 'auto',
  fetchImpl = fetch,
  otpProvider = null,
  poolPath = null,
  now = null,
  sentinelProvider = null,
  analysis = null,
  agentMailApiKey = null,
  resendApiKey = null,
  password = null,
  profileName = 'Codex Agent',
  birthdate = '2003-03-15',
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
      resendApiKey,
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
      continueUrl: validate.responseJson?.continue_url,
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
    if (mode === 'existing-login-otp') {
      const passwordPage = await performRequest({
        jar,
        url: redirectLocation,
        fetchImpl,
        now,
        stepName: 'load_password_login',
      });
      steps.push(passwordPage.step);

      const otpSinceMs = toDate(now).getTime();
      const emailOtpSend = await performRequest({
        jar,
        url: 'https://auth.openai.com/api/accounts/email-otp/send',
        headers: {
          accept: 'application/json',
          origin: 'https://auth.openai.com',
          referer: redirectLocation,
        },
        fetchImpl,
        now,
        stepName: 'email_otp_send_from_password_login',
      });
      steps.push(emailOtpSend.step);

      if (emailOtpSend.location) {
        const emailVerification = await performRequest({
          jar,
          url: emailOtpSend.location,
          fetchImpl,
          now,
          stepName: 'load_email_verification_from_password_login',
        });
        steps.push(emailVerification.step);
      }

      const otpResult = await provideOtp({
        email,
        sinceMs: otpSinceMs,
        otpProvider,
        poolPath,
        fetchImpl,
        agentMailApiKey,
        resendApiKey,
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
        stepName: 'email_otp_validate_from_password_login',
      });
      steps.push(validate.step);

      const sessionJson = await completeCallbackAndSession({
        jar,
        continueUrl: validate.responseJson?.continue_url,
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

    const branchResult = mode === 'forgot-password'
      ? await runForgotPasswordBranch({
          email,
          password,
          redirectLocation,
          jar,
          fetchImpl,
          now,
          steps,
          submitPasswordLogin,
          initiateForgotPassword,
          consumeResetEmail,
          completeForgotPassword,
        })
      : await runPasswordLoginBranch({
          email,
          password,
          redirectLocation,
          jar,
          fetchImpl,
          now,
          steps,
          submitPasswordLogin,
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
      resendApiKey,
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
      url: validate.responseJson?.continue_url,
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
      continueUrl: createAccount.responseJson?.continue_url,
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
