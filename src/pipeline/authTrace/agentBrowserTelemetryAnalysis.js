import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildBootstrapAnalysis } from './cdpLive/bootstrapAnalysis.js';

function parseJsonSafe(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function readJson(filePath, fallback = null) {
  try {
    return parseJsonSafe(await readFile(filePath, 'utf8'), fallback);
  } catch {
    return fallback;
  }
}

async function readJsonl(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return raw.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function readText(filePath, fallback = '') {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

function splitSetCookie(value = '') {
  return String(value || '').split('\n').map((part) => part.trim()).filter(Boolean);
}

function parseSetCookie(cookieLine) {
  const [pair, ...attrs] = cookieLine.split(';').map((part) => part.trim()).filter(Boolean);
  if (!pair || !pair.includes('=')) return null;
  const [name, ...valueParts] = pair.split('=');
  const cookie = {
    name,
    value: valueParts.join('='),
    domain: null,
    path: '/',
    secure: false,
    httpOnly: false,
    sameSite: null,
  };
  for (const attr of attrs) {
    const [rawKey, ...rawValue] = attr.split('=');
    const key = rawKey.toLowerCase();
    const attrValue = rawValue.join('=');
    if (key === 'domain') cookie.domain = attrValue.replace(/^\./, '');
    else if (key === 'path') cookie.path = attrValue || '/';
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') cookie.sameSite = attrValue || null;
  }
  return cookie;
}

function upsertCookies(requests) {
  const jar = new Map();
  for (const request of requests) {
    for (const cookieLine of splitSetCookie(request.responseHeaders?.['set-cookie'])) {
      const parsed = parseSetCookie(cookieLine);
      if (!parsed) continue;
      if (!parsed.domain) {
        try {
          parsed.domain = new URL(request.url).hostname;
        } catch {
          parsed.domain = 'unknown';
        }
      }
      jar.set(`${parsed.domain}|${parsed.path}|${parsed.name}`, parsed);
    }
  }
  return [...jar.values()];
}

function extractCsrfToken(csrfRequest, cookies) {
  const fromBody = parseJsonSafe(csrfRequest?.responseBody?.text, null)?.csrfToken;
  if (fromBody) return fromBody;
  const csrfCookie = cookies.find((cookie) => cookie.name === '__Host-next-auth.csrf-token');
  return csrfCookie?.value?.split('|')[0] ?? null;
}

function findFirst(requests, matcher) {
  return requests.find((request) => matcher.test(request.url || '')) ?? null;
}

function buildPlan({ runDir, requests, cookies, csrfToken }) {
  const loginWith = findFirst(requests, /chatgpt\.com\/auth\/login_with/i);
  const providers = findFirst(requests, /chatgpt\.com\/api\/auth\/providers/i);
  const csrf = findFirst(requests, /chatgpt\.com\/api\/auth\/csrf/i);
  const signin = findFirst(requests, /chatgpt\.com\/api\/auth\/signin\/openai/i);
  const authorize = requests.find((request) => /auth\.openai\.com\/api\/accounts\/authorize/i.test(request.url || '') && /prompt=login/i.test(request.url || '')) ?? null;

  const sequence = [
    loginWith && { name: 'login_with', method: loginWith.method, url: loginWith.url },
    providers && { name: 'providers', method: providers.method, url: providers.url },
    csrf && { name: 'csrf', method: csrf.method, url: csrf.url },
    signin && {
      name: 'signin_openai',
      method: signin.method,
      url: signin.url,
      bodyTemplate: 'callbackUrl=https%3A%2F%2Fchatgpt.com%2Fauth%2Flogin_with&csrfToken={{csrfToken}}&json=true',
      contentType: 'application/x-www-form-urlencoded',
    },
    authorize && { name: 'authorize_prompt_login', method: authorize.method, url: authorize.url, usePreviousJsonUrl: true },
  ].filter(Boolean);

  return {
    sourceRunDir: runDir,
    generatedAt: new Date().toISOString(),
    csrfToken,
    cookieJar: { cookies },
    sequence,
  };
}

export async function analyzeAgentBrowserTelemetry(runDir, options = {}) {
  const requests = await readJsonl(path.join(runDir, 'critical-requests.jsonl'));
  const recorderSummary = await readJson(path.join(runDir, 'recorder-summary.json'), {});
  const urlHistory = (await readText(path.join(runDir, 'url-history.txt'))).split('\n').map((line) => line.trim()).filter(Boolean);
  const cookies = upsertCookies(requests);
  const csrfRequest = findFirst(requests, /chatgpt\.com\/api\/auth\/csrf/i);
  const csrfToken = extractCsrfToken(csrfRequest, cookies);
  const bootstrap = buildBootstrapAnalysis({
    criticalRequests: requests,
    jsExceptions: recorderSummary.jsExceptions ?? [],
    challengeSignals: recorderSummary.challengeSignals ?? [],
  });

  const loginWith = findFirst(requests, /chatgpt\.com\/auth\/login_with/i);
  const challengeRequests = requests.filter((request) => /cdn-cgi\/challenge-platform/i.test(request.url || ''));
  const signin = findFirst(requests, /chatgpt\.com\/api\/auth\/signin\/openai/i);

  const report = {
    runDir,
    generatedAt: new Date().toISOString(),
    loginWith,
    bootstrap: {
      likelyFailurePoint: bootstrap.likelyFailurePoint,
      restartedLogin: !!bootstrap.restartedLogin,
      followUpFailures: bootstrap.followUpFailures,
    },
    cloudflare: {
      challengeRequestCount: challengeRequests.length,
      clearanceCookiePresent: cookies.some((cookie) => cookie.name === 'cf_clearance'),
      challengeRequests,
    },
    nextAuth: {
      csrfToken,
      csrfCookiePresent: cookies.some((cookie) => cookie.name === '__Host-next-auth.csrf-token'),
      stateCookiePresent: cookies.some((cookie) => cookie.name === '__Secure-next-auth.state'),
      signinRequest: signin,
    },
    cookieJar: {
      cookieCount: cookies.length,
      cookieNames: cookies.map((cookie) => cookie.name),
    },
    urlHistory,
    recorderSummary,
  };

  const plan = buildPlan({ runDir, requests, cookies, csrfToken });

  if (!options.dryRun) {
    await writeFile(path.join(runDir, 'agent-browser-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(path.join(runDir, 'browserless-bootstrap-plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  }

  return { report, plan };
}
