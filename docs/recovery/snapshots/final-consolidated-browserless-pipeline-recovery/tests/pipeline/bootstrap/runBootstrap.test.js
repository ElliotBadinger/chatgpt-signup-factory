import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, jest, test } from '@jest/globals';

import { loadJsonFile } from '../../../src/pipeline/state/store.js';
import { runBootstrap } from '../../../src/pipeline/bootstrap/runBootstrap.js';

async function readJsonl(filePath) {
  const content = await readFile(filePath, 'utf8');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('runBootstrap', () => {
  test('dry run creates ready controller records and lifecycle events without calling external hooks or consuming targets', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-bootstrap-'));
    const artifactDir = path.join(stateDir, 'artifacts', 'bootstrap');
    const writeHandoffBundle = jest.fn(async () => {});
    const hooks = {
      verifyMailboxAuthority: jest.fn(),
      createOrRecoverAgentMailController: jest.fn(),
      captureApiKey: jest.fn(),
      createInboxes: jest.fn(),
    };

    const result = await runBootstrap({
      stateDir,
      artifactDir,
      writeHandoffBundle,
      dryRun: true,
      candidateRootEmails: ['Root+One@example.com', 'root.two@example.com'],
      now: () => '2026-03-13T14:00:00.000Z',
      ...hooks,
    });

    expect(hooks.verifyMailboxAuthority).not.toHaveBeenCalled();
    expect(hooks.createOrRecoverAgentMailController).not.toHaveBeenCalled();
    expect(hooks.captureApiKey).not.toHaveBeenCalled();
    expect(hooks.createInboxes).not.toHaveBeenCalled();
    expect(writeHandoffBundle).toHaveBeenCalledTimes(2);
    expect(writeHandoffBundle).toHaveBeenNthCalledWith(
      1,
      path.join(artifactDir, 'controller-root-one-example-com'),
      expect.objectContaining({
        target: 'root+one@example.com',
        inviter: 'bootstrap',
        status: 'ready',
        resumeCommand: expect.stringContaining('pipeline-bootstrap.js'),
        statusCommand: expect.stringContaining('pipeline-status.js'),
      }),
    );

    expect(result).toEqual({
      dryRun: true,
      controllers: [
        {
          id: 'controller-root-one-example-com',
          email: 'root+one@example.com',
          status: 'ready',
          successfulInviteCount: 0,
          createdAt: '2026-03-13T14:00:00.000Z',
          updatedAt: '2026-03-13T14:00:00.000Z',
          outputs: {
            mailboxVerification: { dryRun: true, email: 'root+one@example.com' },
            controllerProvisioning: { dryRun: true, email: 'root+one@example.com' },
            apiKeyCapture: { dryRun: true, email: 'root+one@example.com' },
            inboxCreation: { dryRun: true, email: 'root+one@example.com', inboxCount: 0 },
          },
        },
        {
          id: 'controller-root-two-example-com',
          email: 'root.two@example.com',
          status: 'ready',
          successfulInviteCount: 0,
          createdAt: '2026-03-13T14:00:00.000Z',
          updatedAt: '2026-03-13T14:00:00.000Z',
          outputs: {
            mailboxVerification: { dryRun: true, email: 'root.two@example.com' },
            controllerProvisioning: { dryRun: true, email: 'root.two@example.com' },
            apiKeyCapture: { dryRun: true, email: 'root.two@example.com' },
            inboxCreation: { dryRun: true, email: 'root.two@example.com', inboxCount: 0 },
          },
        },
      ],
    });

    await expect(loadJsonFile(path.join(stateDir, 'controller_registry.json'), [])).resolves.toEqual([
      {
        id: 'controller-root-one-example-com',
        email: 'root+one@example.com',
        status: 'ready',
        successfulInviteCount: 0,
        createdAt: '2026-03-13T14:00:00.000Z',
        updatedAt: '2026-03-13T14:00:00.000Z',
      },
      {
        id: 'controller-root-two-example-com',
        email: 'root.two@example.com',
        status: 'ready',
        successfulInviteCount: 0,
        createdAt: '2026-03-13T14:00:00.000Z',
        updatedAt: '2026-03-13T14:00:00.000Z',
      },
    ]);

    await expect(loadJsonFile(path.join(stateDir, 'target_registry.json'), [])).resolves.toEqual([]);

    await expect(readJsonl(path.join(stateDir, 'run_history.jsonl'))).resolves.toEqual([
      {
        at: '2026-03-13T14:00:00.000Z',
        stage: 'bootstrap',
        entity_type: 'controller',
        entity_id: 'controller-root-one-example-com',
        from_status: 'pending',
        to_status: 'ready',
        metadata: {
          dryRun: true,
          email: 'root+one@example.com',
          mailboxVerification: { dryRun: true, email: 'root+one@example.com' },
          controllerProvisioning: { dryRun: true, email: 'root+one@example.com' },
          apiKeyCapture: { dryRun: true, email: 'root+one@example.com' },
          inboxCreation: { dryRun: true, email: 'root+one@example.com', inboxCount: 0 },
        },
      },
      {
        at: '2026-03-13T14:00:00.000Z',
        stage: 'bootstrap',
        entity_type: 'controller',
        entity_id: 'controller-root-two-example-com',
        from_status: 'pending',
        to_status: 'ready',
        metadata: {
          dryRun: true,
          email: 'root.two@example.com',
          mailboxVerification: { dryRun: true, email: 'root.two@example.com' },
          controllerProvisioning: { dryRun: true, email: 'root.two@example.com' },
          apiKeyCapture: { dryRun: true, email: 'root.two@example.com' },
          inboxCreation: { dryRun: true, email: 'root.two@example.com', inboxCount: 0 },
        },
      },
    ]);
  });

  test('live mode orchestrates injected hooks in order and persists their outputs with the ready controller', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-bootstrap-'));
    const artifactDir = path.join(stateDir, 'artifacts', 'bootstrap');
    const calls = [];
    const writeHandoffBundle = jest.fn(async () => {});

    const result = await runBootstrap({
      stateDir,
      artifactDir,
      writeHandoffBundle,
      candidateRootEmails: ['controller@example.com'],
      now: () => '2026-03-13T14:05:00.000Z',
      verifyMailboxAuthority: jest.fn(async ({ controller }) => {
        calls.push(['verifyMailboxAuthority', controller.id]);
        return { authority: 'verified', artifactPath: '/evidence/mailbox.json' };
      }),
      createOrRecoverAgentMailController: jest.fn(async ({ controller }) => {
        calls.push(['createOrRecoverAgentMailController', controller.id]);
        return { agentMailId: 'am-1', artifactPath: '/evidence/controller.json' };
      }),
      captureApiKey: jest.fn(async ({ controller }) => {
        calls.push(['captureApiKey', controller.id]);
        return { keyCaptured: true, artifactPath: '/evidence/key.json' };
      }),
      createInboxes: jest.fn(async ({ controller }) => {
        calls.push(['createInboxes', controller.id]);
        return { inboxIds: ['inbox-1', 'inbox-2'], artifactPath: '/evidence/inboxes.json' };
      }),
    });

    expect(calls).toEqual([
      ['verifyMailboxAuthority', 'controller-controller-example-com'],
      ['createOrRecoverAgentMailController', 'controller-controller-example-com'],
      ['captureApiKey', 'controller-controller-example-com'],
      ['createInboxes', 'controller-controller-example-com'],
    ]);

    expect(result.controllers).toEqual([
      {
        id: 'controller-controller-example-com',
        email: 'controller@example.com',
        status: 'ready',
        successfulInviteCount: 0,
        createdAt: '2026-03-13T14:05:00.000Z',
        updatedAt: '2026-03-13T14:05:00.000Z',
        outputs: {
          mailboxVerification: { authority: 'verified', artifactPath: '/evidence/mailbox.json' },
          controllerProvisioning: { agentMailId: 'am-1', artifactPath: '/evidence/controller.json' },
          apiKeyCapture: { keyCaptured: true, artifactPath: '/evidence/key.json' },
          inboxCreation: { inboxIds: ['inbox-1', 'inbox-2'], artifactPath: '/evidence/inboxes.json' },
        },
      },
    ]);

    expect(writeHandoffBundle).toHaveBeenCalledWith(
      path.join(artifactDir, 'controller-controller-example-com'),
      expect.objectContaining({
        target: 'controller@example.com',
        status: 'ready',
        proofPaths: [
          '/evidence/mailbox.json',
          '/evidence/controller.json',
          '/evidence/key.json',
          '/evidence/inboxes.json',
        ],
      }),
    );

    await expect(readJsonl(path.join(stateDir, 'run_history.jsonl'))).resolves.toEqual([
      {
        at: '2026-03-13T14:05:00.000Z',
        stage: 'bootstrap',
        entity_type: 'controller',
        entity_id: 'controller-controller-example-com',
        from_status: 'pending',
        to_status: 'ready',
        metadata: {
          dryRun: false,
          email: 'controller@example.com',
          mailboxVerification: { authority: 'verified', artifactPath: '/evidence/mailbox.json' },
          controllerProvisioning: { agentMailId: 'am-1', artifactPath: '/evidence/controller.json' },
          apiKeyCapture: { keyCaptured: true, artifactPath: '/evidence/key.json' },
          inboxCreation: { inboxIds: ['inbox-1', 'inbox-2'], artifactPath: '/evidence/inboxes.json' },
        },
      },
    ]);
  });

  test('failed bootstrap transitions the controller to failed and records the failure event', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-bootstrap-'));

    await expect(
      runBootstrap({
        stateDir,
        candidateRootEmails: ['broken@example.com'],
        now: () => '2026-03-13T14:10:00.000Z',
        verifyMailboxAuthority: async () => {
          throw new Error('mailbox authority check failed');
        },
      }),
    ).rejects.toThrow('mailbox authority check failed');

    await expect(loadJsonFile(path.join(stateDir, 'controller_registry.json'), [])).resolves.toEqual([
      {
        id: 'controller-broken-example-com',
        email: 'broken@example.com',
        status: 'failed',
        successfulInviteCount: 0,
        createdAt: '2026-03-13T14:10:00.000Z',
        updatedAt: '2026-03-13T14:10:00.000Z',
      },
    ]);

    await expect(readJsonl(path.join(stateDir, 'run_history.jsonl'))).resolves.toEqual([
      {
        at: '2026-03-13T14:10:00.000Z',
        stage: 'bootstrap',
        entity_type: 'controller',
        entity_id: 'controller-broken-example-com',
        from_status: 'pending',
        to_status: 'failed',
        metadata: {
          dryRun: false,
          email: 'broken@example.com',
          error: 'mailbox authority check failed',
        },
      },
    ]);
  });
});
