import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadTracePairs, loadCheckpoints } from './traceArtifactLoader.js';
import { inferActualScenario } from './analysis.js';

const DEFAULT_BOOTSTRAP_SEQUENCE = [
  {
    name: 'bootstrap_login_with',
    method: 'GET',
    url: 'https://chatgpt.com/auth/login_with',
  },
  {
    name: 'bootstrap_providers',
    method: 'GET',
    url: 'https://chatgpt.com/api/auth/providers',
  },
  {
    name: 'bootstrap_csrf',
    method: 'GET',
    url: 'https://chatgpt.com/api/auth/csrf',
  },
  {
    name: 'bootstrap_signin_openai',
    method: 'POST',
    url: 'https://chatgpt.com/api/auth/signin/openai?prompt=login',
    contentType: 'application/x-www-form-urlencoded',
    bodyTemplate: 'callbackUrl=https%3A%2F%2Fchatgpt.com%2Fauth%2Flogin_with&csrfToken={{csrfToken}}&json=true',
  },
];

function parseJsonSafe(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function parsePreviewJson(body) {
  if (!body?.preview) return null;
  return parseJsonSafe(body.preview, null);
}

function parseRequestJson(request) {
  return parseJsonSafe(request?.postData, null);
}

function sortedKeys(value) {
  return Object.keys(value ?? {}).sort();
}

function findPair(pairs, matcher) {
  return pairs.find((pair) => matcher(pair)) ?? null;
}

function findPairs(pairs, matcher) {
  return pairs.filter((pair) => matcher(pair));
}

function getPath(url) {
  return new URL(url).pathname;
}

function getQueryKeys(url) {
  return [...new URL(url).searchParams.keys()];
}

function pickSentinelRequestHeaders(headers = {}) {
  const picked = {};
  for (const key of ['referer', 'user-agent', 'accept-language', 'content-type', 'accept']) {
    if (headers[key] != null) picked[key] = headers[key];
  }
  return picked;
}

function extractSentinelHeaderInfo(pairs) {
  const sentinelReqPairs = findPairs(
    pairs,
    (pair) => pair.request.url === 'https://sentinel.openai.com/backend-api/sentinel/req',
  );

  const flowMap = new Map();
  const requestTemplates = {};
  for (const pair of sentinelReqPairs) {
    const requestBody = parseRequestJson(pair.request) ?? {};
    const responseBody = parsePreviewJson(pair.response?.body) ?? {};
    const flow = String(requestBody.flow ?? '').trim();
    if (!flow) continue;
    flowMap.set(flow, {
      flow,
      requestBodyKeys: sortedKeys(requestBody),
      responseKeys: sortedKeys(responseBody),
    });
    if (!requestTemplates[flow]) {
      requestTemplates[flow] = {
        method: pair.request.method ?? 'POST',
        url: pair.request.url,
        headers: pickSentinelRequestHeaders(pair.request.headers),
        body: requestBody,
      };
    }
  }

  const requiredHeaders = new Set();
  const headerFlows = [];
  const headerTemplates = {};
  const authPairs = findPairs(
    pairs,
    (pair) => new URL(pair.request.url).hostname === 'auth.openai.com',
  );
  for (const pair of authPairs) {
    for (const [headerName, value] of Object.entries(pair.request.headers ?? {})) {
      if (!headerName.toLowerCase().includes('sentinel')) continue;
      requiredHeaders.add(headerName);
      const parsedValue = parseJsonSafe(value, {});
      const requestPath = getPath(pair.request.url);
      headerFlows.push({
        headerName,
        flow: parsedValue.flow ?? null,
        keys: sortedKeys(parsedValue),
        path: requestPath,
      });
      headerTemplates[requestPath] = headerTemplates[requestPath] ?? {};
      headerTemplates[requestPath][headerName] = parsedValue;
    }
  }

  return {
    flows: [...flowMap.values()],
    requiredHeaders: [...requiredHeaders].sort(),
    headerFlows,
    requestTemplates,
    headerTemplates,
  };
}

function buildExistingLoginOtpPlan() {
  return {
    branch: 'existing-login-otp',
    description: 'Blank-jar ChatGPT bootstrap, authorize with login_hint, OTP validate, ChatGPT callback, session verification.',
    sequence: [
      ...DEFAULT_BOOTSTRAP_SEQUENCE,
      {
        name: 'authorize_with_login_hint',
        method: 'GET',
        source: 'signin_openai.responseJson.url',
        transform: 'set screen_hint=login_or_signup and login_hint={{email}}',
      },
      {
        name: 'load_email_verification',
        method: 'GET',
        source: 'authorize_with_login_hint.responseHeaders.location',
      },
      {
        name: 'email_otp_validate',
        method: 'POST',
        url: 'https://auth.openai.com/api/accounts/email-otp/validate',
        contentType: 'application/json',
        bodyTemplate: '{"code":"{{otp}}"}',
      },
      {
        name: 'chatgpt_callback',
        method: 'GET',
        source: 'email_otp_validate.responseJson.continue_url',
      },
      {
        name: 'chatgpt_session',
        method: 'GET',
        url: 'https://chatgpt.com/api/auth/session',
      },
    ],
  };
}

function buildSignupPlan(signupReport) {
  return {
    branch: 'signup-new',
    description: 'Auth-side signup branch derived from golden trace; requires dynamic sentinel headers before register and create_account.',
    sequence: [
      ...DEFAULT_BOOTSTRAP_SEQUENCE,
      {
        name: 'authorize_with_login_hint',
        method: 'GET',
        source: 'signin_openai.responseJson.url',
        transform: 'set screen_hint=login_or_signup and login_hint={{email}}',
      },
      {
        name: 'load_create_account_password',
        method: 'GET',
        source: 'authorize_with_login_hint.responseHeaders.location',
      },
      {
        name: 'sentinel_req_username_password_create',
        method: 'POST',
        url: 'https://sentinel.openai.com/backend-api/sentinel/req',
        dynamicRequirement: 'sentinel-header-provider',
      },
      {
        name: 'user_register',
        method: 'POST',
        url: 'https://auth.openai.com/api/accounts/user/register',
        contentType: 'application/json',
        bodyKeys: signupReport.register.bodyKeys,
      },
      {
        name: 'email_otp_send',
        method: 'GET',
        url: 'https://auth.openai.com/api/accounts/email-otp/send',
      },
      {
        name: 'email_otp_validate',
        method: 'POST',
        url: 'https://auth.openai.com/api/accounts/email-otp/validate',
        contentType: 'application/json',
        bodyKeys: signupReport.emailOtpValidate.bodyKeys,
      },
      {
        name: 'load_about_you',
        method: 'GET',
        source: 'email_otp_validate.responseJson.continue_url',
      },
      {
        name: 'sentinel_req_oauth_create_account',
        method: 'POST',
        url: 'https://sentinel.openai.com/backend-api/sentinel/req',
        dynamicRequirement: 'sentinel-header-provider',
      },
      {
        name: 'create_account',
        method: 'POST',
        url: 'https://auth.openai.com/api/accounts/create_account',
        contentType: 'application/json',
        bodyKeys: signupReport.createAccount.bodyKeys,
      },
      {
        name: 'chatgpt_callback',
        method: 'GET',
        source: 'create_account.responseJson.continue_url',
      },
      {
        name: 'chatgpt_session',
        method: 'GET',
        url: 'https://chatgpt.com/api/auth/session',
      },
    ],
  };
}

function buildReport({ traceDir, actualScenario, signupReport, sentinel }) {
  return {
    traceDir,
    generatedAt: new Date().toISOString(),
    actualScenario,
    signup: signupReport,
    existingLoginOtp: {
      browserlessCapable: true,
      expectedAuthorizeRedirects: [
        'https://auth.openai.com/email-verification',
        signupReport.authorize.redirectLocation,
      ],
      notes: 'Blank-jar ChatGPT bootstrap can be followed by authorize+login_hint. Existing accounts redirect to email-verification and can complete via OTP validate + ChatGPT callback.',
    },
    sentinel,
  };
}

export async function analyzeOpenAiAuthTelemetry(traceDir, options = {}) {
  const { dryRun = false } = options;
  const [pairs, checkpoints] = await Promise.all([
    loadTracePairs(traceDir),
    loadCheckpoints(traceDir),
  ]);

  const authorizePair = findPair(pairs, (pair) => getPath(pair.request.url) === '/api/accounts/authorize');
  const registerPair = findPair(pairs, (pair) => getPath(pair.request.url) === '/api/accounts/user/register');
  const emailOtpSendPair = findPair(pairs, (pair) => getPath(pair.request.url) === '/api/accounts/email-otp/send');
  const emailOtpValidatePair = findPair(pairs, (pair) => getPath(pair.request.url) === '/api/accounts/email-otp/validate');
  const createAccountPair = findPair(pairs, (pair) => getPath(pair.request.url) === '/api/accounts/create_account');

  const registerBody = parseRequestJson(registerPair?.request) ?? {};
  const registerResponse = parsePreviewJson(registerPair?.response?.body) ?? {};
  const emailOtpValidateBody = parseRequestJson(emailOtpValidatePair?.request) ?? {};
  const emailOtpValidateResponse = parsePreviewJson(emailOtpValidatePair?.response?.body) ?? {};
  const createAccountBody = parseRequestJson(createAccountPair?.request) ?? {};
  const createAccountResponse = parsePreviewJson(createAccountPair?.response?.body) ?? {};

  const sentinel = extractSentinelHeaderInfo(pairs);

  const signupReport = {
    authorize: {
      url: authorizePair?.request.url ?? null,
      queryKeys: authorizePair ? getQueryKeys(authorizePair.request.url) : [],
      redirectLocation: authorizePair?.response?.headers?.location ?? null,
    },
    register: {
      bodyKeys: sortedKeys(registerBody),
      continueUrl: registerResponse.continue_url ?? null,
      sentinelHeader: 'openai-sentinel-token',
    },
    emailOtpSend: {
      redirectLocation: emailOtpSendPair?.response?.headers?.location ?? null,
    },
    emailOtpValidate: {
      bodyKeys: sortedKeys(emailOtpValidateBody),
      continueUrl: emailOtpValidateResponse.continue_url ?? null,
    },
    createAccount: {
      bodyKeys: sortedKeys(createAccountBody),
      continueUrl: createAccountResponse.continue_url ?? null,
      sentinelHeaders: ['openai-sentinel-token', 'openai-sentinel-so-token'],
    },
  };

  const actualScenario = inferActualScenario(checkpoints);
  const report = buildReport({ traceDir, actualScenario, signupReport, sentinel });
  const plan = {
    sourceTraceDir: traceDir,
    generatedAt: new Date().toISOString(),
    existingLoginOtp: buildExistingLoginOtpPlan(),
    signup: buildSignupPlan(signupReport),
  };

  if (!dryRun) {
    await Promise.all([
      writeFile(path.join(traceDir, 'openai-auth-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
      writeFile(path.join(traceDir, 'openai-auth-plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8'),
    ]);
  }

  return { report, plan };
}
