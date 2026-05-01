import { beforeEach, afterEach, describe, expect, test, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLifecycleReconciler, evaluatePiCodexLbLifecycleAgreement } from '../../../src/pipeline/rotation/lifecycleReconciler.js';

let tmpDir;
let authPath;
let routerPath;
let archivePath;

function seed(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function read(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-reconciler-'));
  authPath = path.join(tmpDir, 'auth.json');
  routerPath = path.join(tmpDir, 'router.json');
  archivePath = path.join(tmpDir, 'archive.json');

  seed(authPath, {
    aliasOld: { type: 'oauth', access: 'tok-old', refresh: 'ref-old', accountId: 'workspace-123' },
  });
  seed(routerPath, {
    version: 1,
    aliases: [
      { id: 'aliasOld', cloneFrom: 'openai-codex', email: 'old@agentmail.to', label: 'aliasOld', disabled: false },
    ],
    pools: [{
      name: 'openai-codex',
      providers: ['aliasOld'],
      routes: [{ provider: 'aliasOld', model: 'gpt-5.4' }],
    }],
    policy: {},
  });
  seed(archivePath, { version: 1, aliases: [] });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

function createFinalize() {
  return jest.fn().mockImplementation(async ({ finalId, email }) => {
    const router = read(routerPath);
    router.aliases.push({
      id: finalId,
      cloneFrom: 'openai-codex',
      email,
      label: finalId,
      disabled: false,
    });
    const pool = router.pools.find((entry) => entry.name === 'openai-codex');
    pool.providers.push(finalId);
    pool.routes.push({ provider: finalId, model: 'gpt-5.4' });
    seed(routerPath, router);
    return { ok: true, validation: 'ok' };
  });
}

describe('createLifecycleReconciler', () => {
  test('reconciles append-before-remove across Pi and codex-lb on successful replacement', async () => {
    const events = [];
    const codexLbStore = {
      writeActiveLifecycle: jest.fn().mockImplementation(async ({ email }) => {
        events.push(`write:${email}`);
      }),
      clearActiveLifecycle: jest.fn().mockImplementation(async ({ email }) => {
        events.push(`clear:${email}`);
      }),
    };

    const reconciler = createLifecycleReconciler({
      authPath,
      routerPath,
      archivePath,
      finalize: createFinalize(),
      verifyRecoveredAliasImpl: jest.fn().mockResolvedValue({ ok: true, reason: 'verified', failures: [] }),
      probeVerifiedAlias: jest.fn().mockResolvedValue({ ok: true }),
      codexLbStore,
    });

    const result = await reconciler.reconcileReplacement({
      alias: { aliasId: 'aliasOld', email: 'old@agentmail.to', effectiveFraction: 0 },
      inbox: { inboxAddress: 'replacement@agentmail.to' },
      auth: { access: 'tok-new', refresh: 'ref-new', expires: Date.now() + 1000, accountId: 'workspace-123' },
      newAliasId: 'aliasNew',
      tempAliasId: 'temp-123',
      onboarded: { workspaceId: 'workspace-123' },
      placementContext: { workspaceId: 'workspace-123', lineage: 'lineage-a' },
      teamDriver: { removeTeamMember: jest.fn().mockResolvedValue({ ok: true }) },
    });

    expect(result.ok).toBe(true);
    expect(events).toEqual(['write:replacement@agentmail.to', 'clear:old@agentmail.to']);

    const auth = read(authPath);
    expect(auth.aliasOld).toBeUndefined();
    expect(auth['temp-123']).toBeUndefined();
    expect(auth.aliasNew).toEqual(expect.objectContaining({
      access: 'tok-new',
      refresh: 'ref-new',
      accountId: 'workspace-123',
    }));

    const router = read(routerPath);
    expect(router.aliases.find((alias) => alias.id === 'aliasOld')).toBeUndefined();
    expect(router.aliases.find((alias) => alias.id === 'aliasNew')).toBeTruthy();
    expect(result.archiveEntry).toEqual(expect.objectContaining({
      aliasId: 'aliasOld',
      replacementAliasId: 'aliasNew',
      reconcileContext: expect.objectContaining({
        appendBeforeRemove: true,
        codexLbLifecycleWritten: true,
      }),
      codexLbStateSnapshot: expect.objectContaining({
        replacementAliasEmail: 'replacement@agentmail.to',
        replacementAliasId: 'aliasNew',
      }),
    }));
  });

  test('rolls back Pi and codex-lb residue when verification fails after append', async () => {
    const cleared = [];
    const codexLbStore = {
      writeActiveLifecycle: jest.fn().mockResolvedValue({ ok: true }),
      clearActiveLifecycle: jest.fn().mockImplementation(async ({ email }) => {
        cleared.push(email);
      }),
    };

    const reconciler = createLifecycleReconciler({
      authPath,
      routerPath,
      archivePath,
      finalize: createFinalize(),
      verifyRecoveredAliasImpl: jest.fn().mockResolvedValue({ ok: false, failures: ['live-codex-probe-failed'] }),
      probeVerifiedAlias: jest.fn().mockResolvedValue({ ok: false }),
      codexLbStore,
    });

    const result = await reconciler.reconcileReplacement({
      alias: { aliasId: 'aliasOld', email: 'old@agentmail.to', effectiveFraction: 0 },
      inbox: { inboxAddress: 'replacement@agentmail.to' },
      auth: { access: 'tok-new', refresh: 'ref-new', expires: Date.now() + 1000, accountId: 'workspace-123' },
      newAliasId: 'aliasNew',
      tempAliasId: 'temp-123',
      onboarded: { workspaceId: 'workspace-123' },
      placementContext: { workspaceId: 'workspace-123' },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('verification: live-codex-probe-failed');
    expect(cleared).toEqual(['replacement@agentmail.to']);

    const auth = read(authPath);
    expect(auth.aliasOld).toBeTruthy();
    expect(auth.aliasNew).toBeUndefined();
    expect(auth['temp-123']).toBeUndefined();

    const router = read(routerPath);
    expect(router.aliases.map((alias) => alias.id)).toEqual(['aliasOld']);
  });

  test('surfaces rollback residue if codex-lb cleanup itself fails', async () => {
    const codexLbStore = {
      writeActiveLifecycle: jest.fn().mockResolvedValue({ ok: true }),
      clearActiveLifecycle: jest.fn().mockRejectedValue(new Error('sqlite busy')),
    };

    const reconciler = createLifecycleReconciler({
      authPath,
      routerPath,
      archivePath,
      finalize: createFinalize(),
      verifyRecoveredAliasImpl: jest.fn().mockResolvedValue({ ok: false, failures: ['live-codex-probe-failed'] }),
      codexLbStore,
    });

    const result = await reconciler.reconcileReplacement({
      alias: { aliasId: 'aliasOld', email: 'old@agentmail.to', effectiveFraction: 0 },
      inbox: { inboxAddress: 'replacement@agentmail.to' },
      auth: { access: 'tok-new', refresh: 'ref-new', expires: Date.now() + 1000, accountId: 'workspace-123' },
      newAliasId: 'aliasNew',
      tempAliasId: 'temp-123',
      onboarded: { workspaceId: 'workspace-123' },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rollback-residue-detected/);
  });
});

describe('evaluatePiCodexLbLifecycleAgreement', () => {
  test('requires Pi and codex-lb active lifecycle agreement for healthy gating', () => {
    const ok = evaluatePiCodexLbLifecycleAgreement({
      aliasId: 'aliasA',
      email: 'aliasA@agentmail.to',
      piWorkspaceId: 'workspace-123',
      targetWorkspaceId: 'workspace-123',
      codexLbLifecycle: {
        email: 'aliasA@agentmail.to',
        aliasId: 'aliasA',
        workspaceId: 'workspace-123',
        status: 'active',
      },
      requireAgreement: true,
    });

    const bad = evaluatePiCodexLbLifecycleAgreement({
      aliasId: 'aliasA',
      email: 'aliasA@agentmail.to',
      piWorkspaceId: 'workspace-123',
      targetWorkspaceId: 'workspace-123',
      codexLbLifecycle: {
        email: 'aliasA@agentmail.to',
        aliasId: 'aliasA',
        workspaceId: 'workspace-other',
        status: 'active',
      },
      requireAgreement: true,
    });

    expect(ok.ok).toBe(true);
    expect(bad).toEqual(expect.objectContaining({
      ok: false,
      reason: 'store-disagreement',
      codexLbWorkspaceId: 'workspace-other',
    }));
  });
});