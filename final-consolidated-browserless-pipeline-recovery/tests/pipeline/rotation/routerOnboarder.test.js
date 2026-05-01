import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fetchLatestInboxOtp, pollFreshInboxOtp } from '../../../src/pipeline/authTrace/agentMailOtp.js';
import {
  extractRouterAuthFromSession,
  onboardInboxToPiRouter,
} from '../../../src/pipeline/rotation/routerOnboarder.js';

let tmpDir;
let authPath;
let routerPath;
let savedFetch;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-onboarder-'));
  authPath = path.join(tmpDir, 'auth.json');
  routerPath = path.join(tmpDir, 'account-router.json');
  fs.writeFileSync(authPath, JSON.stringify({}, null, 2));
  fs.writeFileSync(routerPath, JSON.stringify({
    version: 1,
    aliases: [],
    pools: [{ name: 'openai-codex', providers: [], routes: [] }],
    policy: {},
  }, null, 2));
  savedFetch = global.fetch;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  global.fetch = savedFetch;
  jest.restoreAllMocks();
});

describe('fetchLatestInboxOtp', () => {
  test('returns latest OTP-bearing message for an inbox', async () => {
    global.fetch = jest.fn().mockImplementation(async (url) => {
      if (String(url).includes('/messages?limit=10')) {
        return {
          ok: true,
          json: async () => ({
            messages: [
              { message_id: 'm1', timestamp: '2026-03-15T18:55:37.000Z', subject: 'Your ChatGPT code is 619121' },
              { message_id: 'm2', timestamp: '2026-03-15T18:56:43.000Z', subject: 'Your ChatGPT code is 640151' },
              { message_id: 'm3', timestamp: '2026-03-15T18:50:00.000Z', subject: 'Welcome' },
            ],
          }),
        };
      }
      if (String(url).includes('/messages/m2')) {
        return {
          ok: true,
          json: async () => ({
            message_id: 'm2',
            subject: 'Your ChatGPT code is 640151',
            text: 'Your ChatGPT code is 640151',
            timestamp: '2026-03-15T18:56:43.000Z',
          }),
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await fetchLatestInboxOtp({
      inboxId: 'lovelypopulation489@agentmail.to',
      apiKey: 'am_us_test',
    });

    expect(result).toEqual(expect.objectContaining({
      otp: '640151',
      messageId: 'm2',
      subject: 'Your ChatGPT code is 640151',
    }));
  });

  test('fetches recent full messages so OTP is found even when the list response lacks a code-bearing preview', async () => {
    const requests = [];
    global.fetch = jest.fn().mockImplementation(async (url) => {
      requests.push(String(url));
      if (String(url).includes('/messages?limit=10')) {
        return {
          ok: true,
          json: async () => ({
            messages: [
              { message_id: 'm9', timestamp: '2026-03-15T18:56:43.000Z', subject: 'OpenAI', preview: '' },
            ],
          }),
        };
      }
      if (String(url).includes('/messages/m9')) {
        return {
          ok: true,
          json: async () => ({
            message_id: 'm9',
            timestamp: '2026-03-15T18:56:43.000Z',
            subject: 'Your ChatGPT code is 640151',
            text: 'Your ChatGPT code is 640151',
          }),
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await fetchLatestInboxOtp({
      inboxId: 'lovelypopulation489@agentmail.to',
      apiKey: 'am_us_test',
      sinceMs: new Date('2026-03-15T18:55:00.000Z').getTime(),
    });

    expect(result.otp).toBe('640151');
    expect(requests).toEqual(expect.arrayContaining([
      'https://api.agentmail.to/v0/inboxes/lovelypopulation489%40agentmail.to/messages?limit=10',
      'https://api.agentmail.to/v0/inboxes/lovelypopulation489%40agentmail.to/messages/m9',
    ]));
  });

  test('applies a freshness grace window so same-second OTP timestamps are not dropped', async () => {
    global.fetch = jest.fn().mockImplementation(async (url) => {
      if (String(url).includes('/messages?limit=10')) {
        return {
          ok: true,
          json: async () => ({
            messages: [
              { message_id: 'm10', timestamp: '2026-03-16T21:41:23.000Z', subject: 'Your ChatGPT code is 446033' },
            ],
          }),
        };
      }
      if (String(url).includes('/messages/m10')) {
        return {
          ok: true,
          json: async () => ({
            message_id: 'm10',
            timestamp: '2026-03-16T21:41:23.000Z',
            subject: 'Your ChatGPT code is 446033',
            text: 'Your ChatGPT code is 446033',
          }),
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await fetchLatestInboxOtp({
      inboxId: 'lovelypopulation489@agentmail.to',
      apiKey: 'am_us_test',
      sinceMs: new Date('2026-03-16T21:41:23.500Z').getTime(),
    });

    expect(result.otp).toBe('446033');
  });
});

describe('pollFreshInboxOtp', () => {
  test('retries until a fresh OTP arrives', async () => {
    let listCalls = 0;
    global.fetch = jest.fn().mockImplementation(async (url) => {
      if (String(url).includes('/messages?limit=10')) {
        return {
          ok: true,
          json: async () => ({
            messages: listCalls++ === 0
              ? [{ message_id: 'old', timestamp: '2026-03-15T18:54:00.000Z', subject: 'Your ChatGPT code is 111111' }]
              : [{ message_id: 'new', timestamp: '2026-03-15T18:56:43.000Z', subject: 'Your ChatGPT code is 640151' }],
          }),
        };
      }
      if (String(url).includes('/messages/new')) {
        return {
          ok: true,
          json: async () => ({
            message_id: 'new',
            timestamp: '2026-03-15T18:56:43.000Z',
            subject: 'Your ChatGPT code is 640151',
            text: 'Your ChatGPT code is 640151',
          }),
        };
      }
      if (String(url).includes('/messages/old')) {
        return {
          ok: true,
          json: async () => ({
            message_id: 'old',
            timestamp: '2026-03-15T18:54:00.000Z',
            subject: 'Your ChatGPT code is 111111',
            text: 'Your ChatGPT code is 111111',
          }),
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await pollFreshInboxOtp({
      inboxId: 'lovelypopulation489@agentmail.to',
      apiKey: 'am_us_test',
      sinceMs: new Date('2026-03-15T18:55:00.000Z').getTime(),
      pollIntervalMs: 1,
      timeoutMs: 100,
      fetchImpl: global.fetch,
    });

    expect(result.otp).toBe('640151');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
});

describe('extractRouterAuthFromSession', () => {
  test('maps browser session payload into router auth fields', () => {
    const result = extractRouterAuthFromSession({
      user: { email: 'eagerstatus254@agentmail.to' },
      expires: '2026-06-13T18:59:15.674Z',
      account: { id: 'd3d588b2-8a74-4acc-aa2e-94662ff0e025' },
      accessToken: 'tok_live',
    }, 'eagerstatus254@agentmail.to');

    expect(result).toEqual({
      accessToken: 'tok_live',
      refreshToken: null,
      expiresAt: new Date('2026-06-13T18:59:15.674Z').getTime(),
      accountId: 'd3d588b2-8a74-4acc-aa2e-94662ff0e025',
      identityEmail: 'eagerstatus254@agentmail.to',
    });
  });
});

describe('onboardInboxToPiRouter', () => {
  test('registers a browserless workspace member into Pi router state', async () => {
    const browserlessOnboardMember = jest.fn().mockResolvedValue({
      accessToken: makeJwt('crowdedspirit765@agentmail.to'),
      expiresAt: new Date('2026-06-13T18:59:15.674Z').getTime(),
      accountId: 'workspace-123',
      workspaceId: 'workspace-123',
      refreshToken: 'ref_workspace',
      personalAccountId: 'personal-123',
      identityEmail: 'crowdedspirit765@agentmail.to',
      joinedVia: 'invites-accept',
    });

    const result = await onboardInboxToPiRouter({
      email: 'crowdedspirit765@agentmail.to',
      apiKey: 'am_us_test',
      authJsonPath: authPath,
      routerJsonPath: routerPath,
      browserlessOnboardMember,
      inviteMember: jest.fn().mockResolvedValue({ id: 'invite-1' }),
      ownerClient: { listUsers: jest.fn().mockResolvedValue({ items: [{ email: 'crowdedspirit765@agentmail.to' }] }) },
    });

    expect(browserlessOnboardMember).toHaveBeenCalledWith(expect.objectContaining({
      email: 'crowdedspirit765@agentmail.to',
      agentMailApiKey: 'am_us_test',
    }));
    expect(result.aliasId).toBe('crowdedspirit765');
    expect(result.verification.pass).toBe(true);

    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    expect(auth.crowdedspirit765.accountId).toBe('workspace-123');
  });

  test('prepares login, fetches fresh OTP, completes session, and verifies durable state', async () => {
    global.fetch = jest.fn().mockImplementation(async (url) => {
      if (String(url).includes('/messages?limit=10')) {
        return {
          ok: true,
          json: async () => ({
            messages: [
              { message_id: 'm1', timestamp: '2026-03-15T18:55:37.000Z', subject: 'Your ChatGPT code is 619121' },
            ],
          }),
        };
      }
      if (String(url).includes('/messages/m1')) {
        return {
          ok: true,
          json: async () => ({
            message_id: 'm1',
            timestamp: '2026-03-15T18:55:37.000Z',
            subject: 'Your ChatGPT code is 619121',
            text: 'Your ChatGPT code is 619121',
          }),
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const prepareLogin = jest.fn().mockResolvedValue({
      otpRequestedAt: new Date('2026-03-15T18:55:00.000Z').getTime(),
      page: {},
      cleanup: jest.fn().mockResolvedValue({}),
      fillRes: { emailFilled: true },
      state: { state: 'otp-needed', url: 'https://auth.openai.com/email-verification' },
    });

    const completeLogin = jest.fn().mockResolvedValue({
      finalUrl: 'https://chatgpt.com/',
      title: 'ChatGPT',
      session: {
        user: { email: 'eagerstatus254@agentmail.to' },
        expires: '2026-06-13T18:59:15.674Z',
        account: { id: 'd3d588b2-8a74-4acc-aa2e-94662ff0e025', planType: 'team' },
        accessToken: makeJwt('eagerstatus254@agentmail.to'),
        refreshToken: 'ref_browser',
        authProvider: 'openai',
      },
    });

    const result = await onboardInboxToPiRouter({
      email: 'eagerstatus254@agentmail.to',
      apiKey: 'am_us_test',
      authJsonPath: authPath,
      routerJsonPath: routerPath,
      prepareLogin,
      completeLogin,
    });

    expect(prepareLogin).toHaveBeenCalledWith(expect.objectContaining({ email: 'eagerstatus254@agentmail.to' }));
    expect(completeLogin).toHaveBeenCalledWith(expect.objectContaining({ otp: '619121' }));
    expect(result.aliasId).toBe('eagerstatus254');
    expect(result.otp.otp).toBe('619121');
    expect(result.verification.pass).toBe(true);

    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    expect(auth.eagerstatus254.access).toBeTruthy();

    const router = JSON.parse(fs.readFileSync(routerPath, 'utf8'));
    expect(router.aliases.find((a) => a.id === 'eagerstatus254')?.email).toBe('eagerstatus254@agentmail.to');
    const pool = router.pools.find((p) => p.name === 'openai-codex');
    expect(pool.providers).toContain('eagerstatus254');
    expect(pool.routes).toContainEqual({ provider: 'eagerstatus254', model: 'gpt-5.4' });
  });
});

function makeJwt(email) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/profile': {
      email,
      email_verified: true,
    },
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'team',
    },
  })).toString('base64url');
  return `${header}.${payload}.sig`;
}
