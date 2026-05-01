import { describe, test, expect, jest } from '@jest/globals';

import {
  collectRuntimeExhaustedAliases,
  createLiveBootstrapLineageRunner,
  verifyRecoveredInboxUsability,
} from '../../src/cli/pipelineCheckArchiveReplaceLiveFix.js';

describe('collectRuntimeExhaustedAliases', () => {
  test('restricts exhausted-demand collection to active openai-codex aliases and excludes anthropic/ob1 cooldown aliases', () => {
    const exhausted = collectRuntimeExhaustedAliases({
      routerData: {
        aliases: [
          { id: 'codexA', cloneFrom: 'openai-codex', email: 'codexA@agentmail.to', disabled: false, lineage: 'lineage-a' },
          { id: 'ob1A', cloneFrom: 'anthropic', email: 'ob1A@agentmail.to', disabled: false, lineage: 'lineage-ob1' },
          { id: 'codexDisabled', cloneFrom: 'openai-codex', email: 'codexDisabled@agentmail.to', disabled: true, lineage: 'lineage-a' },
        ],
        pools: [{ name: 'openai-codex', providers: ['codexA'], routes: [] }],
      },
      healthData: {
        providers: {
          codexA: { status: 'cooldown' },
          ob1A: { status: 'cooldown' },
          codexDisabled: { status: 'cooldown' },
        },
      },
    });

    expect(exhausted).toEqual([
      expect.objectContaining({ aliasId: 'codexA', email: 'codexA@agentmail.to' }),
    ]);
  });
});

describe('createLiveBootstrapLineageRunner', () => {
  test('uses the live bootstrap path and returns real pool entries with created inbox addresses', async () => {
    const cleanup = jest.fn().mockResolvedValue();
    const createRealHooks = jest.fn().mockReturnValue({
      verifyMailboxAuthority: jest.fn(),
      createOrRecoverAgentMailController: jest.fn(),
      captureApiKey: jest.fn(),
      createInboxes: jest.fn(),
      getApiKeyForController: jest.fn().mockReturnValue('am_us_livekey123456'),
      cleanup,
    });
    const runBootstrap = jest.fn().mockResolvedValue({
      controllers: [{
        id: 'controller-owner-a-example-com',
        email: 'owner-a@example.com',
        outputs: {
          inboxCreation: {
            inboxIds: ['inbox-1', 'inbox-2'],
          },
        },
      }],
    });
    const listInboxes = jest.fn().mockResolvedValue([
      { inbox_id: 'inbox-1', email_address: 'fresh1@agentmail.to' },
      { inbox_id: 'inbox-2', email_address: 'fresh2@agentmail.to' },
    ]);

    const bootstrapLineage = createLiveBootstrapLineageRunner({
      cwd: '/tmp/project',
      createRealHooks,
      runBootstrap,
      listInboxes,
      now: () => 1700000000000,
    });

    const result = await bootstrapLineage({
      lineage: 'lineage-a',
      ownerAliasId: 'owner-a',
      ownerEmail: 'owner-a@example.com',
      workspaceId: 'workspace-a',
    });

    expect(createRealHooks).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/project',
      artifactDir: expect.stringContaining('artifacts/bootstrap-live-fix/1700000000000-lineage-a'),
      inboxCount: 3,
    }));
    expect(runBootstrap).toHaveBeenCalledWith(expect.objectContaining({
      candidateRootEmails: ['owner-a@example.com'],
      dryRun: false,
    }));
    expect(listInboxes).toHaveBeenCalledWith('am_us_livekey123456');
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      createdEntries: [
        expect.objectContaining({
          inboxAddress: 'fresh1@agentmail.to',
          agentMailInboxId: 'inbox-1',
          rootEmail: 'owner-a@example.com',
          rootApiKey: 'am_us_livekey123456',
          workspaceGroupKey: 'lineage-a',
          workspaceId: 'workspace-a',
          status: 'available',
        }),
        expect.objectContaining({
          inboxAddress: 'fresh2@agentmail.to',
          agentMailInboxId: 'inbox-2',
        }),
      ],
    }));
    expect(cleanup).toHaveBeenCalled();
  });

  test('recovers existing live inboxes missing from the pool when inbox creation is quota-blocked', async () => {
    const cleanup = jest.fn().mockResolvedValue();
    const createRealHooks = jest.fn().mockReturnValue({
      verifyMailboxAuthority: jest.fn(),
      createOrRecoverAgentMailController: jest.fn(),
      captureApiKey: jest.fn(),
      createInboxes: jest.fn(),
      getApiKeyForController: jest.fn().mockReturnValue('am_us_livekey123456'),
      cleanup,
    });
    const runBootstrap = jest.fn().mockRejectedValue(new Error('AgentMail inbox creation failed with status 403'));
    const listInboxes = jest.fn().mockResolvedValue([
      { inbox_id: 'known-inbox', email_address: 'known@agentmail.to' },
      { inbox_id: 'recover-1', email_address: 'recover1@agentmail.to' },
      { inbox_id: 'recover-2', email_address: 'recover2@agentmail.to' },
    ]);

    const bootstrapLineage = createLiveBootstrapLineageRunner({
      cwd: '/tmp/project',
      createRealHooks,
      runBootstrap,
      listInboxes,
      verifyRecoveredEntry: jest.fn().mockResolvedValue({ ok: true, authBranch: 'existing-login-otp' }),
      now: () => 1700000000000,
    });

    const result = await bootstrapLineage({
      lineage: 'lineage-a',
      ownerAliasId: 'owner-a',
      ownerEmail: 'owner-a@example.com',
      workspaceId: 'workspace-a',
      knownPoolEntries: [
        {
          rootEmail: 'owner-a@example.com',
          agentMailInboxId: 'known-inbox',
          inboxAddress: 'known@agentmail.to',
        },
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      reason: 'bootstrap-recovered-existing-live-inboxes',
      recoverySourceError: 'AgentMail inbox creation failed with status 403',
      createdEntries: [
        expect.objectContaining({ inboxAddress: 'recover1@agentmail.to', agentMailInboxId: 'recover-1' }),
        expect.objectContaining({ inboxAddress: 'recover2@agentmail.to', agentMailInboxId: 'recover-2' }),
      ],
    }));
    expect(result.createdEntries).toHaveLength(2);
    expect(cleanup).toHaveBeenCalled();
  });

  test('excludes recovered inboxes that deterministically replay into password-only login', async () => {
    const cleanup = jest.fn().mockResolvedValue();
    const createRealHooks = jest.fn().mockReturnValue({
      verifyMailboxAuthority: jest.fn(),
      createOrRecoverAgentMailController: jest.fn(),
      captureApiKey: jest.fn(),
      createInboxes: jest.fn(),
      getApiKeyForController: jest.fn().mockReturnValue('am_us_livekey123456'),
      cleanup,
    });
    const runBootstrap = jest.fn().mockRejectedValue(new Error('AgentMail inbox creation failed with status 403'));
    const listInboxes = jest.fn().mockResolvedValue([
      { inbox_id: 'recover-bad', email_address: 'recover-bad@agentmail.to' },
      { inbox_id: 'recover-good', email_address: 'recover-good@agentmail.to' },
    ]);
    const verifyRecoveredEntry = jest.fn(async ({ email }) => {
      if (email === 'recover-bad@agentmail.to') {
        return { ok: false, reason: 'password-login-unsupported', authBranch: 'password-login' };
      }
      return { ok: true, authBranch: 'existing-login-otp' };
    });

    const bootstrapLineage = createLiveBootstrapLineageRunner({
      cwd: '/tmp/project',
      createRealHooks,
      runBootstrap,
      listInboxes,
      verifyRecoveredEntry,
      now: () => 1700000000000,
    });

    const result = await bootstrapLineage({
      lineage: 'lineage-a',
      ownerAliasId: 'owner-a',
      ownerEmail: 'owner-a@example.com',
      workspaceId: 'workspace-a',
    });

    expect(verifyRecoveredEntry).toHaveBeenCalledTimes(2);
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      reason: 'bootstrap-recovered-existing-live-inboxes',
      createdEntries: [
        expect.objectContaining({ inboxAddress: 'recover-good@agentmail.to', agentMailInboxId: 'recover-good' }),
      ],
    }));
    expect(result.createdEntries).toHaveLength(1);
    expect(result.excludedEntries).toEqual([
      expect.objectContaining({
        inboxAddress: 'recover-bad@agentmail.to',
        reason: 'password-login-unsupported',
        authBranch: 'password-login',
      }),
    ]);
    expect(cleanup).toHaveBeenCalled();
  });

  test('re-evaluates failed known pool entries instead of treating them as already-usable-known capacity', async () => {
    const cleanup = jest.fn().mockResolvedValue();
    const createRealHooks = jest.fn().mockReturnValue({
      verifyMailboxAuthority: jest.fn(),
      createOrRecoverAgentMailController: jest.fn(),
      captureApiKey: jest.fn(),
      createInboxes: jest.fn(),
      getApiKeyForController: jest.fn().mockReturnValue('am_us_livekey123456'),
      cleanup,
    });
    const runBootstrap = jest.fn().mockRejectedValue(new Error('AgentMail inbox creation failed with status 403'));
    const listInboxes = jest.fn().mockResolvedValue([
      { inbox_id: 'known-1', email_address: 'known1@agentmail.to' },
      { inbox_id: 'known-2', email_address: 'known2@agentmail.to' },
    ]);

    const bootstrapLineage = createLiveBootstrapLineageRunner({
      cwd: '/tmp/project',
      createRealHooks,
      runBootstrap,
      listInboxes,
      verifyRecoveredEntry: jest.fn().mockResolvedValue({ ok: true, authBranch: 'existing-login-otp' }),
      allowFreshRootEscalation: false,
      now: () => 1700000000000,
    });

    const result = await bootstrapLineage({
      lineage: 'workspace-owner-a',
      ownerAliasId: 'workspace-owner-a',
      ownerEmail: 'root@example.com',
      workspaceId: 'workspace-a',
      workspaceName: 'Root-Mail_a',
      knownPoolEntries: [
        { rootEmail: 'root@example.com', agentMailInboxId: 'known-1', inboxAddress: 'known1@agentmail.to', status: 'failed' },
        { rootEmail: 'root@example.com', agentMailInboxId: 'known-2', inboxAddress: 'known2@agentmail.to', status: 'failed' },
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      reason: 'bootstrap-recovered-existing-live-inboxes',
      createdEntries: [
        expect.objectContaining({ inboxAddress: 'known1@agentmail.to', agentMailInboxId: 'known-1' }),
        expect.objectContaining({ inboxAddress: 'known2@agentmail.to', agentMailInboxId: 'known-2' }),
      ],
      recoverySourceError: 'AgentMail inbox creation failed with status 403',
    }));
    expect(cleanup).toHaveBeenCalled();
  });

  test('returns an explicit quota-blocked reason when inbox creation fails and all live inboxes are already known to the pool', async () => {
    const cleanup = jest.fn().mockResolvedValue();
    const createRealHooks = jest.fn().mockReturnValue({
      verifyMailboxAuthority: jest.fn(),
      createOrRecoverAgentMailController: jest.fn(),
      captureApiKey: jest.fn(),
      createInboxes: jest.fn(),
      getApiKeyForController: jest.fn().mockReturnValue('am_us_livekey123456'),
      cleanup,
    });
    const runBootstrap = jest.fn().mockRejectedValue(new Error('AgentMail inbox creation failed with status 403'));
    const listInboxes = jest.fn().mockResolvedValue([
      { inbox_id: 'known-1', email_address: 'known1@agentmail.to' },
      { inbox_id: 'known-2', email_address: 'known2@agentmail.to' },
    ]);

    const bootstrapLineage = createLiveBootstrapLineageRunner({
      cwd: '/tmp/project',
      createRealHooks,
      runBootstrap,
      listInboxes,
      verifyRecoveredEntry: jest.fn(),
      allowFreshRootEscalation: false,
      now: () => 1700000000000,
    });

    const result = await bootstrapLineage({
      lineage: 'workspace-owner-a',
      ownerAliasId: 'workspace-owner-a',
      ownerEmail: 'root@example.com',
      workspaceId: 'workspace-a',
      workspaceName: 'Root-Mail_a',
      knownPoolEntries: [
        { rootEmail: 'root@example.com', agentMailInboxId: 'known-1', inboxAddress: 'known1@agentmail.to' },
        { rootEmail: 'root@example.com', agentMailInboxId: 'known-2', inboxAddress: 'known2@agentmail.to' },
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'bootstrap-live-inboxes-already-known',
      createdEntries: [],
      recoverySourceError: 'AgentMail inbox creation failed with status 403',
      liveInboxCount: 2,
      knownLiveInboxCount: 2,
    }));
    expect(cleanup).toHaveBeenCalled();
  });

  test('reuses previously proven supply roots from the same lineage before escalating to a new root', async () => {
    const cleanup = jest.fn().mockResolvedValue();
    const getApiKeyForController = jest.fn((controllerId) => {
      if (controllerId === 'controller-supply-root-example-com') return 'am_us_supply_root';
      return null;
    });
    const createRealHooks = jest.fn().mockReturnValue({
      verifyMailboxAuthority: jest.fn(),
      createOrRecoverAgentMailController: jest.fn(),
      captureApiKey: jest.fn(),
      createInboxes: jest.fn(),
      getApiKeyForController,
      cleanup,
    });
    const runBootstrap = jest.fn().mockRejectedValue(new Error('AgentMail inbox creation failed with status 403'));
    const listInboxes = jest.fn().mockResolvedValue([
      { inbox_id: 'recover-1', email_address: 'recover1@agentmail.to' },
      { inbox_id: 'recover-2', email_address: 'recover2@agentmail.to' },
    ]);

    const bootstrapLineage = createLiveBootstrapLineageRunner({
      cwd: '/tmp/project',
      createRealHooks,
      runBootstrap,
      listInboxes,
      verifyRecoveredEntry: jest.fn().mockResolvedValue({ ok: true, authBranch: 'existing-login-otp' }),
      allowFreshRootEscalation: false,
      now: () => 1700000000000,
    });

    const result = await bootstrapLineage({
      lineage: 'workspace-owner-a',
      ownerAliasId: 'workspace-owner-a',
      ownerEmail: 'root@example.com',
      workspaceId: 'workspace-a',
      workspaceName: 'Root-Mail_a',
      knownPoolEntries: [
        {
          rootEmail: 'supply-root@example.com',
          rootApiKey: 'am_us_supply_root',
          workspaceId: 'workspace-a',
          workspaceName: 'Root-Mail_a',
          lineage: 'workspace-owner-a',
          ownerAliasId: 'workspace-owner-a',
          agentMailInboxId: 'recover-1',
          inboxAddress: 'recover1@agentmail.to',
          status: 'failed',
        },
      ],
    });

    expect(runBootstrap).toHaveBeenCalledWith(expect.objectContaining({ candidateRootEmails: ['supply-root@example.com'] }));
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      reason: 'bootstrap-recovered-existing-live-inboxes',
      rootEmail: 'supply-root@example.com',
      createdEntries: [
        expect.objectContaining({ inboxAddress: 'recover1@agentmail.to' }),
        expect.objectContaining({ inboxAddress: 'recover2@agentmail.to' }),
      ],
    }));
    expect(cleanup).toHaveBeenCalled();
  });

  test('uses archived or reinstatable eligible capacity before escalating to a new root', async () => {
    const bootstrapLineage = createLiveBootstrapLineageRunner({
      cwd: '/tmp/project',
      createRealHooks: jest.fn(),
      runBootstrap: jest.fn(),
      listInboxes: jest.fn(),
      reinstatableEntriesProvider: jest.fn().mockResolvedValue([
        {
          inboxAddress: 'reinstated@agentmail.to',
          agentMailInboxId: 'reinstated-1',
          rootEmail: 'archived-root@example.com',
          rootApiKey: 'am_us_archived',
          workspaceGroupKey: 'workspace-owner-a',
          workspaceId: 'workspace-a',
          workspaceName: 'Root-Mail_a',
          lineage: 'workspace-owner-a',
          ownerAliasId: 'workspace-owner-a',
          status: 'available',
        },
      ]),
      verifyProvisionedEntry: jest.fn().mockResolvedValue({ ok: true }),
      now: () => 1700000000000,
    });

    const result = await bootstrapLineage({
      lineage: 'workspace-owner-a',
      ownerAliasId: 'workspace-owner-a',
      ownerEmail: 'root@example.com',
      workspaceId: 'workspace-a',
      workspaceName: 'Root-Mail_a',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      reason: 'bootstrap-reinstated-archived-capacity',
      reinstatedCapacity: 1,
      createdEntries: [expect.objectContaining({ inboxAddress: 'reinstated@agentmail.to' })],
    }));
  });

  test('triggers new-root escalation when current root is quota-blocked and all current live inboxes are already known', async () => {
    const cleanup = jest.fn().mockResolvedValue();
    const getApiKeyForController = jest.fn((controllerId) => {
      if (controllerId === 'controller-root-example-com') return 'am_us_existing_root';
      if (controllerId === 'controller-agentmailrootfresh-epistemophile-space') return 'am_us_fresh_root';
      return null;
    });
    const createRealHooks = jest.fn().mockReturnValue({
      verifyMailboxAuthority: jest.fn(),
      createOrRecoverAgentMailController: jest.fn(),
      captureApiKey: jest.fn(),
      createInboxes: jest.fn(),
      getApiKeyForController,
      cleanup,
    });
    const runBootstrap = jest.fn()
      .mockRejectedValueOnce(new Error('AgentMail inbox creation failed with status 403'))
      .mockResolvedValueOnce({
        controllers: [{
          outputs: {
            inboxCreation: {
              inboxIds: ['fresh-inbox-1'],
            },
          },
        }],
      });
    const listInboxes = jest.fn(async (apiKey) => {
      if (apiKey === 'am_us_existing_root') {
        return [
          { inbox_id: 'known-1', email_address: 'known1@agentmail.to' },
          { inbox_id: 'known-2', email_address: 'known2@agentmail.to' },
        ];
      }
      return [
        { inbox_id: 'fresh-inbox-1', email_address: 'fresh1@agentmail.to' },
      ];
    });

    const bootstrapLineage = createLiveBootstrapLineageRunner({
      cwd: '/tmp/project',
      createRealHooks,
      runBootstrap,
      listInboxes,
      verifyRecoveredEntry: jest.fn(),
      verifyProvisionedEntry: jest.fn().mockResolvedValue({ ok: true }),
      createCandidateRootEmail: jest.fn().mockReturnValue('agentmailrootfresh@epistemophile.space'),
      now: () => 1700000000000,
    });

    const result = await bootstrapLineage({
      lineage: 'workspace-owner-a',
      ownerAliasId: 'workspace-owner-a',
      ownerEmail: 'root@example.com',
      workspaceId: 'workspace-a',
      workspaceName: 'Root-Mail_a',
      knownPoolEntries: [
        { rootEmail: 'root@example.com', agentMailInboxId: 'known-1', inboxAddress: 'known1@agentmail.to' },
        { rootEmail: 'root@example.com', agentMailInboxId: 'known-2', inboxAddress: 'known2@agentmail.to' },
      ],
    });

    expect(runBootstrap).toHaveBeenNthCalledWith(1, expect.objectContaining({ candidateRootEmails: ['root@example.com'] }));
    expect(runBootstrap).toHaveBeenNthCalledWith(2, expect.objectContaining({ candidateRootEmails: ['agentmailrootfresh@epistemophile.space'] }));
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      reason: 'bootstrap-escalated-new-root',
      escalationSourceReason: 'bootstrap-live-inboxes-already-known',
      createdEntries: [expect.objectContaining({ inboxAddress: 'fresh1@agentmail.to', rootEmail: 'agentmailrootfresh@epistemophile.space' })],
      registryUpdates: {
        usableSupplyRoots: [
          expect.objectContaining({
            rootEmail: 'agentmailrootfresh@epistemophile.space',
            ownerAliasId: 'workspace-owner-a',
            lineage: 'workspace-owner-a',
            workspaceId: 'workspace-a',
          }),
        ],
      },
    }));
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  test('counts new-root inboxes only after they are verified usable for the pipeline', async () => {
    const cleanup = jest.fn().mockResolvedValue();
    const getApiKeyForController = jest.fn((controllerId) => {
      if (controllerId === 'controller-root-example-com') return 'am_us_existing_root';
      if (controllerId === 'controller-agentmailrootfresh-epistemophile-space') return 'am_us_fresh_root';
      return null;
    });
    const createRealHooks = jest.fn().mockReturnValue({
      verifyMailboxAuthority: jest.fn(),
      createOrRecoverAgentMailController: jest.fn(),
      captureApiKey: jest.fn(),
      createInboxes: jest.fn(),
      getApiKeyForController,
      cleanup,
    });
    const runBootstrap = jest.fn()
      .mockRejectedValueOnce(new Error('AgentMail inbox creation failed with status 403'))
      .mockResolvedValueOnce({
        controllers: [{
          outputs: {
            inboxCreation: {
              inboxIds: ['fresh-inbox-1'],
            },
          },
        }],
      });
    const listInboxes = jest.fn(async (apiKey) => {
      if (apiKey === 'am_us_existing_root') {
        return [{ inbox_id: 'known-1', email_address: 'known1@agentmail.to' }];
      }
      return [{ inbox_id: 'fresh-inbox-1', email_address: 'fresh1@agentmail.to' }];
    });

    const bootstrapLineage = createLiveBootstrapLineageRunner({
      cwd: '/tmp/project',
      createRealHooks,
      runBootstrap,
      listInboxes,
      verifyRecoveredEntry: jest.fn(),
      verifyProvisionedEntry: jest.fn().mockResolvedValue({ ok: false, reason: 'workspace-onboarding-not-yet-verified' }),
      createCandidateRootEmail: jest.fn().mockReturnValue('agentmailrootfresh@epistemophile.space'),
      now: () => 1700000000000,
    });

    const result = await bootstrapLineage({
      lineage: 'workspace-owner-a',
      ownerAliasId: 'workspace-owner-a',
      ownerEmail: 'root@example.com',
      workspaceId: 'workspace-a',
      workspaceName: 'Root-Mail_a',
      knownPoolEntries: [
        { rootEmail: 'root@example.com', agentMailInboxId: 'known-1', inboxAddress: 'known1@agentmail.to' },
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'bootstrap-created-inboxes-not-yet-usable',
      createdEntries: [],
      excludedEntries: [expect.objectContaining({ reason: 'workspace-onboarding-not-yet-verified' })],
    }));
  });
});

describe('verifyRecoveredInboxUsability', () => {
  test('classifies password-only login as unusable for browserless onboarding', async () => {
    const result = await verifyRecoveredInboxUsability({
      email: 'recover-bad@agentmail.to',
      agentMailApiKey: 'am_us_livekey123456',
      analyzeAuthTrace: jest.fn().mockResolvedValue({ report: {}, plan: {} }),
      replayAuth: jest.fn().mockResolvedValue({
        verdict: 'blocked',
        branch: 'password-login',
        blockerReason: 'password-login-unsupported',
      }),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'password-login-unsupported',
      authBranch: 'password-login',
    }));
  });
});
