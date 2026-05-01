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

const STEALTH_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

async function applyPageStealthPatches(page) {
  // Must run BEFORE any page.goto() call
  try { await page.setUserAgent(STEALTH_UA); } catch {}
  try { await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en' }); } catch {}
  try { await page.emulateTimezone('America/Los_Angeles'); } catch {}
  try {
    await page.evaluateOnNewDocument(() => {
      try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
      try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] }); } catch {}
      try { Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' }); } catch {}
      try { window.chrome = window.chrome || { runtime: {} }; } catch {}
    });
  } catch {}
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
      // Anti-bot: remove automation signals that Cloudflare detects
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-features=IsolateOrigins,site-per-process',
      '--font-render-hinting=none',
      `--user-agent=${STEALTH_UA}`,
      '--lang=en-US,en',
      '--window-size=1280,1024',
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
  // Apply stealth patches BEFORE any navigation
  await applyPageStealthPatches(page);
  return { browser, page, proc };
}

/**
 * Connect to the remote browser (lightpanda cloud Chrome or similar) instead of
 * launching a local Chrome process. Used when BROWSER_WS_ENDPOINT is set.
 */
async function connectRemoteBrowser(wsEndpoint) {
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  await applyPageStealthPatches(page);
  return { browser, page, proc: null };
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

  // Warmup: chatgpt.com homepage first (Cloudflare cookie establishment)
  // domcontentloaded (not networkidle2) — chatgpt.com has persistent WebSocket
  // connections that prevent networkidle2 from resolving.
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  await sleep(2_000);
  await page.goto('https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(3_000);

  // ChatGPT auth flow (2026): chatgpt.com/auth/login is a landing page.
  // "Log in" button navigates to auth.openai.com/log-in-or-create-account.
  // Use ::-p-text() to find button by visible text content.
  const loginBtn = await page.waitForSelector('::-p-text(Log in)', { timeout: 10_000 }).catch(() => null);
  if (loginBtn) {
    log(`[teamDriver] Clicking 'Log in' button → auth.openai.com`);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null),
      Promise.resolve(loginBtn.click()).catch(() => {}),
    ]);
    await sleep(2_000);
  } else {
    // Fallback: navigate directly to the auth form
    log(`[teamDriver] 'Log in' button not found, navigating directly to auth.openai.com`);
    await page.goto('https://auth.openai.com/log-in-or-create-account', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await sleep(2_000);
  }

  // Enter email (now on auth.openai.com/log-in-or-create-account)
  const emailInput = await page.waitForSelector(
    'input[type="email"], input[name="email"], input[id="email-input"], input[autocomplete="email"]',
    { timeout: 15_000 },
  ).catch(() => null);
  if (!emailInput) throw new Error(`Email input not found for ${email} login`);

  // Set sinceMs BEFORE clicking Continue (which triggers OTP send)
  const otpSinceMs = Date.now();

  await emailInput.type(email);
  const continueBtn = await page.$('button[type="submit"], button[data-action="default"]');
  if (continueBtn) await continueBtn.click();

  await sleep(4_000);

  // Handle password prompt first — click "Forgot password" or "Continue with code" to get OTP
  const passInput = await page.$('input[type="password"], input[name="password"]');
  if (passInput) {
    // Use evaluate() to find links by text content — avoids non-standard :has-text()/:contains()
    const forgotClicked = await page.evaluate(() => {
      for (const el of document.querySelectorAll('a, button')) {
        const t = (el.innerText || el.textContent || '').toLowerCase().trim();
        if (t.includes('forgot') || t.includes('email code') || t.includes('email link') ||
            el.getAttribute('data-action') === 'use-email-code' ||
            el.getAttribute('data-link') === 'email-code') {
          el.click();
          return el.innerText || el.textContent || 'clicked';
        }
      }
      return null;
    });
    if (forgotClicked) {
      log(`[teamDriver] Clicked forgot/OTP link: ${forgotClicked}`);
      await sleep(3_000);
    }
  }

  // Click "Send code" or "Continue with email" if present — find by text, not pseudo-selector
  const sendCodeClicked = await page.evaluate(() => {
    for (const btn of document.querySelectorAll('button, a')) {
      const t = (btn.innerText || btn.textContent || '').toLowerCase().trim();
      const act = btn.getAttribute('data-action') || '';
      if (act === 'send-code' || t === 'send code' || t === 'continue with email' ||
          t === 'email me a code' || t === 'send me a link') {
        btn.click();
        return btn.innerText || btn.textContent || 'clicked';
      }
    }
    return null;
  });
  if (sendCodeClicked) {
    log(`[teamDriver] Clicked send-code button: ${sendCodeClicked}`);
    await sleep(2_000);
  }

  // For @agentmail.to addresses: poll AgentMail API directly.
  // For @epistemophile.space addresses: poll Cloudflare KV.
  const sinceMs = otpSinceMs; // captured before Continue click (before OTP was sent)
  let otp;
  if (email.endsWith('@agentmail.to') && env.OWNER_AGENTMAIL_API_KEY) {
    log(`[teamDriver] Polling AgentMail for OTP for ${email}`);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`https://api.agentmail.to/v0/inboxes/${email}/messages?limit=10`, {
          headers: { Authorization: `Bearer ${env.OWNER_AGENTMAIL_API_KEY}` },
        });
        if (r.ok) {
          const data = await r.json();
          const msg = (data.messages || []).find((m) => {
            const t = `${m.subject || ''} ${m.preview || ''} ${m.text || ''}`;
            // AgentMail timestamps are ISO strings or ms — normalise to ms for comparison
            const ts = m.receivedAt || m.timestamp || '';
            const tsMs = typeof ts === 'number' ? ts : (ts ? new Date(ts).getTime() : 0);
            return tsMs >= sinceMs && /\b\d{6}\b/.test(t);
          });
          if (msg) {
            const m = `${msg.subject || ''} ${msg.preview || ''}`.match(/\b(\d{6})\b/);
            if (m) { otp = m[1]; break; }
          }
        }
      } catch { /* transient */ }
      await sleep(5_000);
    }
    if (!otp) throw new Error(`OTP for ${email} not received via AgentMail within 120s`);
  } else {
    log(`[teamDriver] Polling KV for OTP for ${email}`);
    const result = await pollKvOtp(email, env, { timeoutMs: 120_000 });
    otp = result.otp;
  }
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
  browserWsEndpoint = process.env.BROWSER_WS_ENDPOINT || process.env.LIGHTPANDA_WS_URL || null,
}) {
  let browser, page, proc;
  let resolvedProfile = null;

  if (browserWsEndpoint) {
    // Use remote Chrome (lightpanda cloud) — avoids local Xvfb + Cloudflare bot detection
    log(`[teamDriver] Connecting owner session to remote browser: ${browserWsEndpoint.slice(0, 60)}...`);
    ({ browser, page, proc } = await connectRemoteBrowser(browserWsEndpoint));
  } else {
    resolvedProfile = profileDir ?? KNOWN_SESSION_DIRS[email] ?? path.join(os.tmpdir(), `gpt-session-${email.replace(/[^a-z0-9]/gi, '-')}`);
    ({ browser, page, proc } = await launchChrome(resolvedProfile, port));
  }

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

  return { browser, page, proc, profileDir: resolvedProfile ?? null };
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
 * Looks up the user_id from the members API, then calls removeTeamMemberById.
 * Falls back to UI automation if API lookup fails.
 */
export async function removeTeamMember(page, targetEmail, {
  log = () => {},
  accountId = null, // must be provided
  ownerToken = null,
} = {}) {
  log(`[teamDriver] Removing member ${targetEmail}`);

  // Try API-based remove first
  const membersResult = await listWorkspaceMembers(page, { log, accountId, ownerToken });
  if (membersResult.ok) {
    const member = membersResult.members.find(m =>
      m.email.toLowerCase() === targetEmail.toLowerCase()
    );
    if (member?.userId) {
      const removeResult = await removeTeamMemberById(page, member.userId, { log, accountId, ownerToken });
      if (removeResult.ok) {
        log(`[teamDriver] API remove succeeded for ${targetEmail}`);
        return { email: targetEmail, outcome: 'api-removed', userId: member.userId };
      }
      log(`[teamDriver] API remove failed (${removeResult.status}), falling back to UI`);
    } else {
      log(`[teamDriver] Member ${targetEmail} not found in workspace (may already be removed)`);
      return { email: targetEmail, outcome: 'not-found' };
    }
  }

  // UI fallback:
  log(`[teamDriver] Falling back to UI remove for ${targetEmail}`);

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
 *
 * Uses POST /backend-api/accounts/{AID}/invites with Bearer token.
 * Confirmed working: Bearer token passes Cloudflare from lightpanda page.evaluate().
 * Payload: { email_addresses: [email], role: 'standard-user' }
 * Returns 200/201 on success, 409 if already invited, 422 if already member.
 *
 * @param {object} page - Puppeteer page (on chatgpt.com)
 * @param {string} inviteeEmail
 * @param {object} opts
 * @param {string} opts.accountId - Guardrail workspace account ID
 * @param {string} opts.ownerToken - Bearer token (any current workspace member)
 */
export async function inviteTeamMember(page, inviteeEmail, {
  log = () => {},
  accountId = null, // must be provided — no default workspace ID
  ownerToken = null,
} = {}) {
  if (!accountId) throw new Error('inviteTeamMember: accountId is required');
  log(`[teamDriver] Inviting ${inviteeEmail} via API`);

  const apiResult = await page.evaluate(async (email, aid, token) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    // Step 1: Check for existing pending invite and cancel it so a fresh email is sent
    const listR = await fetch('/backend-api/accounts/' + aid + '/invites', {
      credentials: 'include', headers,
    });
    if (listR.ok) {
      const listData = await listR.json().catch(() => null);
      const existing = (listData?.items || []).find(inv =>
        (inv.email_address || '').toLowerCase() === email.toLowerCase()
      );
      if (existing?.id) {
        // Cancel old pending invite via PATCH (DELETE returns 405 on /invites/{id}).
        // Root-Mail_a is active so PATCH should work (unlike deactivated Guardrail).
        await fetch('/backend-api/accounts/' + aid + '/invites/' + existing.id, {
          method: 'PATCH', credentials: 'include', headers,
          body: JSON.stringify({ status: 'cancelled' }),
        }).catch(() => {});
        await new Promise(r => setTimeout(r, 800));
      }
    }

    // Step 2: Create fresh invite
    try {
      const r = await fetch('/backend-api/accounts/' + aid + '/invites', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ email_addresses: [email], role: 'standard-user' }),
      });
      const text = await r.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      return { status: r.status, ok: r.status >= 200 && r.status < 300, body };
    } catch (e) { return { ok: false, error: e.message }; }
  }, inviteeEmail, accountId, ownerToken);

  log(`[teamDriver] Invite API: ${JSON.stringify(apiResult)}`);

  // 200/201 = fresh invite sent; 409 = already pending (cancel failed); 422 = already member
  const success = apiResult.ok || apiResult.status === 409 || apiResult.status === 422;
  if (!success) {
    throw new Error(`Invite API returned ${apiResult.status}: ${JSON.stringify(apiResult.body).slice(0, 200)}`);
  }
  return { inviteeEmail, success: true, status: apiResult.status, body: apiResult.body };
}

/**
 * Remove a workspace member by user_id via DELETE /backend-api/accounts/{AID}/users/{userId}.
 * Confirmed: Bearer token works, returns {"success":true} on 200.
 *
 * @param {object} page - Puppeteer page (on chatgpt.com)
 * @param {string} userId - The user_id from GET /accounts/{AID}/users (e.g. "user-xxxx")
 * @param {object} opts
 */
export async function removeTeamMemberById(page, userId, {
  log = () => {},
  accountId = null, // must be provided
  ownerToken = null,
} = {}) {
  log(`[teamDriver] Removing member ${userId} via API`);

  const result = await page.evaluate(async (aid, uid, token) => {
    try {
      const headers = {};
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const r = await fetch('/backend-api/accounts/' + aid + '/users/' + uid, {
        method: 'DELETE',
        credentials: 'include',
        headers,
      });
      const text = await r.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      return { status: r.status, ok: r.status >= 200 && r.status < 300, body };
    } catch (e) { return { ok: false, error: e.message }; }
  }, accountId, userId, ownerToken);

  log(`[teamDriver] Remove API: ${JSON.stringify(result)}`);
  return result;
}

/**
 * List workspace members with their user_ids.
 * GET /backend-api/accounts/{AID}/users — Bearer token works.
 */
export async function listWorkspaceMembers(page, {
  log = () => {},
  accountId = null, // must be provided
  ownerToken = null,
} = {}) {
  const result = await page.evaluate(async (aid, token) => {
    try {
      const headers = {};
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const r = await fetch('/backend-api/accounts/' + aid + '/users', {
        credentials: 'include', headers,
      });
      if (!r.ok) return { ok: false, status: r.status };
      const d = await r.json();
      const items = d.items || d;
      return {
        ok: true,
        members: items.map(m => ({
          userId: m.user_id || m.id,
          email: m.email || m.user?.email || '',
          role: m.role,
        })),
      };
    } catch (e) { return { ok: false, error: e.message }; }
  }, accountId, ownerToken);

  if (result.ok) {
    log(`[teamDriver] listWorkspaceMembers: ${result.members.length} members`);
  } else {
    log(`[teamDriver] listWorkspaceMembers failed: status=${result.status} error=${result.error ?? JSON.stringify(result)}`);
  }
  return result;
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
