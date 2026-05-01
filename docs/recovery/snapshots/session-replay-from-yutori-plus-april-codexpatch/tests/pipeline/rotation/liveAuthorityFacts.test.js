import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { auditCodexFleetLive } from '../../../src/pipeline/rotation/liveFleetAudit.js';
import { collectLiveAuthorityFacts } from '../../../src/pipeline/rotation/liveAuthorityFacts.js';

let tmpDir;
let routerPath;
let authPath;
let healthPath;
let poolPath;
let codexLbStorePath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-authority-facts-'));
  routerPath = path.join(tmpDir, 'router.json');
  authPath = path.join(tmpDir, 'auth.json');
  healthPath = path.join(tmpDir, 'health.json');
  poolPath = path.join(tmpDir, 'pool.json');
  codexLbStorePath = path.join(tmpDir, 'store.db');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function createStore(rows = []) {
  const inserts = rows.map((row) => (
    `INSERT INTO accounts (email, status, chatgpt_account_id, alias_id, lifecycle_state)
VALUES ('${row.email}', '${row.status}', '${row.workspaceId}', '${row.aliasId}', '${row.lifecycleState}');`
  )).join('\n');
  const result = spawnSync('sqlite3', [codexLbStorePath, `
CREATE TABLE accounts (
  email TEXT PRIMARY KEY,
  status TEXT,
  chatgpt_account_id TEXT,
  alias_id TEXT,
  lifecycle_state TEXT
);
${inserts}
`], { encoding: 'utf8' });
  expect(result.status).toBe(0);
}

function expectNoPolicyKeys(value) {
  const forbiddenKeys = new Set([
    'blockedReason',
    'blockerReason',
    'classification',
    'liveFailureReason',
    'liveHealthy',
    'recreateNeeded',
    'recreateNeededObserved',
    'recoverable',
    'recoverableObserved',
  ]);

  function walk(current) {
    if (Array.isArray(current)) {
      for (const item of current) walk(item);
      return;
    }
    if (!current || typeof current !== 'object') return;
    for (const [key, nestedValue] of Object.entries(current)) {
      expect(forbiddenKeys.has(key)).toBe(false);
      walk(nestedValue);
    }
  }

  walk(value);
}

describe('collectLiveAuthorityFacts', () => {
  test('strips policy verdict fields while preserving raw evidence and agreement facts', async () => {
    seedJson(routerPath, {
      version: 1,
      aliases: [
        {
          id: 'cruelfigure620',
          cloneFrom: 'openai-codex',
          email: 'cruelfigure620@agentmail.to',
          disabled: false,
          placementContext: {
            workspaceId: 'workspace-a',
            ownerAliasId: 'workspace-owner-a',
            ownerEmail: 'root@example.com',
            lineage: 'workspace-owner-a',
            rootEmail: 'root@example.com',
          },
        },
      ],
      pools: [{ name: 'openai-codex', providers: ['cruelfigure620'], routes: [] }],
      policy: {},
    });
    seedJson(authPath, {
      cruelfigure620: {
        email: 'cruelfigure620@agentmail.to',
        access: 'tok-live',
        refresh: 'ref-live',
        expires: Date.now() + 60_000,
        accountId: 'workspace-a',
      },
    });
    seedJson(healthPath, {
      version: 1,
      providers: {},
      models: {
        'cruelfigure620/gpt-5.4': {
          quotaRemainingFraction: 0.9,
          quotaCheckedAt: Date.now(),
        },
      },
    });
    seedJson(poolPath, {
      version: 1,
      entries: [{
        inboxAddress: 'cruelfigure620@agentmail.to',
        linkedAliasId: 'cruelfigure620',
        workspaceId: 'workspace-a',
        rootOrgId: 'workspace-a',
        ownerAliasId: 'workspace-owner-a',
        ownerEmail: 'root@example.com',
        lineage: 'workspace-owner-a',
        rootEmail: 'root@example.com',
      }],
    });
    createStore([{
      email: 'cruelfigure620@agentmail.to',
      status: 'active',
      workspaceId: 'workspace-a',
      aliasId: 'cruelfigure620',
      lifecycleState: 'active',
    }]);

    const facts = await collectLiveAuthorityFacts({
      routerPath,
      authPath,
      healthPath,
      poolPath,
      targetWorkspaceId: 'workspace-a',
      canonicalAgentMailParent: {
        workspaceId: 'workspace-a',
        ownerAliasId: 'workspace-owner-a',
        ownerEmail: 'root@example.com',
        lineage: 'workspace-owner-a',
        rootEmail: 'root@example.com',
      },
      codexLbStorePath,
      liveProbeAlias: async () => ({
        ok: true,
        classification: 'keep-live',
        blockerReason: 'should-not-leak',
        blockedReason: 'probe-blocked',
        recoverable: true,
        recreateNeeded: true,
        codexReachable: true,
        workspaceMembership: true,
        workspaceAccountSelected: true,
        sessionValid: true,
        workspaceId: 'workspace-a',
        quotaSource: 'live-probe',
        liveCheckedAt: Date.now(),
      }),
    });

    expect(facts.counts).toEqual(expect.objectContaining({
      totalAliases: 1,
      targetWorkspaceAliases: 1,
      parentAgreementFailures: 0,
      codexLbAgreementFailures: 0,
    }));
    expect(facts.aliases).toHaveLength(1);
    expect(facts.aliases[0]).toEqual(expect.objectContaining({
      aliasId: 'cruelfigure620',
      email: 'cruelfigure620@agentmail.to',
      workspaceId: 'workspace-a',
      authPresent: true,
      authDurable: true,
      quotaSource: 'live-probe',
      parentAgreement: expect.objectContaining({ ok: true, reason: null }),
      codexLbAgreement: expect.objectContaining({ ok: true, reason: null }),
      codexLb: expect.objectContaining({
        email: 'cruelfigure620@agentmail.to',
        aliasId: 'cruelfigure620',
        workspaceId: 'workspace-a',
      }),
    }));
    expect(facts.aliases[0]).not.toHaveProperty('classification');
    expect(facts.aliases[0]).not.toHaveProperty('blockerReason');
    expect(facts.aliases[0].live).toEqual(expect.objectContaining({
      ok: true,
      codexReachable: true,
      workspaceMembership: true,
      workspaceAccountSelected: true,
      sessionValid: true,
      workspaceId: 'workspace-a',
      quotaSource: 'live-probe',
    }));
    expect(facts.aliases[0].live).not.toHaveProperty('classification');
    expect(facts.aliases[0].live).not.toHaveProperty('blockerReason');
    expect(facts.aliases[0].live).not.toHaveProperty('blockedReason');
    expect(facts.aliases[0].live).not.toHaveProperty('recoverable');
    expect(facts.aliases[0].live).not.toHaveProperty('recreateNeeded');
    expect(facts.aliases[0].evidence.live).not.toHaveProperty('classification');
    expect(facts.aliases[0].evidence.live).not.toHaveProperty('blockerReason');
    expectNoPolicyKeys(facts);
  });

  test('preserves raw live-fleet evidence parity while omitting policy fields', async () => {
    seedJson(routerPath, {
      version: 1,
      aliases: [
        { id: 'alias-a', cloneFrom: 'openai-codex', email: 'alias-a@agentmail.to', disabled: false },
      ],
      pools: [{ name: 'openai-codex', providers: ['alias-a'], routes: [] }],
      policy: {},
    });
    seedJson(authPath, {
      'alias-a': {
        email: 'alias-a@agentmail.to',
        access: 'tok-a',
        refresh: 'ref-a',
        expires: Date.now() + 60_000,
        accountId: 'workspace-a',
      },
    });
    seedJson(healthPath, {
      version: 1,
      providers: {},
      models: {
        'alias-a/gpt-5.4': {
          quotaRemainingFraction: 0.7,
          quotaCheckedAt: Date.now(),
        },
      },
    });
    seedJson(poolPath, { version: 1, entries: [] });

    const probeAlias = async () => ({
      workspaceId: 'workspace-a',
      lineage: 'workspace-owner-a',
      codexReachable: true,
      workspaceMembership: true,
      sessionValid: true,
      liveCheckedAt: Date.now(),
      classification: 'keep-live',
    });

    const audit = await auditCodexFleetLive({
      routerPath,
      authPath,
      healthPath,
      probeAlias,
    });
    const facts = await collectLiveAuthorityFacts({
      routerPath,
      authPath,
      healthPath,
      poolPath,
      targetWorkspaceId: 'workspace-a',
      liveProbeAlias: probeAlias,
    });

    expect(facts.aliases[0]).toEqual(expect.objectContaining({
      aliasId: audit.aliases[0].aliasId,
      email: audit.aliases[0].email,
      workspaceId: audit.aliases[0].workspaceId,
      lineage: audit.aliases[0].lineage,
      authPresent: audit.aliases[0].authPresent,
      authDurable: audit.aliases[0].authDurable,
      authExpiresAt: audit.aliases[0].authExpiresAt,
      quotaSource: audit.aliases[0].quotaSource,
      health: audit.aliases[0].health,
    }));
    expect(facts.aliases[0].evidence.auth).toEqual(audit.aliases[0].evidence.auth);
    expect(facts.aliases[0].evidence.health).toEqual(audit.aliases[0].evidence.health);
    expect(facts.aliases[0]).not.toHaveProperty('classification');
    expect(facts.aliases[0].evidence.live).not.toHaveProperty('classification');
    expect(facts.aliases[0].live.ok).toBeUndefined();
    expectNoPolicyKeys(facts);
  });

  test('is disk-driven even when stale snapshot-shaped arguments are supplied', async () => {
    seedJson(routerPath, {
      version: 1,
      aliases: [
        {
          id: 'disk-alias',
          cloneFrom: 'openai-codex',
          email: 'disk-alias@agentmail.to',
          disabled: false,
          placementContext: {
            workspaceId: 'workspace-a',
            ownerAliasId: 'workspace-owner-a',
            ownerEmail: 'root@example.com',
            lineage: 'workspace-owner-a',
          },
        },
      ],
      pools: [{ name: 'openai-codex', providers: ['disk-alias'], routes: [] }],
      policy: {},
    });
    seedJson(authPath, {
      'disk-alias': {
        email: 'disk-alias@agentmail.to',
        access: 'tok-disk',
        refresh: 'ref-disk',
        expires: Date.now() + 60_000,
        accountId: 'workspace-a',
      },
    });
    seedJson(healthPath, {
      version: 1,
      providers: {},
      models: {
        'disk-alias/gpt-5.4': {
          quotaRemainingFraction: 0.8,
          quotaCheckedAt: Date.now(),
        },
      },
    });
    seedJson(poolPath, {
      version: 1,
      entries: [{
        inboxAddress: 'disk-alias@agentmail.to',
        linkedAliasId: 'disk-alias',
        workspaceId: 'workspace-a',
        ownerAliasId: 'workspace-owner-a',
        ownerEmail: 'root@example.com',
        lineage: 'workspace-owner-a',
      }],
    });

    const facts = await collectLiveAuthorityFacts({
      routerPath,
      authPath,
      healthPath,
      poolPath,
      targetWorkspaceId: 'workspace-a',
      routerData: {
        aliases: [{ id: 'stale-alias', cloneFrom: 'openai-codex', email: 'stale@agentmail.to', disabled: false }],
        pools: [{ name: 'openai-codex', providers: ['stale-alias'], routes: [] }],
      },
      poolDataSnapshot: {
        version: 1,
        entries: [{ inboxAddress: 'stale@agentmail.to', linkedAliasId: 'stale-alias' }],
      },
      liveProbeAlias: async ({ aliasId }) => ({
        ok: true,
        workspaceId: 'workspace-a',
        sessionValid: true,
        workspaceAccountSelected: true,
        aliasSeen: aliasId,
      }),
    });

    expect(facts.aliases).toHaveLength(1);
    expect(facts.aliases[0]).toEqual(expect.objectContaining({
      aliasId: 'disk-alias',
      email: 'disk-alias@agentmail.to',
      routerAlias: expect.objectContaining({ id: 'disk-alias' }),
      poolEntry: expect.objectContaining({ linkedAliasId: 'disk-alias' }),
    }));
  });

  test('does not depend on resolveAgreementOutcome', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/pipeline/rotation/liveAuthorityFacts.js'),
      'utf8',
    );
    expect(source).not.toMatch(/resolveAgreementOutcome/);
  });
});