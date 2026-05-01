import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, jest, test } from '@jest/globals';

import { createStage1LiveHooks } from '../../../src/pipeline/bootstrap/liveHooks.js';

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

describe('createStage1LiveHooks', () => {
  test('writes per-stage evidence and verifies captured API keys before inbox creation', async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'bootstrap-live-hooks-'));
    const fetchImpl = jest.fn(async (url, options = {}) => {
      if (url === 'https://api.agentmail.to/v0/inboxes' && (!options.method || options.method === 'GET')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ inboxes: [], count: 0 }),
        };
      }

      if (url === 'https://api.agentmail.to/v0/inboxes' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            inbox_id: `${body.display_name.toLowerCase().replace(/\s+/g, '-')}-1@agentmail.to`,
            display_name: body.display_name,
          }),
        };
      }

      throw new Error(`unexpected fetch: ${options.method || 'GET'} ${url}`);
    });

    const mailAuthorityVerifier = {
      verify: jest.fn(async ({ controller }) => ({
        authority: 'cloudflare-routing',
        email: controller.email,
        routeId: 'rule-1',
      })),
    };

    const controllerDriver = {
      provision: jest.fn(async ({ controller }) => ({
        outcome: 'created',
        rootEmail: controller.email,
        dashboardUrl: 'https://console.agentmail.to/',
      })),
      captureApiKey: jest.fn(async () => ({
        apiKey: 'am_live_secret_value',
        source: 'dashboard',
        dashboardUrl: 'https://console.agentmail.to/api-keys',
      })),
    };

    const hooks = createStage1LiveHooks({
      artifactDir,
      now: () => '2026-03-13T16:00:00.000Z',
      fetchImpl,
      mailAuthorityVerifier,
      controllerDriver,
      inboxCount: 2,
      inboxDisplayNamePrefix: 'Stage1 Inbox',
    });

    const controller = {
      id: 'controller-root-example-com',
      email: 'root@example.com',
      status: 'pending',
    };

    const mailboxVerification = await hooks.verifyMailboxAuthority({ controller });
    const controllerProvisioning = await hooks.createOrRecoverAgentMailController({ controller });
    const apiKeyCapture = await hooks.captureApiKey({ controller });
    const inboxCreation = await hooks.createInboxes({ controller });

    expect(mailAuthorityVerifier.verify).toHaveBeenCalledWith({ controller, store: undefined });
    expect(controllerDriver.provision).toHaveBeenCalledWith({ controller, store: undefined });
    expect(controllerDriver.captureApiKey).toHaveBeenCalledWith({ controller, store: undefined });

    expect(mailboxVerification).toEqual({
      authority: 'cloudflare-routing',
      email: 'root@example.com',
      routeId: 'rule-1',
      recordedAt: '2026-03-13T16:00:00.000Z',
      artifactPath: path.join(artifactDir, 'controller-root-example-com', 'mailbox-verification.json'),
    });

    expect(controllerProvisioning).toEqual({
      outcome: 'created',
      rootEmail: 'root@example.com',
      dashboardUrl: 'https://console.agentmail.to/',
      recordedAt: '2026-03-13T16:00:00.000Z',
      artifactPath: path.join(artifactDir, 'controller-root-example-com', 'controller-provisioning.json'),
    });

    expect(apiKeyCapture).toEqual({
      source: 'dashboard',
      dashboardUrl: 'https://console.agentmail.to/api-keys',
      verification: {
        ok: true,
        status: 200,
        endpoint: 'https://api.agentmail.to/v0/inboxes',
      },
      apiKeyPrefix: 'am_li',
      recordedAt: '2026-03-13T16:00:00.000Z',
      artifactPath: path.join(artifactDir, 'controller-root-example-com', 'api-key-capture.json'),
    });

    expect(inboxCreation).toEqual({
      inboxCount: 2,
      inboxIds: ['stage1-inbox-1-1@agentmail.to', 'stage1-inbox-2-1@agentmail.to'],
      recordedAt: '2026-03-13T16:00:00.000Z',
      artifactPath: path.join(artifactDir, 'controller-root-example-com', 'inbox-creation.json'),
    });

    await expect(readJson(path.join(artifactDir, 'controller-root-example-com', 'api-key-capture.json'))).resolves.toEqual({
      controllerId: 'controller-root-example-com',
      controllerEmail: 'root@example.com',
      stage: 'api-key-capture',
      recordedAt: '2026-03-13T16:00:00.000Z',
      source: 'dashboard',
      dashboardUrl: 'https://console.agentmail.to/api-keys',
      verification: {
        ok: true,
        status: 200,
        endpoint: 'https://api.agentmail.to/v0/inboxes',
      },
      apiKeyPrefix: 'am_li',
    });
  });

  test('captureApiKey throws a classified error when API verification fails', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => 'forbidden',
    }));

    const hooks = createStage1LiveHooks({
      artifactDir: await mkdtemp(path.join(os.tmpdir(), 'bootstrap-live-hooks-')),
      fetchImpl,
      mailAuthorityVerifier: {
        verify: async () => ({ authority: 'cloudflare-routing' }),
      },
      controllerDriver: {
        provision: async () => ({ outcome: 'created' }),
        captureApiKey: async () => ({ apiKey: 'am_bad_key', source: 'dashboard' }),
      },
    });

    const controller = { id: 'controller-bad', email: 'bad@example.com', status: 'pending' };

    await hooks.createOrRecoverAgentMailController({ controller });

    await expect(hooks.captureApiKey({ controller })).rejects.toMatchObject({
      message: 'AgentMail API verification failed with status 403',
      code: 'AGENTMAIL_API_KEY_VERIFICATION_FAILED',
      status: 403,
      details: {
        endpoint: 'https://api.agentmail.to/v0/inboxes',
        bodySnippet: 'forbidden',
      },
    });
  });
});
