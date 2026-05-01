import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import dotenv from 'dotenv';
import puppeteer from 'puppeteer-core';

import { createStage1LiveHooks } from './liveHooks.js';

const DEFAULT_CHROME_PATHS = ['/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
const EMAIL_KV_NAMESPACE_ID = '99275c7d53424a72b29ea8340910f2bb';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstDefined(...values) {
  return values.find((value) => value != null && value !== '');
}

function resolveChromePath(explicitPath) {
  const candidate = firstDefined(explicitPath, ...DEFAULT_CHROME_PATHS);
  if (!candidate || !fs.existsSync(candidate)) {
    throw new Error('Unable to locate a real Chrome executable for Stage 1 live bootstrap');
  }
  return candidate;
}

export function loadBootstrapEnv({ cwd = process.cwd() } = {}) {
  const candidates = [
    path.join(cwd, '.env'),
    path.join(cwd, '..', '..', '.env'),
    path.join(cwd, '..', '.env'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return {
        path: candidate,
        values: dotenv.parse(fs.readFileSync(candidate)),
      };
    }
  }

  return {
    path: null,
    values: {},
  };
}

function parseRuleTimestamp(keyName) {
  const match = keyName.match(/:(\d+):[^:]+$/);
  return match ? Number(match[1]) : 0;
}

function extractOtp(rawMessage) {
  if (typeof rawMessage !== 'string') {
    return null;
  }

  return rawMessage.match(/<b>(\d{6})<\/b>/i)?.[1]
    ?? rawMessage.match(/Subject:\s*(\d{6}) is your verification code/i)?.[1]
    ?? rawMessage.match(/\b(\d{6})\b is your OTP code/i)?.[1]
    ?? null;
}

function buildRootLocalPart(prefix = 'agentmailroot') {
  return `${prefix}${Date.now()}`;
}

class CloudflareMailboxAuthority {
  constructor({
    env,
    fetchImpl = globalThis.fetch,
    rulePropagationDelayMs = 70_000,
    pollIntervalMs = 5_000,
    otpTimeoutMs = 300_000,  // 5 minutes
    kvNamespaceId = EMAIL_KV_NAMESPACE_ID,
  }) {
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.rulePropagationDelayMs = rulePropagationDelayMs;
    this.pollIntervalMs = pollIntervalMs;
    this.otpTimeoutMs = otpTimeoutMs;
    this.kvNamespaceId = kvNamespaceId;
  }

  cloudflareHeaders() {
    if (this.env.CLOUDFLARE_GLOBAL_API_KEY && this.env.CLOUDFLARE_EMAIL) {
      return {
        'X-Auth-Email': this.env.CLOUDFLARE_EMAIL,
        'X-Auth-Key': this.env.CLOUDFLARE_GLOBAL_API_KEY,
        'Content-Type': 'application/json',
      };
    }

    if (this.env.CLOUDFLARE_API_TOKEN) {
      return {
        Authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      };
    }

    throw new Error('Cloudflare credentials are missing for Stage 1 live bootstrap');
  }

  async request(pathname, { method = 'GET', body } = {}) {
    const response = await this.fetchImpl(`https://api.cloudflare.com/client/v4${pathname}`, {
      method,
      headers: this.cloudflareHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!response.ok || json?.success === false) {
      const error = new Error(`Cloudflare request failed (${response.status})`);
      error.code = 'CLOUDFLARE_REQUEST_FAILED';
      error.status = response.status;
      error.details = {
        pathname,
        bodySnippet: text.slice(0, 1000),
      };
      throw error;
    }

    return json;
  }

  async verify({ controller }) {
    const email = controller.email;
    const existingRule = await this.findRuleByEmail(email);
    if (existingRule) {
      return {
        authority: 'cloudflare-email-worker',
        email,
        ruleId: existingRule.id,
        ruleName: existingRule.name,
        propagationDelayMs: 0,
        kvNamespaceId: this.kvNamespaceId,
      };
    }

    const createdRule = await this.createRule(email);
    await sleep(this.rulePropagationDelayMs);

    return {
      authority: 'cloudflare-email-worker',
      email,
      ruleId: createdRule.id,
      ruleName: createdRule.name,
      propagationDelayMs: this.rulePropagationDelayMs,
      kvNamespaceId: this.kvNamespaceId,
    };
  }

  async findRuleByEmail(email) {
    const json = await this.request(`/zones/${this.env.CLOUDFLARE_ZONE_ID}/email/routing/rules`);
    return (json.result ?? []).find((rule) =>
      (rule.matchers ?? []).some((matcher) => matcher.field === 'to' && matcher.value === email),
    );
  }

  async createRule(email) {
    const json = await this.request(`/zones/${this.env.CLOUDFLARE_ZONE_ID}/email/routing/rules`, {
      method: 'POST',
      body: {
        name: `agentmail-root:${email}`,
        enabled: true,
        matchers: [{ type: 'literal', field: 'to', value: email }],
        actions: [{ type: 'worker', value: ['agentmail-email-capture'] }],
      },
    });

    return json.result;
  }

  async pollOtp(email, { timeoutMs = this.otpTimeoutMs, sinceMs = 0 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const prefix = `msg:${email}:`;

    while (Date.now() < deadline) {
      const json = await this.request(
        `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${this.kvNamespaceId}/keys?prefix=${encodeURIComponent(prefix)}`,
      );

      const keys = (json.result ?? [])
        .map((entry) => entry.name)
        // Only consider messages received at or after sinceMs
        .filter((name) => parseRuleTimestamp(name) >= sinceMs)
        .sort((left, right) => parseRuleTimestamp(right) - parseRuleTimestamp(left));

      for (const keyName of keys) {
        const raw = await this.readKvValue(keyName);
        const otp = extractOtp(raw);
        if (otp) {
          return {
            otp,
            keyName,
          };
        }
      }

      await sleep(this.pollIntervalMs);
    }

    const error = new Error(`Timed out waiting for OTP for ${email} (sinceMs=${sinceMs})`);
    error.code = 'MAILBOX_OTP_TIMEOUT';
    throw error;
  }

  async readKvValue(keyName) {
    const response = await this.fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${this.kvNamespaceId}/values/${encodeURIComponent(keyName)}`,
      { headers: this.cloudflareHeaders() },
    );

    if (!response.ok) {
      const error = new Error(`Cloudflare KV read failed (${response.status})`);
      error.code = 'CLOUDFLARE_KV_READ_FAILED';
      error.status = response.status;
      error.details = {
        keyName,
      };
      throw error;
    }

    return response.text();
  }
}

class RealChromeAgentMailDriver {
  constructor({
    env,
    mailboxAuthority,
    chromePath,
    browserStartTimeoutMs = 30_000,
  }) {
    this.env = env;
    this.mailboxAuthority = mailboxAuthority;
    this.chromePath = resolveChromePath(chromePath);
    this.browserStartTimeoutMs = browserStartTimeoutMs;
    this.sessions = new Map();
  }

  async provision({ controller }) {
    const session = await this.ensureSession(controller);
    const page = session.page;

    await page.goto('https://console.agentmail.to/sign-up', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    // Wait for Clerk JS to fully initialize (proven pattern from scratch experiments)
    await page.waitForFunction(
      () => Boolean(window.Clerk?.loaded && window.Clerk.client?.signUp),
      { timeout: 60_000 },
    );

    // Use Clerk JS API directly — more reliable than DOM form-field interaction.
    // First try sign-up; fall back to sign-in if the account already exists.
    const signUpOrSignInResult = await page.evaluate(
      async ([firstName, lastName, emailAddress]) => {
        try {
          const signUp = window.Clerk.client.signUp;
          const created = await signUp.create({ firstName, lastName, emailAddress });
          const preparedAt = Date.now();
          const prepared = await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
          return {
            flow: 'signup',
            status: created?.status,
            signUpId: created?.id,
            emailAddress: created?.emailAddress,
            unverifiedFields: created?.unverifiedFields,
            verifyStatus: prepared?.verifications?.emailAddress?.status ?? null,
            href: location.href,
            preparedAt,
          };
        } catch (signUpError) {
          // If email already in use, switch to sign-in flow
          const msg = String(signUpError?.message || signUpError);
          const isEmailTaken = msg.includes('already in use')
            || msg.includes('form_identifier_exists')
            || msg.includes('That email address is taken')
            || msg.includes('email_address_exists')
            || msg.includes('identifier_already_signed_in');
          if (!isEmailTaken) {
            throw signUpError;
          }

          // Sign-in: prepare email OTP
          const signIn = window.Clerk.client.signIn;
          const created = await signIn.create({ identifier: emailAddress });
          const factors = created?.supportedFirstFactors ?? [];
          const emailFactor = factors.find((f) => f.strategy === 'email_code');
          if (!emailFactor) throw new Error('No email_code factor available for sign-in');

          const preparedAt = Date.now();
          await signIn.prepareFirstFactor({
            strategy: 'email_code',
            emailAddressId: emailFactor.emailAddressId,
          });
          return {
            flow: 'signin',
            status: created?.status,
            signInId: created?.id,
            emailAddress,
            href: location.href,
            preparedAt,
          };
        }
      },
      ['Root', 'Agent', controller.email],
    );

    process.stderr.write(`[provision] flow=${signUpOrSignInResult.flow} status=${signUpOrSignInResult.status} email=${signUpOrSignInResult.emailAddress}\n`);

    if (!signUpOrSignInResult.status) {
      throw new Error(`Clerk ${signUpOrSignInResult.flow} returned no status for ${controller.email}`);
    }

    // Only accept OTP emails that arrive AFTER the prepare call (not stale ones)
    const otpSinceMs = signUpOrSignInResult.preparedAt ?? Date.now() - 10_000;
    const otpResult = await this.mailboxAuthority.pollOtp(controller.email, { sinceMs: otpSinceMs });

    // Attempt verification based on the flow
    const verifyResult = await page.evaluate(
      async ([code, flow]) => {
        if (flow === 'signup') {
          const signUp = window.Clerk.client.signUp;
          const result = await signUp.attemptEmailAddressVerification({ code });
          return {
            flow: 'signup',
            status: result?.status,
            createdSessionId: result?.createdSessionId,
            createdUserId: result?.createdUserId,
            href: location.href,
          };
        } else {
          const signIn = window.Clerk.client.signIn;
          const result = await signIn.attemptFirstFactor({ strategy: 'email_code', code });
          return {
            flow: 'signin',
            status: result?.status,
            createdSessionId: result?.createdSessionId,
            createdUserId: result?.createdUserId,
            href: location.href,
          };
        }
      },
      [otpResult.otp, signUpOrSignInResult.flow],
    );

    if (!verifyResult.createdSessionId) {
      throw new Error(`OTP ${signUpOrSignInResult.flow} verification failed for ${controller.email}: status=${verifyResult.status}`);
    }

    // Activate the session in this browser context
    await page.evaluate(
      async (sessionId) => {
        await window.Clerk.setActive({ session: sessionId });
        await new Promise((resolve) => setTimeout(resolve, 4_000));
      },
      verifyResult.createdSessionId,
    );

    await page.goto('https://console.agentmail.to/dashboard/overview', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    }).catch(() => {});
    await sleep(5_000);

    return {
      outcome: 'created',
      rootEmail: controller.email,
      otpKeyName: otpResult.keyName,
      clerkUserId: verifyResult.createdUserId,
      sessionId: verifyResult.createdSessionId,
      finalUrl: page.url(),
      profileDir: session.profileDir,
    };
  }

  async captureApiKey({ controller }) {
    const session = await this.ensureSession(controller);
    const page = session.page;

    // After fresh signup, AgentMail may redirect to /select-organization before showing the dashboard.
    // Handle it by clicking the auto-created "Root's Organization" or the first non-"Create" org.
    await this.ensureOrganizationSelected(page);

    for (const candidate of [
      'https://console.agentmail.to/dashboard/api-keys',
      'https://console.agentmail.to/api-keys',
    ]) {
      await page.goto(candidate, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
      await sleep(8_000);

      // If we land on select-organization again, handle it
      if (page.url().includes('/select-organization')) {
        await this.ensureOrganizationSelected(page);
        await page.goto(candidate, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
        await sleep(6_000);
      }

      // If we're on a 404 or error page, skip this URL
      const urlAfterNav = page.url();
      const bodyCheck = await page.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => '');
      if (bodyCheck.includes('404') || bodyCheck.includes("doesn't exist") || bodyCheck.includes('moved')) {
        continue;
      }

      const apiKey = await this.tryCreateApiKey(page);
      if (apiKey) {
        return {
          apiKey,
          source: 'dashboard',
          dashboardUrl: urlAfterNav,
          profileDir: session.profileDir,
        };
      }
    }

    // Last resort: scrape page body for any am_ key pattern
    const bodyText = await page.evaluate(() => document.body.innerText + '\n' + document.documentElement.outerHTML).catch(() => '');
    const bodyMatch = bodyText.match(/am_[A-Za-z0-9_]{10,}/);
    if (bodyMatch) {
      return {
        apiKey: bodyMatch[0],
        source: 'body-scrape',
        dashboardUrl: page.url(),
        profileDir: session.profileDir,
      };
    }

    throw new Error(`Unable to capture AgentMail API key for ${controller.email}`);
  }

  async ensureClerkSignUpVisible(page) {
    const visibleAlready = await page.$('#firstName-field');
    if (visibleAlready) {
      return;
    }

    await page.waitForFunction(() => Boolean(window.Clerk?.loaded), { timeout: 30_000 });
    await page.evaluate(() => {
      if (typeof window.Clerk?.openSignUp === 'function') {
        window.Clerk.openSignUp({});
      }
    });
    await sleep(2_000);
  }

  async ensureOrganizationSelected(page) {
    // Use Clerk JS API to set the active organization — more reliable than clicking DOM buttons.
    // After a fresh signup, window.Clerk.user.organizationMemberships has the auto-created org.
    const result = await page.evaluate(async () => {
      try {
        // Wait for Clerk to fully load
        if (!window.Clerk?.loaded) {
          await new Promise((resolve) => {
            const interval = setInterval(() => {
              if (window.Clerk?.loaded) { clearInterval(interval); resolve(); }
            }, 200);
            setTimeout(() => { clearInterval(interval); resolve(); }, 10_000);
          });
        }

        const memberships = window.Clerk?.user?.organizationMemberships ?? [];
        if (memberships.length === 0) {
          return { action: 'none', reason: 'no-memberships', href: location.href };
        }

        const orgId = memberships[0]?.organization?.id;
        if (!orgId) {
          return { action: 'none', reason: 'no-org-id', href: location.href };
        }

        await window.Clerk.setActive({ organization: orgId });
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        return { action: 'set-active', orgId, href: location.href };
      } catch (error) {
        return { action: 'error', error: String(error), href: location.href };
      }
    }).catch((error) => ({ action: 'evaluate-error', error: String(error) }));

    process.stderr.write(`[ensureOrg] ${JSON.stringify(result)}\n`);

    // If Clerk setActive didn't work, fall back to clicking the org button
    if (result.action !== 'set-active') {
      await this.ensureOrganizationSelectedByClick(page);
    }
  }

  async ensureOrganizationSelectedByClick(page) {
    if (!page.url().includes('/select-organization')) return;

    const buttons = await page.$$('button');
    for (const button of buttons) {
      const text = await page.evaluate((node) => node.innerText || '', button).catch(() => '');
      if (text && !text.toLowerCase().includes('create organization')) {
        process.stderr.write(`[ensureOrg] clicking org button: "${text}"\n`);
        await button.click().catch(() => {});
        await sleep(5_000);
        return;
      }
    }

    // Create a new org if none exist
    for (const button of buttons) {
      const text = await page.evaluate((node) => node.innerText || '', button).catch(() => '');
      if (text.toLowerCase().includes('create')) {
        await button.click().catch(() => {});
        await sleep(3_000);
        const nameInput = await page.$('input').catch(() => null);
        if (nameInput) {
          await nameInput.type(`Root Org ${Date.now()}`);
          const submitBtn = await page.$('button[type="submit"]').catch(() => null);
          if (submitBtn) await submitBtn.click().catch(() => {});
          await sleep(4_000);
        }
        return;
      }
    }
  }

  async ensureSession(controller) {
    const existing = this.sessions.get(controller.id);
    if (existing) {
      return existing;
    }

    const profileDir = await mkdtemp(path.join(os.tmpdir(), `pipeline-bootstrap-${controller.id}-`));
    const port = 9_800 + Math.floor(Math.random() * 100);
    const processHandle = spawn(
      'xvfb-run',
      ['-a', this.chromePath, `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check', 'about:blank'],
      { stdio: 'ignore' },
    );

    let browser = null;
    const startedAt = Date.now();
    while (!browser && Date.now() - startedAt < this.browserStartTimeoutMs) {
      try {
        browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
      } catch {
        await sleep(1_000);
      }
    }

    if (!browser) {
      throw new Error(`Failed to connect to Chrome CDP for ${controller.id}`);
    }

    const pages = await browser.pages();
    const page = pages[0] ?? (await browser.newPage());
    const session = {
      browser,
      page,
      processHandle,
      profileDir,
      port,
    };
    this.sessions.set(controller.id, session);
    return session;
  }

  async fillOtp(page, otp) {
    const otpInputs = await page.$$('input[maxlength="1"], input[inputmode="numeric"]');
    if (otpInputs.length >= 6) {
      for (let index = 0; index < 6; index += 1) {
        await otpInputs[index].type(otp[index]);
      }
      return;
    }

    const firstInput = await page.$('input');
    if (!firstInput) {
      throw new Error('OTP input not found');
    }
    await firstInput.type(otp);
  }

  async tryCreateApiKey(page) {
    const captured = { value: null };

    // Intercept API responses that contain a raw am_ key
    const responseListener = async (response) => {
      const url = response.url();
      if (!url.includes('api-key') && !url.includes('apikey')) {
        return;
      }
      try {
        const text = await response.text();
        const match = text.match(/am_[A-Za-z0-9_]{10,}/);
        if (match) {
          captured.value = match[0];
        }
      } catch {
        // ignore
      }
    };

    page.on('response', responseListener);

    try {
      // Click the first "create" button we can find
      const createLabels = ['Create API Key', 'New API Key', 'Generate', 'Add key', 'Create'];
      for (const label of createLabels) {
        const buttons = await page.$$('button');
        let clicked = false;
        for (const button of buttons) {
          const text = await page.evaluate((node) => node.innerText || '', button).catch(() => '');
          if (text.toLowerCase().includes(label.toLowerCase())) {
            await button.click().catch(() => {});
            await sleep(1_500);
            clicked = true;
            break;
          }
        }
        if (clicked) break;
      }

      // Fill name field if present
      for (const selector of ['#api-key-name', 'input[placeholder="My API Key"]', 'input[type="text"]']) {
        const input = await page.$(selector);
        if (input) {
          await input.click({ clickCount: 3 }).catch(() => {});
          await input.type(`auto-${Date.now()}`);
          break;
        }
      }

      // Click the confirm button (last matching "create api key" or "generate")
      const confirmLabels = ['CREATE API KEY', 'Create API Key', 'Create', 'Generate', 'Confirm', 'Save'];
      for (const label of confirmLabels) {
        const buttons = await page.$$('button');
        const matching = [];
        for (const button of buttons) {
          const details = await page.evaluate((node) => ({
            text: node.innerText || '',
            disabled: Boolean(node.disabled),
          }), button).catch(() => ({ text: '', disabled: true }));
          if (!details.disabled && details.text.toLowerCase().includes(label.toLowerCase())) {
            matching.push(button);
          }
        }
        if (matching.length > 0) {
          await matching.at(-1).click().catch(() => {});
          await sleep(4_000);
          break;
        }
      }

      await sleep(4_000);

      // Check what we captured from network responses first (most reliable)
      if (captured.value) return captured.value;

      // Fall back to page content scan
      const pageText = await page.evaluate(() => document.body.innerText + '\n' + document.documentElement.outerHTML).catch(() => '');
      return pageText.match(/am_[A-Za-z0-9_]{10,}/)?.[0] ?? null;
    } finally {
      page.off('response', responseListener);
    }
  }

  async cleanup() {
    for (const session of this.sessions.values()) {
      try {
        await session.browser.close();
      } catch {
        // ignore
      }
      session.processHandle.kill('SIGTERM');
      await rm(session.profileDir, { recursive: true, force: true }).catch(() => {});
    }
    this.sessions.clear();
  }
}

export function createRealStage1LiveHooks({
  artifactDir,
  cwd = process.cwd(),
  fetchImpl = globalThis.fetch,
  chromePath,
  inboxCount = 3,
  inboxDisplayNamePrefix = 'Stage1 Inbox',
} = {}) {
  const { path: envPath, values: env } = loadBootstrapEnv({ cwd });
  const mailboxAuthority = new CloudflareMailboxAuthority({ env, fetchImpl });
  const controllerDriver = new RealChromeAgentMailDriver({ env, mailboxAuthority, chromePath });

  const hooks = createStage1LiveHooks({
    artifactDir,
    fetchImpl,
    mailAuthorityVerifier: mailboxAuthority,
    controllerDriver,
    inboxCount,
    inboxDisplayNamePrefix,
  });

  return {
    ...hooks,
    envPath,
    cleanup: () => controllerDriver.cleanup(),
    getApiKeyForController: hooks.getApiKeyForController,
    createCandidateRootEmail(prefix = 'agentmailroot') {
      return `${buildRootLocalPart(prefix)}@epistemophile.space`;
    },
  };
}
