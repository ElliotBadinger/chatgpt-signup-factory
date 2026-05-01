import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCheckArchiveAndReplace } from '../../../src/pipeline/rotation/checkArchiveAndReplaceExhausted.js';

let tmpDir;
let archivePath;
let poolPath;
let healthPath;
let routerPath;
let authPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reinstatement-test-'));
  archivePath = path.join(tmpDir, 'archive.json');
  poolPath = path.join(tmpDir, 'pool.json');
  healthPath = path.join(tmpDir, 'health.json');
  routerPath = path.join(tmpDir, 'router.json');
  authPath = path.join(tmpDir, 'auth.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

function seed(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function makePool(entries = []) {
  return { version: 1, entries, lastCheckedAt: 0, allEntriesExhausted: false };
}

function makePoolEntry(address) {
  return {
    inboxAddress: address,
    agentMailInboxId: address,
    rootEmail: 'root-a@example.com',
    rootOrgId: 'org-a',
    rootApiKey: 'am_us_testkey123456',
    rootApiKeyPrefix: 'am_us',
    cfRuleId: 'r1',
    cfKvNamespaceId: 'kv1',
    status: 'available',
    statusUpdatedAt: Date.now(),
  };
}

function makeRouter(aliasId) {
  return {
    version: 1,
    aliases: [{ id: aliasId, cloneFrom: 'openai-codex', email: `${aliasId}@agentmail.to`, label: aliasId, disabled: false, lineage: 'lineage-a' }],
    pools: [{ name: 'openai-codex', providers: [aliasId], routes: [{ provider: aliasId, model: 'gpt-5.4' }] }],
    policy: {},
  };
}

function makeHealth(aliasId) {
  return {
    version: 1,
    providers: {},
    models: {
      [`${aliasId}/gpt-5.4`]: { quotaRemainingFraction: 0.0, quotaCheckedAt: Date.now(), quotaProofAmbiguous: false },
    },
  };
}

describe('runCheckArchiveAndReplace reinstatement/prewarm workflow', () => {
  test('five-hour-only exhausted account gets archived for reinstatement and is not replaced immediately', async () => {
    seed(routerPath, makeRouter('alias5h'));
    seed(authPath, { alias5h: { type: 'oauth', access: 'tok', refresh: 'ref', expires: Date.now() + 60_000, accountId: 'acct-1' } });
    seed(healthPath, makeHealth('alias5h'));
    seed(archivePath, { version: 1, aliases: [] });
    seed(poolPath, makePool([makePoolEntry('fresh@agentmail.to')]));

    const memberOnboarder = jest.fn();

    const result = await runCheckArchiveAndReplace({
      archivePath,
      poolPath,
      healthPath,
      routerPath,
      authPath,
      log: () => {},
      memberOnboarder,
      finalize: jest.fn(),
      teamDriver: { inviteTeamMember: jest.fn(), removeTeamMember: jest.fn() },
      liveProbeAlias: async ({ aliasId }) => ({
        aliasId,
        codexReachable: false,
        recoverable: true,
        quotaSource: 'live-probe',
        quotaWindows: { fiveHourRemainingFraction: 0.0, weeklyRemainingFraction: 0.7 },
      }),
    });

    expect(memberOnboarder).not.toHaveBeenCalled();
    expect(result.newAccountsCreated).toBe(0);
    expect(result.details).toContainEqual(expect.objectContaining({
      aliasId: 'alias5h',
      status: 'awaiting-reinstatement',
      archivedReason: '5h-exhausted',
    }));

    const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    expect(archive.aliases[0]).toEqual(expect.objectContaining({
      aliasId: 'alias5h',
      archivedReason: '5h-exhausted',
      quotaWindow: 'five-hour',
      reinstated: false,
      awaitingReinstatement: true,
    }));
  });

  test('workspace-wide five-hour exhaustion triggers supplementation/prewarm only for the affected lineage group', async () => {
    seed(routerPath, {
      version: 1,
      aliases: [
        { id: 'aliasA', cloneFrom: 'openai-codex', email: 'aliasA@agentmail.to', label: 'aliasA', disabled: false, lineage: 'lineage-a' },
        { id: 'aliasB', cloneFrom: 'openai-codex', email: 'aliasB@agentmail.to', label: 'aliasB', disabled: false, lineage: 'lineage-a' },
        { id: 'aliasC', cloneFrom: 'openai-codex', email: 'aliasC@agentmail.to', label: 'aliasC', disabled: false, lineage: 'lineage-a' },
        { id: 'aliasD', cloneFrom: 'openai-codex', email: 'aliasD@agentmail.to', label: 'aliasD', disabled: false, lineage: 'lineage-b' },
      ],
      pools: [{ name: 'openai-codex', providers: ['aliasA', 'aliasB', 'aliasC', 'aliasD'], routes: [] }],
      policy: {},
    });
    seed(authPath, {
      aliasA: { type: 'oauth', access: 'tok-a', expires: Date.now() + 60_000, accountId: 'acct-a' },
      aliasB: { type: 'oauth', access: 'tok-b', expires: Date.now() + 60_000, accountId: 'acct-b' },
      aliasC: { type: 'oauth', access: 'tok-c', expires: Date.now() + 60_000, accountId: 'acct-c' },
      aliasD: { type: 'oauth', access: 'tok-d', expires: Date.now() + 60_000, accountId: 'acct-d' },
    });
    seed(healthPath, {
      version: 1,
      providers: {},
      models: {
        'aliasA/gpt-5.4': { quotaRemainingFraction: 0.0, quotaCheckedAt: Date.now(), quotaProofAmbiguous: false },
        'aliasB/gpt-5.4': { quotaRemainingFraction: 0.0, quotaCheckedAt: Date.now(), quotaProofAmbiguous: false },
        'aliasC/gpt-5.4': { quotaRemainingFraction: 0.8, quotaCheckedAt: Date.now(), quotaProofAmbiguous: false },
        'aliasD/gpt-5.4': { quotaRemainingFraction: 0.8, quotaCheckedAt: Date.now(), quotaProofAmbiguous: false },
      },
    });
    seed(archivePath, { version: 1, aliases: [] });
    seed(poolPath, makePool([
      { ...makePoolEntry('standby-a@agentmail.to'), workspaceGroupKey: 'lineage-a' },
      { ...makePoolEntry('standby-b@agentmail.to'), workspaceGroupKey: 'lineage-b' },
    ]));

    const result = await runCheckArchiveAndReplace({
      archivePath,
      poolPath,
      healthPath,
      routerPath,
      authPath,
      log: () => {},
      finalize: jest.fn(),
      teamDriver: { inviteTeamMember: jest.fn(), removeTeamMember: jest.fn() },
      liveProbeAlias: async ({ aliasId, alias }) => ({
        aliasId,
        lineage: alias.lineage,
        codexReachable: aliasId === 'aliasC' || aliasId === 'aliasD',
        quotaSource: 'live-probe',
        quotaWindows: aliasId === 'aliasC' || aliasId === 'aliasD'
          ? { fiveHourRemainingFraction: 0.8, weeklyRemainingFraction: 0.8 }
          : { fiveHourRemainingFraction: 0.0, weeklyRemainingFraction: 0.7 },
      }),
    });

    expect(result.quotaPolicy.groups['lineage-a']).toEqual(expect.objectContaining({ action: 'supplement-prewarm' }));
    expect(result.quotaPolicy.groups['lineage-b']).toEqual(expect.objectContaining({ action: 'keep' }));
    expect(result.details).toContainEqual(expect.objectContaining({ status: 'prewarmed', inbox: 'standby-a@agentmail.to', groupKey: 'lineage-a' }));
    expect(result.details).not.toContainEqual(expect.objectContaining({ status: 'prewarmed', inbox: 'standby-b@agentmail.to' }));

    const pool = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
    expect(pool.entries.find((entry) => entry.inboxAddress === 'standby-a@agentmail.to')).toEqual(expect.objectContaining({
      status: 'prewarmed',
      reservedForAction: 'supplement-prewarm',
    }));
    expect(pool.entries.find((entry) => entry.inboxAddress === 'standby-b@agentmail.to')).toEqual(expect.objectContaining({
      status: 'available',
    }));
  });

  test('fails closed by default when verification probe is not configured', async () => {
    seed(routerPath, makeRouter('aliasStrict'));
    seed(authPath, { aliasStrict: { type: 'oauth', access: 'tok-old', refresh: 'ref-old', expires: Date.now() + 60_000, accountId: 'acct-old' } });
    seed(healthPath, makeHealth('aliasStrict'));
    seed(archivePath, { version: 1, aliases: [] });
    seed(poolPath, makePool([makePoolEntry('replacement@agentmail.to')]));

    const result = await runCheckArchiveAndReplace({
      archivePath,
      poolPath,
      healthPath,
      routerPath,
      authPath,
      log: () => {},
      memberOnboarder: jest.fn().mockResolvedValue({
        accessToken: 'tok-new',
        expiresAt: Date.now() + 60_000,
        accountId: 'workspace-123',
        workspaceId: 'workspace-123',
        personalAccountId: 'personal-123',
        identityEmail: 'replacement@agentmail.to',
      }),
      finalize: jest.fn().mockResolvedValue({ ok: true, validation: 'ok' }),
      teamDriver: { inviteTeamMember: jest.fn(), removeTeamMember: jest.fn().mockResolvedValue({ ok: true }) },
      liveProbeAlias: async () => ({ quotaSource: 'live-probe', quotaWindows: { fiveHourRemainingFraction: 0.0, weeklyRemainingFraction: 0.0 } }),
    });

    expect(result.newAccountsCreated).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.details).toContainEqual(expect.objectContaining({
      aliasId: 'aliasStrict',
      status: 'failed',
      error: expect.stringContaining('live-codex-probe-failed'),
    }));
  });

  test('threads alias/root lineage context into member onboarding during runtime replacement', async () => {
    seed(routerPath, makeRouter('aliasLineage'));
    seed(authPath, { aliasLineage: { type: 'oauth', access: 'tok-old', refresh: 'ref-old', expires: Date.now() + 60_000, accountId: 'acct-old' } });
    seed(healthPath, makeHealth('aliasLineage'));
    seed(archivePath, { version: 1, aliases: [] });
    seed(poolPath, makePool([makePoolEntry('replacement@agentmail.to')]));

    const memberOnboarder = jest.fn().mockResolvedValue({
      accessToken: 'tok-new',
      expiresAt: Date.now() + 60_000,
      accountId: 'workspace-123',
      workspaceId: 'workspace-123',
      personalAccountId: 'personal-123',
      identityEmail: 'replacement@agentmail.to',
    });

    await runCheckArchiveAndReplace({
      archivePath,
      poolPath,
      healthPath,
      routerPath,
      authPath,
      log: () => {},
      memberOnboarder,
      finalize: jest.fn().mockResolvedValue({ ok: true, validation: 'ok' }),
      teamDriver: { inviteTeamMember: jest.fn(), removeTeamMember: jest.fn().mockResolvedValue({ ok: true }) },
      verifyRecoveredAliasImpl: jest.fn().mockResolvedValue({ ok: true, reason: 'verified', failures: [] }),
      liveProbeAlias: async () => ({ quotaSource: 'live-probe', quotaWindows: { fiveHourRemainingFraction: 0.0, weeklyRemainingFraction: 0.0 } }),
    });

    expect(memberOnboarder).toHaveBeenCalledWith(expect.objectContaining({
      email: 'replacement@agentmail.to',
      placementContext: expect.objectContaining({
        aliasId: 'aliasLineage',
        aliasEmail: 'aliasLineage@agentmail.to',
        lineage: 'lineage-a',
        rootEmail: 'root-a@example.com',
        rootOrgId: 'org-a',
      }),
    }));
  });

  test('uses CLI-supplied resolved placement context for onboarding when router lineage evidence is missing', async () => {
    seed(routerPath, {
      version: 1,
      aliases: [{ id: 'aliasResolved', cloneFrom: 'openai-codex', email: 'aliasResolved@agentmail.to', label: 'aliasResolved', disabled: false }],
      pools: [{ name: 'openai-codex', providers: ['aliasResolved'], routes: [{ provider: 'aliasResolved', model: 'gpt-5.4' }] }],
      policy: {},
    });
    seed(authPath, { aliasResolved: { type: 'oauth', access: 'tok-old', refresh: 'ref-old', expires: Date.now() + 60_000, accountId: 'acct-old' } });
    seed(healthPath, makeHealth('aliasResolved'));
    seed(archivePath, { version: 1, aliases: [] });
    seed(poolPath, makePool([makePoolEntry('replacement@agentmail.to')]));

    const memberOnboarder = jest.fn().mockResolvedValue({
      accessToken: 'tok-new',
      expiresAt: Date.now() + 60_000,
      accountId: 'workspace-123',
      workspaceId: 'workspace-123',
      personalAccountId: 'personal-123',
      identityEmail: 'replacement@agentmail.to',
    });

    await runCheckArchiveAndReplace({
      archivePath,
      poolPath,
      healthPath,
      routerPath,
      authPath,
      log: () => {},
      memberOnboarder,
      finalize: jest.fn().mockResolvedValue({ ok: true, validation: 'ok' }),
      teamDriver: { inviteTeamMember: jest.fn(), removeTeamMember: jest.fn().mockResolvedValue({ ok: true }) },
      verifyRecoveredAliasImpl: jest.fn().mockResolvedValue({ ok: true, reason: 'verified', failures: [] }),
      probeVerifiedAlias: jest.fn().mockResolvedValue({ ok: true }),
      placementContextByAliasId: {
        aliasResolved: {
          aliasId: 'aliasResolved',
          aliasEmail: 'aliasResolved@agentmail.to',
          lineage: 'lineage-from-cli',
          workspaceId: 'workspace-lineage-a-2',
          ownerAliasId: 'owner-a',
        },
      },
      liveProbeAlias: async () => ({ quotaSource: 'live-probe', quotaWindows: { fiveHourRemainingFraction: 0.0, weeklyRemainingFraction: 0.0 } }),
    });

    expect(memberOnboarder).toHaveBeenCalledWith(expect.objectContaining({
      placementContext: expect.objectContaining({
        aliasId: 'aliasResolved',
        aliasEmail: 'aliasResolved@agentmail.to',
        lineage: 'lineage-from-cli',
        workspaceId: 'workspace-lineage-a-2',
        ownerAliasId: 'owner-a',
      }),
    }));
  });

  test('replacement is rejected when post-finalize verification fails, leaving the old alias unarchived', async () => {
    seed(routerPath, makeRouter('aliasVerify'));
    seed(authPath, { aliasVerify: { type: 'oauth', access: 'tok-old', refresh: 'ref-old', expires: Date.now() + 60_000, accountId: 'acct-old' } });
    seed(healthPath, makeHealth('aliasVerify'));
    seed(archivePath, { version: 1, aliases: [] });
    seed(poolPath, makePool([makePoolEntry('replacement@agentmail.to')]));

    const memberOnboarder = jest.fn().mockResolvedValue({
      accessToken: 'tok-new',
      expiresAt: Date.now() + 60_000,
      accountId: 'workspace-123',
      workspaceId: 'workspace-123',
      personalAccountId: 'personal-123',
      identityEmail: 'replacement@agentmail.to',
    });

    const result = await runCheckArchiveAndReplace({
      archivePath,
      poolPath,
      healthPath,
      routerPath,
      authPath,
      log: () => {},
      memberOnboarder,
      finalize: jest.fn().mockResolvedValue({ ok: true, validation: 'ok' }),
      verifyRecoveredAliasImpl: jest.fn().mockResolvedValue({ ok: false, reason: 'verification-failed', failures: ['live-codex-probe-failed'] }),
      teamDriver: { inviteTeamMember: jest.fn(), removeTeamMember: jest.fn() },
      liveProbeAlias: async () => ({ quotaSource: 'live-probe', quotaWindows: { fiveHourRemainingFraction: 0.0, weeklyRemainingFraction: 0.0 } }),
    });

    expect(result.failed).toBe(1);
    expect(result.newAccountsCreated).toBe(0);
    expect(result.details).toContainEqual(expect.objectContaining({
      aliasId: 'aliasVerify',
      status: 'failed',
      error: 'verification: live-codex-probe-failed',
    }));

    const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    expect(archive.aliases).toHaveLength(0);

    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    expect(auth.aliasVerify).toBeTruthy();
    expect(auth.replacement).toBeUndefined();
  });
});
