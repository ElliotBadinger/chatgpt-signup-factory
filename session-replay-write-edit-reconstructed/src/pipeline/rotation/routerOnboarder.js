import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import puppeteer from 'puppeteer-core';

import {
  buildFillEmailScript,
  handlePostSubmitStateScript,
} from './chatGptAccountCreator.js';
import { registerNewMember, emailToAliasId } from './piAccountRegistrar.js';
import { recoverBrowserlessIdentity as recoverBrowserlessIdentityImpl } from '../authTrace/recoverBrowserlessIdentity.js';
import { onboardBrowserlessWorkspaceMember } from './browserlessMemberOnboarder.js';

const DEFAULT_POOL = 'openai-codex';
const DEFAULT_MODEL = 'gpt-5.4';
const DEFAULT_CHROME = process.env.LOCAL_CHROME_BIN ?? process.env.CHROME_BIN ?? resolveChromePath();
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';
const EMAIL_INPUT_SELECTOR = '#email-input, input[type="email"], input[name="email"], input[autocomplete="email"], input[placeholder*="email" i]';
const OTP_ENTRY_SELECTOR = 'input[maxlength="1"], input[inputmode="numeric"], input[autocomplete="one-time-code"], input[name*="code"], input[placeholder*="code"]';


export function extractRouterAuthFromSession(session, expectedEmail) {
  const accessToken = String(session?.accessToken ?? '').trim();
  if (!accessToken) throw new Error('Session missing accessToken');

  const identityEmail = String(session?.user?.email ?? '').trim();
  if (!identityEmail) throw new Error('Session missing user.email');
  if (expectedEmail && identityEmail.toLowerCase() !== String(expectedEmail).toLowerCase()) {
    throw new Error(`Session email mismatch: expected ${expectedEmail}, got ${identityEmail}`);
  }

  return {
    accessToken,
    expiresAt: session?.expires ? new Date(session.expires).getTime() : null,
    accountId: session?.account?.id ?? null,
    identityEmail,
  };
}

export function verifyPiRouterOnboarding({ aliasId, email, authJsonPath, routerJsonPath, poolName = DEFAULT_POOL }) {
  const auth = JSON.parse(fs.readFileSync(authJsonPath, 'utf8'));
  const router = JSON.parse(fs.readFileSync(routerJsonPath, 'utf8'));
  const checks = {};
  const details = {};

  checks.aliasInAuth = Boolean(auth[aliasId]);
  checks.noTempAliases = !Object.keys(auth).some((k) => k.toLowerCase().includes('openai-codex-tmp'));

  const alias = (router.aliases ?? []).find((a) => a.id === aliasId);
  checks.aliasInRouter = Boolean(alias);
  checks.aliasEmailMatches = String(alias?.email ?? '') === email;
  checks.aliasCloneFromCodex = String(alias?.cloneFrom ?? '') === 'openai-codex';

  const pool = (router.pools ?? []).find((p) => p.name === poolName) ?? { providers: [], routes: [] };
  checks.aliasInPoolProviders = (pool.providers ?? []).includes(aliasId);
  const route = (pool.routes ?? []).find((r) => r.provider === aliasId);
  checks.aliasHasPoolRoute = Boolean(route);

  const payload = decodeJwtPayload(auth[aliasId]?.access ?? '');
  const jwtEmail = payload?.['https://api.openai.com/profile']?.email ?? null;
  const jwtVerified = payload?.['https://api.openai.com/profile']?.email_verified === true;
  checks.jwtIdentityEmailMatches = jwtEmail === email;
  checks.jwtEmailVerified = jwtVerified;

  details.aliasEmail = alias?.email ?? null;
  details.aliasCloneFrom = alias?.cloneFrom ?? null;
  details.routeModel = route?.model ?? null;
  details.identityEmail = jwtEmail;
  details.identitySource = payload ? 'auth-jwt' : 'unknown';
  details.identityEmailVerified = jwtVerified;
  details.metadataMismatch = jwtEmail === email ? 'no' : 'yes';
  details.planType = payload?.['https://api.openai.com/auth']?.chatgpt_plan_type ?? null;

  return { pass: Object.values(checks).every(Boolean), aliasId, email, poolName, checks, details };
}

export async function createStealthBrowserSession() {
  const browser = await puppeteer.launch({
    executablePath: DEFAULT_CHROME,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-features=IsolateOrigins,site-per-process',
      '--lang=en-US,en',
      `--user-agent=${USER_AGENT}`,
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = await browser.newPage();
  await applyStealthPatches(page);
  return {
    page,
    browser,
    cleanup: async () => {
      try { await browser.close(); } catch {}
    },
  };
}

export async function prepareChatGptOtpLogin({ email, createBrowserSession = createStealthBrowserSession }) {
  const session = await createBrowserSession();
  const { page } = session;

  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  await sleep(3_000);
  await page.goto('https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  await sleep(3_000);

  const loginBtn = await page.waitForSelector('::-p-text(Log in), [data-testid="login-button"], [data-testid="signup-button"]', { timeout: 8_000 }).catch(() => null);
  if (loginBtn) {
    const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null);
    await loginBtn.click().catch(() => {});
    await navPromise;
    await sleep(2_000);
  }

  await page.waitForSelector(EMAIL_INPUT_SELECTOR, { timeout: 15_000 });
  const otpRequestedAt = Date.now();
  const fillRes = await page.evaluate(buildFillEmailScript(), email);
  await page.waitForSelector(OTP_ENTRY_SELECTOR + ', input[type="password"]', { timeout: 20_000 }).catch(() => {});

  let state = { state: 'loading', url: page.url() };
  for (let i = 0; i < 8; i++) {
    state = await page.evaluate(handlePostSubmitStateScript);
    if (state.state !== 'loading') break;
    await sleep(1_500);
  }

  if (state.state === 'attempting-email-code') {
    await sleep(4_000);
  }

  return {
    ...session,
    otpRequestedAt,
    fillRes,
    state,
  };
}

export async function completeChatGptOtpLogin({ email, otp, page, cleanup, fillRes = null, state = null }) {
  try {
    let filled = false;
    for (let i = 0; i < 12; i++) {
      filled = await fillOtpInputs(page, otp);
      if (filled) break;
      await sleep(1_500);
    }
    if (!filled) {
      throw new Error(`OTP inputs not found for ${email} at ${page.url()}`);
    }

    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await sleep(8_000);

    const session = await page.evaluate(async () => {
      const response = await fetch('/api/auth/session', { credentials: 'include' });
      return await response.json();
    });

    return {
      finalUrl: page.url(),
      title: await page.title().catch(() => null),
      fillRes,
      state,
      session,
    };
  } finally {
    await cleanup?.().catch(() => {});
  }
}

export async function onboardInboxToPiRouter({
  email,
  apiKey,
  authJsonPath = path.join(os.homedir(), '.pi', 'agent', 'auth.json'),
  routerJsonPath = path.join(os.homedir(), '.pi', 'agent', 'account-router.json'),
  poolName = DEFAULT_POOL,
  modelId = DEFAULT_MODEL,
  fetchImpl = fetch,
  createBrowserSession = createStealthBrowserSession,
  prepareLogin = prepareChatGptOtpLogin,
  completeLogin = completeChatGptOtpLogin,
  browserlessOnboardMember = onboardBrowserlessWorkspaceMember,
  inviteMember = null,
  ownerClient = null,
  placementContext = null,
  authTraceDir = null,
  legacyBrowserFlow = false,
  log = () => {},
}) {
  const aliasId = emailToAliasId(email);

  if (!legacyBrowserFlow && prepareLogin === prepareChatGptOtpLogin && completeLogin === completeChatGptOtpLogin) {
    log(`[routerOnboarder] Starting browserless onboarding for ${email}`);
    const onboarded = await browserlessOnboardMember({
      email,
      agentMailApiKey: apiKey,
      inviteMember,
      ownerClient,
      authTraceDir: authTraceDir ?? undefined,
      fetchImpl,
    });

    const auth = {
      accessToken: onboarded.accessToken,
      expiresAt: onboarded.expiresAt,
      accountId: onboarded.accountId ?? onboarded.workspaceId ?? onboarded.personalAccountId ?? null,
      identityEmail: onboarded.identityEmail,
    };

    log(`[routerOnboarder] Registering ${email} as ${aliasId}`);
    registerNewMember({
      email,
      accessToken: auth.accessToken,
      refreshToken: null,
      expiresAt: auth.expiresAt,
      accountId: auth.accountId,
      poolName,
      modelId,
      authJsonPath,
      routerJsonPath,
      log,
    });

    const verification = verifyPiRouterOnboarding({
      aliasId,
      email,
      authJsonPath,
      routerJsonPath,
      poolName,
    });
    if (!verification.pass) {
      throw new Error(`Router verification failed for ${email}`);
    }

    return { aliasId, email, auth, verification, onboarded };
  }

  log(`[routerOnboarder] Preparing browser login for ${email}`);
  const prepared = await prepareLogin({ email, createBrowserSession });

  log(`[routerOnboarder] Fetching OTP for ${email}`);
  const otp = await pollFreshInboxOtp({
    inboxId: email,
    apiKey,
    fetchImpl,
    sinceMs: Math.max(0, Number(prepared.otpRequestedAt ?? 0) - 5_000),
  });

  log(`[routerOnboarder] Completing browser session for ${email}`);
  const capture = await completeLogin({
    email,
    otp: otp.otp,
    page: prepared.page,
    cleanup: prepared.cleanup,
    fillRes: prepared.fillRes,
    state: prepared.state,
  });

  const auth = extractRouterAuthFromSession(capture.session, email);

  log(`[routerOnboarder] Registering ${email} as ${aliasId}`);
  registerNewMember({
    email,
    accessToken: auth.accessToken,
    refreshToken: null,
    expiresAt: auth.expiresAt,
    accountId: auth.accountId,
    poolName,
    modelId,
    authJsonPath,
    routerJsonPath,
    log,
  });

  const verification = verifyPiRouterOnboarding({
    aliasId,
    email,
    authJsonPath,
    routerJsonPath,
    poolName,
  });
  if (!verification.pass) {
    throw new Error(`Router verification failed for ${email}`);
  }

  return { aliasId, email, otp, capture, auth, verification };
}

async function applyStealthPatches(page) {
  try { await page.setUserAgent(USER_AGENT); } catch {}
  try { await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en' }); } catch {}
  try {
    await page.evaluateOnNewDocument(() => {
      try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
      try { Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' }); } catch {}
      try { window.chrome = window.chrome || { runtime: {} }; } catch {}
    });
  } catch {}
}

async function fillOtpInputs(page, otp) {
  const cells = await page.$$('input[maxlength="1"], input[inputmode="numeric"]');
  if (cells.length >= 6) {
    for (let i = 0; i < 6; i++) {
      await cells[i].click().catch(() => {});
      await cells[i].type(String(otp[i] ?? ''), { delay: 20 }).catch(() => {});
    }
    return true;
  }
  const single = await page.$('input[autocomplete="one-time-code"], input[name*="code"], input[placeholder*="code"]');
  if (single) {
    await single.click().catch(() => {});
    await single.type(String(otp), { delay: 20 }).catch(() => {});
    return true;
  }
  return false;
}

function resolveChromePath() {
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? '/usr/bin/google-chrome';
}

function decodeJwtPayload(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
