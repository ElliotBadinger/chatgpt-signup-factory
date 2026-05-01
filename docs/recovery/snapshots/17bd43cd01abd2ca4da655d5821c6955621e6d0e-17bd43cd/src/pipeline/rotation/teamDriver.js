/**
 * teamDriver.js
 *
 * Chrome/Xvfb automation for ChatGPT team admin operations:
 *  - Re-authenticate a session via OTP (brightbeer360 or any agentmail member)
 *  - Remove a member from the Guardrail team
 *  - Invite a new email address to the team
 *
 * All operations use the proven real-Chrome + CDP approach from prior experiments.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import puppeteer from 'puppeteer-core';
import dotenv from 'dotenv';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EMAIL_KV_NAMESPACE_ID = '99275c7d53424a72b29ea8340910f2bb';

const KNOWN_SESSION_DIRS = {
  'brightbeer360@agentmail.to': path.join(
    os.homedir(),
    'Development/chatgpt-factory-bundle/scratch/xvfb-owner/profile',
  ),
  'adventuroussister568@agentmail.to': path.join(
    os.homedir(),
    'Development/chatgpt-factory-bundle/scratch/xvfb-adventurous2/profile',
  ),
  'motionlessfloor327@agentmail.to': path.join(
    os.homedir(),
    'Development/chatgpt-factory-bundle/scratch/xvfb-motionless/profile',
  ),
  'greenlevel332@agentmail.to': path.join(
    os.homedir(),
    'Development/chatgpt-factory-bundle/scratch/xvfb-branch-green/profile',
  ),
};

function resolveEnv(cwd = process.cwd()) {
  const candidates = [
    path.join(cwd, '.env'),
    path.join(cwd, '..', '..', '.env'),
    path.join(cwd, '..', '.env'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return dotenv.parse(fs.readFileSync(p));
  }
  return {};
}

function cfHeaders(env) {
  if (env.CLOUDFLARE_GLOBAL_API_KEY && env.CLOUDFLARE_EMAIL) {
    return {
      'X-Auth-Email': env.CLOUDFLARE_EMAIL,
      'X-Auth-Key': env.CLOUDFLARE_GLOBAL_API_KEY,
      'Content-Type': 'application/json',
    };
  }
  return {
    Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

async function pollKvOtp(email, env, { timeoutMs = 180_000, pollIntervalMs = 4_000 } = {}) {
  const headers = cfHeaders(env);
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const prefix = `msg:${email}:`;
  const deadline = Date.now() + timeoutMs;

  function parseTs(key) {
    const m = key.match(/:(\d+):[^:]+$/);
    return m ? Number(m[1]) : 0;
  }

  // Record existing keys before waiting so we only pick up fresh messages
  let previousKeys = new Set();
  try {
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${EMAIL_KV_NAMESPACE_ID}/keys?prefix=${encodeURIComponent(prefix)}`,
      { headers },
    );
    const j = await r.json();
    previousKeys = new Set((j.result ?? []).map((e) => e.name));
  } catch {
    // ignore; will pick up all messages
  }

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    try {
      const r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${EMAIL_KV_NAMESPACE_ID}/keys?prefix=${encodeURIComponent(prefix)}`,
        { headers },
      );
      const j = await r.json();
      const keys = (j.result ?? [])
        .map((e) => e.name)
        .filter((k) => !previousKeys.has(k))
        .sort((a, b) => parseTs(b) - parseTs(a));

      for (const key of keys) {
        const msgR = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${EMAIL_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`,
          { headers },
        );
        const txt = await msgR.text();
        const m =
          txt.match(/<b>(\d{6})<\/b>/i) ||
          txt.match(/Subject:\s*(\d{6}) is your verification code/i) ||
          txt.match(/\b(\d{6})\b is your (OTP|verification) code/i) ||
          txt.match(/(\d{6})\s+is your OpenAI verification code/i) ||
          txt.match(/Your verification code is[:\s]+(\d{6})/i) ||
          txt.match(/code:\s*(\d{6})/i);
        if (m) return { otp: m[1], keyName: key, rawMessage: txt.slice(0, 2000) };
      }
    } catch {
      // network hiccup — retry
    }
  }

  throw Object.assign(new Error(`OTP timeout for ${email}`), { code: 'OTP_TIMEOUT', email });
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
      '--disable-background-networking',
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
  if (!browser) throw new Error(`Chrome CDP not available at port ${port}`);
  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  return { browser, page, proc };
}

async function fillOtp(page, otp) {
  const inputs = await page.$$('input[maxlength="1"], input[inputmode="numeric"]');
  if (inputs.length >= 6) {
    for (let i = 0; i < 6; i++) await inputs[i].type(otp[i]);
    return;
  }
  const first = await page.$('input');
  if (first) await first.type(otp);
}

/**
 * Log in (or re-authenticate) a ChatGPT account via OTP magic link.
 * Works for any agentmail.to address we control via Cloudflare KV.
 */
async function loginViaChatGptOtp(page, email, env, { log = () => {} } = {}) {
  log(`[teamDriver] Logging in ${email} via OTP`);
  await page.goto('https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(4_000);

  // Click "Log in" button if present
  const loginBtn = await page.$('button[data-testid="login-button"], [aria-label="Log in"], button[class*="login"]');
  if (loginBtn) {
    await loginBtn.click();
    await sleep(3_000);
  }

  // Enter email
  const emailInput = await page.$('input[type="email"], input[name="email"], input[id="email-input"], input[placeholder*="email"]');
  if (!emailInput) throw new Error(`Email input not found for ${email} login`);
  await emailInput.type(email);

  const continueBtn = await page.$('button[type="submit"], button[data-action="default"]');
  if (continueBtn) await continueBtn.click();

  await sleep(4_000);

  // Handle password prompt first (try entering a dummy then fallback to OTP/forgot)
  const passInput = await page.$('input[type="password"], input[name="password"]');
  if (passInput) {
    // Click "Forgot password" or "Continue with code" to get OTP instead
    for (const selector of [
      'a[href*="forgot"]',
      'button[data-action="use-email-code"]',
      'a[data-link="email-code"]',
      '[class*="forgot"]',
      'button:contains("Continue with email")',
    ]) {
      const el = await page.$(selector);
      if (el) {
        await el.click();
        log(`[teamDriver] Clicked forgot/OTP link`);
        await sleep(3_000);
        break;
      }
    }
  }

  // Now we should be at OTP entry or a "send code" button
  const sendCodeBtn = await page.$('button[data-action="send-code"], button:has-text("Continue with email")');
  if (sendCodeBtn) {
    await sendCodeBtn.click();
    await sleep(2_000);
  }

  log(`[teamDriver] Polling KV for OTP for ${email}`);
  const { otp } = await pollKvOtp(email, env, { timeoutMs: 120_000 });
  log(`[teamDriver] Got OTP ${otp} for ${email}`);

  await fillOtp(page, otp);
  await sleep(2_000);

  // Submit if there's a submit button
  const submitBtn = await page.$('button[type="submit"]');
  if (submitBtn) await submitBtn.click();

  await page.waitForFunction(
    () => location.hostname === 'chatgpt.com' && !location.pathname.includes('auth'),
    { timeout: 60_000 },
  ).catch(() => {});
  await sleep(5_000);
  log(`[teamDriver] Login complete for ${email}, url=${page.url()}`);
}

/**
 * Get or refresh a session page that is authenticated for ChatGPT as `email`.
 * Attempts to reuse an existing profile dir; falls back to fresh login.
 */
export async function ensureAuthenticatedChatGptSession({
  email,
  env,
  port,
  profileDir,
  log = () => {},
}) {
  const resolvedProfile =
    profileDir ?? KNOWN_SESSION_DIRS[email] ?? path.join(os.tmpdir(), `gpt-session-${email.replace(/[^a-z0-9]/gi, '-')}`);

  const { browser, page, proc } = await launchChrome(resolvedProfile, port);

  // Quick auth check
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(4_000);

  const me = await page.evaluate(async () => {
    const r = await fetch('/backend-api/me', { credentials: 'include' });
    if (!r.ok) return null;
    return r.json();
  }).catch(() => null);

  const isLoggedIn = me && typeof me.email === 'string' && me.email.length > 0;
  log(`[teamDriver] Session check for ${email}: loggedIn=${isLoggedIn}, me=${me?.email || 'n/a'}`);

  if (!isLoggedIn) {
    await loginViaChatGptOtp(page, email, env, { log });
  }

  return { browser, page, proc, profileDir: resolvedProfile };
}

/**
 * List current team members via the ChatGPT admin API from within the browser context.
 */
export async function listTeamMembers(page, { log = () => {} } = {}) {
  await page.goto('https://chatgpt.com/settings/organization/team/members', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await sleep(6_000);

  const text = await page.evaluate(() => document.body.innerText);
  log(`[teamDriver] Members page text: ${text.slice(0, 800)}`);

  // Also try the API
  const apiResult = await page.evaluate(async () => {
    const endpoints = [
      '/backend-api/account_management/workspace/members',
      '/backend-api/accounts/my_account',
    ];
    for (const ep of endpoints) {
      const r = await fetch(ep, { credentials: 'include' });
      if (r.ok) return r.json();
    }
    return null;
  }).catch(() => null);

  // Parse from page text as fallback
  const emailPattern = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi;
  const pageEmails = [...new Set(text.match(emailPattern) ?? [])];

  return {
    pageText: text,
    apiResult,
    pageEmails,
  };
}

/**
 * Remove a team member by email.
 * Navigates to the members page, finds the member row, and clicks Remove.
 */
export async function removeTeamMember(page, targetEmail, { log = () => {} } = {}) {
  log(`[teamDriver] Removing member ${targetEmail}`);

  await page.goto('https://chatgpt.com/settings/organization/team/members', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await sleep(6_000);

  // Find the member row and click the kebab/options menu or Remove button
  const removed = await page.evaluate(async (email) => {
    // Look for element containing the email
    const allText = document.querySelectorAll('[class*="member"], [class*="user"], tr, li, [role="row"]');
    let targetRow = null;

    for (const el of allText) {
      if (el.innerText?.includes(email)) {
        targetRow = el;
        break;
      }
    }

    if (!targetRow) {
      // Try general text search
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.tagName !== 'SCRIPT' && node.tagName !== 'STYLE' && node.childElementCount < 5) {
          if ((node.textContent || '').includes(email)) {
            targetRow = node.closest('tr, li, [role="row"], [class*="member"]') || node;
            break;
          }
        }
      }
    }

    if (!targetRow) return { found: false };

    // Click the options button or Remove button within the row
    const buttons = targetRow.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      const t = (btn.innerText || btn.title || btn.ariaLabel || '').toLowerCase();
      if (t.includes('remove') || t.includes('more') || t.includes('option') || t.includes('•••') || t.includes('…') || t === '⋮') {
        btn.click();
        return { found: true, clicked: t };
      }
    }

    // If no button found, look for a three-dot or kebab icon
    const svgBtns = targetRow.querySelectorAll('button');
    if (svgBtns.length > 0) {
      svgBtns[svgBtns.length - 1].click();
      return { found: true, clicked: 'last-button' };
    }

    return { found: true, clicked: null };
  }, targetEmail);

  log(`[teamDriver] Remove attempt: ${JSON.stringify(removed)}`);

  if (!removed.found) {
    // Try scrolling down and looking again
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2_000);
  }

  await sleep(2_000);

  // After clicking options menu, look for "Remove" in the dropdown
  const removeResult = await page.evaluate(async (email) => {
    const allButtons = document.querySelectorAll('button, [role="menuitem"], [role="option"]');
    for (const btn of allButtons) {
      const t = (btn.innerText || btn.textContent || '').toLowerCase().trim();
      if (t === 'remove' || t === 'remove member' || t.startsWith('remove')) {
        btn.click();
        return { clicked: t };
      }
    }
    return { clicked: null };
  }, targetEmail);

  log(`[teamDriver] Remove dropdown: ${JSON.stringify(removeResult)}`);

  await sleep(3_000);

  // Confirm dialog if present
  await page.evaluate(async () => {
    const confirmBtns = document.querySelectorAll('button');
    for (const btn of confirmBtns) {
      const t = (btn.innerText || '').toLowerCase();
      if (t === 'remove' || t === 'confirm' || t === 'yes' || t === 'ok') {
        btn.click();
        return true;
      }
    }
    return false;
  });

  await sleep(4_000);

  const finalText = await page.evaluate(() => document.body.innerText.slice(0, 500));
  log(`[teamDriver] Page after removal: ${finalText.replace(/\n/g, ' | ')}`);

  return {
    email: targetEmail,
    outcome: removeResult.clicked ? 'remove-clicked' : 'attempted',
    pageTextAfter: finalText,
  };
}

/**
 * Invite a new email to the Guardrail team.
 * Uses the Invite member UI flow.
 */
export async function inviteTeamMember(page, inviteeEmail, { log = () => {} } = {}) {
  log(`[teamDriver] Inviting ${inviteeEmail}`);

  await page.goto('https://chatgpt.com/settings/organization/team/members', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await sleep(6_000);

  // Click "Invite member" button
  const clicked = await page.evaluate(async () => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const t = (btn.innerText || '').toLowerCase();
      if (t.includes('invite') && (t.includes('member') || t.includes('user') || t.includes('people'))) {
        btn.click();
        return btn.innerText;
      }
    }
    // Fallback: any button with "invite"
    for (const btn of buttons) {
      if ((btn.innerText || '').toLowerCase().includes('invite')) {
        btn.click();
        return btn.innerText;
      }
    }
    return null;
  });

  log(`[teamDriver] Invite button clicked: ${clicked}`);
  await sleep(3_000);

  // Type the email in the invite dialog
  const emailInput = await page.$('input[type="email"], input[placeholder*="email"], input[placeholder*="Email"]');
  if (!emailInput) {
    // Try any visible input
    const inputs = await page.$$('input:not([type="hidden"])');
    for (const input of inputs) {
      const visible = await page.evaluate((el) => el.offsetWidth > 0, input);
      if (visible) {
        await input.type(inviteeEmail);
        break;
      }
    }
  } else {
    await emailInput.type(inviteeEmail);
  }

  await sleep(1_500);

  // Submit the invite
  const submitResult = await page.evaluate(async () => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const t = (btn.innerText || '').toLowerCase();
      if (t.includes('send') || t === 'invite' || t.includes('invite member')) {
        btn.click();
        return btn.innerText;
      }
    }
    const submits = document.querySelectorAll('button[type="submit"]');
    if (submits.length > 0) {
      submits[0].click();
      return 'submit';
    }
    return null;
  });

  log(`[teamDriver] Invite submit: ${submitResult}`);
  await sleep(5_000);

  const pageText = await page.evaluate(() => document.body.innerText.slice(0, 800));
  const success =
    pageText.toLowerCase().includes('invited') ||
    pageText.toLowerCase().includes('invitation') ||
    pageText.toLowerCase().includes('sent');

  log(`[teamDriver] Invite result: success=${success}, text=${pageText.replace(/\n/g, ' | ').slice(0, 300)}`);

  return {
    inviteeEmail,
    submitLabel: submitResult,
    success,
    pageText,
  };
}

/**
 * High-level convenience: open an owner session, remove an exhausted member, invite a replacement.
 */
export async function rotateTeamMember({
  ownerEmail = 'brightbeer360@agentmail.to',
  removeEmail,
  inviteEmail,
  env,
  port = 9860,
  log = () => {},
}) {
  if (!env) throw new TypeError('env is required for rotateTeamMember');

  let browser = null;
  let proc = null;
  let profileDir = null;

  try {
    const session = await ensureAuthenticatedChatGptSession({
      email: ownerEmail,
      env,
      port,
      log,
    });
    browser = session.browser;
    proc = session.proc;
    profileDir = session.profileDir;
    const page = session.page;

    let removeResult = null;
    if (removeEmail) {
      removeResult = await removeTeamMember(page, removeEmail, { log });
    }

    let inviteResult = null;
    if (inviteEmail) {
      inviteResult = await inviteTeamMember(page, inviteEmail, { log });
    }

    return { ownerEmail, removeResult, inviteResult };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
    if (proc) proc.kill('SIGTERM');
  }
}

export { resolveEnv, pollKvOtp };
