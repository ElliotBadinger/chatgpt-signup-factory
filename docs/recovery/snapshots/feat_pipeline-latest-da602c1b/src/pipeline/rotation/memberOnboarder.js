/**
 * memberOnboarder.js
 *
 * Chrome/Xvfb automation that:
 *  1. Opens the ChatGPT invite link received via email
 *  2. Creates a new ChatGPT account (or logs in to an existing one)
 *  3. Accepts the team invite
 *  4. Captures the OAuth tokens from the session for pi registration
 *
 * Uses the proven OTP-based signup flow from prior Wave 0 experiment.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import puppeteer from 'puppeteer-core';

import { pollKvOtp } from './teamDriver.js';

const EMAIL_KV_NAMESPACE_ID = '99275c7d53424a72b29ea8340910f2bb';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RANDOM_NAMES = [
  ['Alex', 'Rivera'], ['Sam', 'Jordan'], ['Morgan', 'Lee'], ['Taylor', 'Kim'],
  ['Riley', 'Park'], ['Casey', 'Chen'], ['Jamie', 'Torres'], ['Jordan', 'Wong'],
  ['Blake', 'Nguyen'], ['Quinn', 'Patel'], ['Avery', 'Garcia'], ['Drew', 'Martinez'],
];

function randomName() {
  return RANDOM_NAMES[Math.floor(Math.random() * RANDOM_NAMES.length)];
}

function randomPassword() {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$';
  return Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function launchChrome(profileDir, port) {
  await mkdir(profileDir, { recursive: true });
  const proc = spawn(
    'xvfb-run',
    [
      '-a',
      '/usr/bin/google-chrome-stable',
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let browser = null;
  const deadline = Date.now() + 30_000;
  while (!browser && Date.now() < deadline) {
    try {
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    } catch {
      await sleep(1_000);
    }
  }
  if (!browser) throw new Error(`Chrome not available at port ${port} after 30s`);
  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  return { browser, page, proc };
}

async function fillOtpInputs(page, otp) {
  const inputs = await page.$$('input[maxlength="1"], input[inputmode="numeric"]');
  if (inputs.length >= 6) {
    for (let i = 0; i < 6; i++) await inputs[i].type(otp[i]);
    return true;
  }
  const single = await page.$('input[autocomplete="one-time-code"], input[name*="code"], input[placeholder*="code"]');
  if (single) {
    await single.type(otp);
    return true;
  }
  // Fallback: type into any visible input
  const first = await page.$('input:not([type="hidden"])');
  if (first) {
    await first.type(otp);
    return true;
  }
  return false;
}

/**
 * Extract OAuth credentials from the browser session after ChatGPT authentication.
 */
async function captureOAuthCredentials(page, { log = () => {} } = {}) {
  // Method 1: intercept the token storage via JS
  const creds = await page.evaluate(async () => {
    // Try to get from __NEXT_DATA__ or window.__reactFiber
    const nextData = window.__NEXT_DATA__;
    if (nextData?.props?.pageProps?.user) {
      return { source: 'next-data', user: nextData.props.pageProps.user };
    }

    // Try sessionStorage / localStorage for auth tokens
    const keys = Object.keys(localStorage);
    for (const key of keys) {
      const val = localStorage.getItem(key);
      if (val && (val.includes('"access_token"') || val.includes('"accessToken"'))) {
        try {
          const parsed = JSON.parse(val);
          if (parsed.access_token || parsed.accessToken) {
            return { source: 'localstorage', key, data: parsed };
          }
        } catch {
          // ignore
        }
      }
    }

    return null;
  }).catch(() => null);

  if (creds) {
    log(`[memberOnboarder] Found creds from ${creds.source}`);
  }

  // Method 2: call the ChatGPT session endpoint from within the browser
  const sessionData = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/auth/session', { credentials: 'include' });
      if (r.ok) return r.json();
    } catch {}
    return null;
  }).catch(() => null);

  // Method 3: call backend-api/me for account ID
  const meData = await page.evaluate(async () => {
    try {
      const r = await fetch('/backend-api/me', { credentials: 'include' });
      if (r.ok) return r.json();
    } catch {}
    return null;
  }).catch(() => null);

  log(`[memberOnboarder] sessionData: ${JSON.stringify(sessionData)?.slice(0, 200)}`);
  log(`[memberOnboarder] meData: ${JSON.stringify(meData)?.slice(0, 200)}`);

  // Method 4: intercept the OpenAI auth token from CDP network events
  // (token was captured during page navigation via response interceptor)
  return {
    session: sessionData,
    me: meData,
    extra: creds,
  };
}

/**
 * Set up response interception to capture auth tokens during the signup flow.
 */
async function interceptAuthTokens(page, { log = () => {} } = {}) {
  const captured = { access: null, refresh: null, accountId: null };

  page.on('response', async (response) => {
    const url = response.url();
    if (
      url.includes('/oauth/token') ||
      url.includes('/auth/token') ||
      url.includes('/session') ||
      url.includes('/api/auth')
    ) {
      try {
        const text = await response.text();
        const json = JSON.parse(text);
        if (json.access_token) {
          captured.access = json.access_token;
          log(`[memberOnboarder] Captured access_token from ${url}`);
        }
        if (json.refresh_token) {
          captured.refresh = json.refresh_token;
        }
        if (json.accessToken) {
          captured.access = json.accessToken;
        }
      } catch {
        // ignore
      }
    }
  });

  return captured;
}

/**
 * Complete the full invite → signup → accept flow for a new team member.
 *
 * @param {object} params
 * @param {string} params.inviteeEmail  - the agentmail inbox email that received the invite
 * @param {object} params.env           - env vars (Cloudflare credentials)
 * @param {string} params.port          - Chrome debug port
 * @param {string} params.profileDir    - Chrome profile directory path
 * @param {function} params.log         - optional log function
 * @returns {{ email, accountId, access, refresh, expires, profileDir }}
 */
export async function onboardNewTeamMember({
  inviteeEmail,
  env,
  port = 9870,
  profileDir,
  log = () => {},
}) {
  const resolvedProfile =
    profileDir ??
    path.join(
      os.homedir(),
      'Development/chatgpt-factory-bundle/.agentmail-profiles',
      inviteeEmail.replace(/[^a-z0-9]/gi, '_'),
    );

  log(`[memberOnboarder] Starting onboarding for ${inviteeEmail} at port ${port}`);

  const { browser, page, proc } = await launchChrome(resolvedProfile, port);
  const captured = await interceptAuthTokens(page, { log });

  try {
    // Step 1: Poll Cloudflare KV for the invite email from ChatGPT
    log(`[memberOnboarder] Polling KV for invite email for ${inviteeEmail}`);
    const { rawMessage, keyName } = await pollKvOtp(inviteeEmail, env, {
      timeoutMs: 300_000, // 5 min - invite can take a while
      pollIntervalMs: 8_000,
    }).catch(async () => {
      // No 6-digit OTP in invite email - that's OK, we need the invite link instead
      // Fall back to polling for ANY new message with an invite link
      log(`[memberOnboarder] OTP poll timed out - looking for invite link directly in KV`);
      return { rawMessage: null, keyName: null };
    });

    // Step 2: Extract the invite link from the email
    let inviteLink = null;
    if (rawMessage) {
      const linkMatch =
        rawMessage.match(/https:\/\/chatgpt\.com\/[^\s"<>]+invite[^\s"<>]*/i) ||
        rawMessage.match(/https:\/\/[^\s"<>]*chatgpt\.com[^\s"<>]*[?&]invite[^\s"<>]*/i) ||
        rawMessage.match(/https:\/\/chatgpt\.com\/join[^\s"<>]*/i);
      if (linkMatch) inviteLink = linkMatch[0];
      log(`[memberOnboarder] Invite link from email: ${inviteLink}`);
    }

    // Step 3: If no invite link found in the poll OTP method, scan KV directly for invite emails
    if (!inviteLink) {
      const headers = {
        'X-Auth-Email': env.CLOUDFLARE_EMAIL,
        'X-Auth-Key': env.CLOUDFLARE_GLOBAL_API_KEY,
        'Content-Type': 'application/json',
      };
      const accountId = env.CLOUDFLARE_ACCOUNT_ID;
      const prefix = `msg:${inviteeEmail}:`;

      const keysRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${EMAIL_KV_NAMESPACE_ID}/keys?prefix=${encodeURIComponent(prefix)}&limit=100`,
        { headers },
      );
      const keysJson = await keysRes.json();
      const allKeys = (keysJson.result ?? []).map((e) => e.name);

      for (const key of allKeys.reverse()) {
        const msgRes = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${EMAIL_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`,
          { headers },
        );
        const txt = await msgRes.text();
        const linkMatch =
          txt.match(/https:\/\/chatgpt\.com\/[^\s"<>]*invite[^\s"<>]*/i) ||
          txt.match(/https:\/\/chatgpt\.com\/join[^\s"<>]*/i) ||
          txt.match(/(https:\/\/chatgpt\.com\/[a-zA-Z0-9/?=&_-]{20,})/);
        if (linkMatch) {
          inviteLink = linkMatch[0].replace(/\s.*/, '').replace(/["'>].*/, '');
          log(`[memberOnboarder] Found invite link in KV: ${inviteLink}`);
          break;
        }
      }
    }

    if (!inviteLink) {
      throw Object.assign(
        new Error(`No invite link found in KV for ${inviteeEmail}`),
        { code: 'INVITE_LINK_NOT_FOUND', email: inviteeEmail },
      );
    }

    // Step 4: Navigate to the invite link
    log(`[memberOnboarder] Navigating to invite link: ${inviteLink}`);
    await page.goto(inviteLink, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(5_000);

    log(`[memberOnboarder] After invite link nav: ${page.url()}`);

    // Step 5: Determine if we need to sign up or log in
    const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
    const needsSignup =
      pageText.includes('sign up') ||
      pageText.includes('create account') ||
      pageText.includes('get started') ||
      page.url().includes('signup') ||
      page.url().includes('sign-up');

    if (needsSignup || page.url().includes('auth')) {
      log(`[memberOnboarder] Needs signup flow at ${page.url()}`);
      await performSignupFlow(page, inviteeEmail, env, { log, captured });
    } else {
      log(`[memberOnboarder] May already be logged in or at acceptance page`);
    }

    // Step 6: Accept the invite if we're on an acceptance page
    await sleep(5_000);
    const acceptResult = await page.evaluate(async () => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const t = (btn.innerText || '').toLowerCase();
        if (t.includes('accept') || t.includes('join') || t.includes('continue')) {
          btn.click();
          return btn.innerText;
        }
      }
      return null;
    });
    log(`[memberOnboarder] Accept button: ${acceptResult}`);

    await sleep(8_000);

    // Step 7: Capture credentials from the authenticated session
    const sessionCreds = await captureOAuthCredentials(page, { log });

    // Step 8: Extract access token from pi-compatible codex app server call
    const accessToken = await extractCodexAccessToken(page, { log });

    log(`[memberOnboarder] Captured access token: ${accessToken ? 'YES' : 'NO'}`);

    const finalUrl = page.url();
    const finalText = await page.evaluate(() => document.body.innerText.slice(0, 1000));
    log(`[memberOnboarder] Final state: ${finalUrl}`);

    return {
      email: inviteeEmail,
      accessToken: accessToken || captured.access,
      refreshToken: captured.refresh,
      accountId: sessionCreds.me?.id?.replace('user-', '') || sessionCreds.me?.id,
      profileDir: resolvedProfile,
      inviteLink,
      finalUrl,
      finalPageText: finalText,
      rawSession: sessionCreds,
    };
  } finally {
    try {
      await browser.close();
    } catch {
      // ignore
    }
    proc.kill('SIGTERM');
  }
}

async function performSignupFlow(page, email, env, { log, captured }) {
  const [firstName, lastName] = randomName();
  const password = randomPassword();

  // Navigate to signup if needed
  if (!page.url().includes('signup') && !page.url().includes('sign-up')) {
    await page.goto('https://auth.openai.com/authorize?...', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(2_000);
  }

  // Fill email
  const emailInput = await page.$(
    'input[type="email"], input[name="email"], input[id="email-input"], input[placeholder*="email"]',
  );
  if (emailInput) {
    await emailInput.click({ clickCount: 3 });
    await emailInput.type(email);
    const cont = await page.$('button[type="submit"], button[data-action="default"]');
    if (cont) await cont.click();
    await sleep(3_000);
  }

  // Fill password if prompted
  const passInput = await page.$('input[type="password"]');
  if (passInput) {
    await passInput.type(password);
    const cont = await page.$('button[type="submit"]');
    if (cont) await cont.click();
    await sleep(3_000);
  }

  // OTP verification
  const urlAfterPass = page.url();
  if (urlAfterPass.includes('verify') || urlAfterPass.includes('otp') || urlAfterPass.includes('code')) {
    log(`[memberOnboarder] OTP step at ${urlAfterPass}`);
    const { otp } = await pollKvOtp(email, env, { timeoutMs: 120_000 });
    log(`[memberOnboarder] Got OTP ${otp}`);
    await fillOtpInputs(page, otp);
    const cont = await page.$('button[type="submit"]');
    if (cont) await cont.click();
    await sleep(4_000);
  }

  // Fill name if prompted
  const firstNameInput = await page.$(
    'input[name="firstName"], input[id*="first"], input[placeholder*="First"]',
  );
  if (firstNameInput) {
    await firstNameInput.type(firstName);
    const lastNameInput = await page.$(
      'input[name="lastName"], input[id*="last"], input[placeholder*="Last"]',
    );
    if (lastNameInput) await lastNameInput.type(lastName);
    const cont = await page.$('button[type="submit"]');
    if (cont) await cont.click();
    await sleep(3_000);
  }

  // Birthday if prompted
  const birthdayInput = await page.$('input[type="date"], input[name*="birth"], input[name*="age"]');
  if (birthdayInput) {
    await birthdayInput.type('1990-01-15');
    const cont = await page.$('button[type="submit"]');
    if (cont) await cont.click();
    await sleep(3_000);
  }

  // Click through onboarding/confirmation pages
  for (let i = 0; i < 5; i++) {
    const nextBtn = await page.$('button[type="submit"], button[data-action="next"], button[data-action="continue"]');
    if (nextBtn) {
      const t = await page.evaluate((el) => el.innerText, nextBtn);
      if (!t.toLowerCase().includes('back')) {
        await nextBtn.click();
        await sleep(2_500);
      }
    }
  }

  await sleep(5_000);
  log(`[memberOnboarder] After signup: ${page.url()}`);
}

/**
 * Extract a fresh access token suitable for pi's account-router from the browser.
 * Uses the codex app-server approach or direct localStorage access.
 */
async function extractCodexAccessToken(page, { log = () => {} } = {}) {
  return page.evaluate(async () => {
    try {
      // Try the next-auth session endpoint which returns a short-lived access token
      const r = await fetch('/api/auth/session', { credentials: 'include' });
      if (r.ok) {
        const j = await r.json();
        return j.accessToken || j.access_token || null;
      }
    } catch {}

    // Try OpenAI auth token endpoint
    try {
      const r = await fetch('https://auth.openai.com/authorize', { credentials: 'include', method: 'GET' });
    } catch {}

    // Scan localStorage for any OAuth tokens
    for (const key of Object.keys(localStorage)) {
      const val = localStorage.getItem(key);
      if (val && val.startsWith('ey') && val.length > 100) {
        return val;
      }
      if (val) {
        try {
          const parsed = JSON.parse(val);
          if (parsed.access_token) return parsed.access_token;
          if (parsed.accessToken) return parsed.accessToken;
        } catch {}
      }
    }
    return null;
  }).catch(() => null);
}
