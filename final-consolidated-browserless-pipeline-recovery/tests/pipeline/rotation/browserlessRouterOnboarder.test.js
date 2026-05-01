import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let authPath;
let routerPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserless-router-onboarder-'));
  authPath = path.join(tmpDir, 'auth.json');
  routerPath = path.join(tmpDir, 'account-router.json');
  fs.writeFileSync(authPath, JSON.stringify({}, null, 2));
  fs.writeFileSync(routerPath, JSON.stringify({
    version: 1,
    aliases: [],
    pools: [{ name: 'openai-codex', providers: [], routes: [] }],
    policy: {},
  }, null, 2));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe('browserlessRouterOnboarder', () => {
  test('registers a browserless workspace member into Pi router state without legacy browser helpers', async () => {
    const { onboardBrowserlessInboxToPiRouter } = await import('../../../src/pipeline/rotation/browserlessRouterOnboarder.js');
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

    const result = await onboardBrowserlessInboxToPiRouter({
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

  test('threads selected workspace into browserless member onboarding', async () => {
    const { onboardBrowserlessInboxToPiRouter } = await import('../../../src/pipeline/rotation/browserlessRouterOnboarder.js');
    const browserlessOnboardMember = jest.fn().mockResolvedValue({
      accessToken: makeJwt('member@example.com'),
      expiresAt: new Date('2026-06-13T18:59:15.674Z').getTime(),
      accountId: 'workspace-selected',
      workspaceId: 'workspace-selected',
      refreshToken: 'ref_workspace',
      personalAccountId: 'personal-123',
      identityEmail: 'member@example.com',
      joinedVia: 'invites-accept',
    });
    const selectedWorkspace = { workspaceId: 'workspace-selected', workspaceName: 'Selected' };

    await onboardBrowserlessInboxToPiRouter({
      email: 'member@example.com',
      apiKey: 'am_us_test',
      authJsonPath: authPath,
      routerJsonPath: routerPath,
      browserlessOnboardMember,
      selectedWorkspace,
    });

    expect(browserlessOnboardMember).toHaveBeenCalledWith(expect.objectContaining({
      selectedWorkspace,
    }));
  });

  test('browserless-only module source stays free of puppeteer-core imports', () => {
    const modulePath = path.resolve('src/pipeline/rotation/browserlessRouterOnboarder.js');
    const source = fs.readFileSync(modulePath, 'utf8');

    expect(source).not.toMatch(/puppeteer-core/);
    expect(source).not.toMatch(/chatGptAccountCreator\.js/);
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
