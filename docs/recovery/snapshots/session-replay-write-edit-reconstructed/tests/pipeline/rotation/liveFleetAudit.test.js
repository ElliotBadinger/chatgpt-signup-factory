import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { auditCodexFleetLive } from '../../../src/pipeline/rotation/liveFleetAudit.js';

let tmpDir;
let routerPath;
let authPath;
let healthPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-fleet-audit-'));
  routerPath = path.join(tmpDir, 'router.json');
  authPath = path.join(tmpDir, 'auth.json');
  healthPath = path.join(tmpDir, 'health.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

function seedJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

describe('auditCodexFleetLive', () => {
  test('excludes greasyhands from the first-batch fixture, keeps nastypolice as a normal candidate, and prefers live probe over stale health', async () => {
    seedJson(routerPath, {
      version: 1,
      aliases: [
        { id: 'greasyhands', cloneFrom: 'openai-codex', email: 'greasyhands@agentmail.to', disabled: false },
        { id: 'nastypolice', cloneFrom: 'openai-codex', email: 'nastypolice@agentmail.to', disabled: false },
        { id: 'steadyatlas', cloneFrom: 'openai-codex', email: 'steadyatlas@agentmail.to', disabled: false },
        { id: 'blockedember', cloneFrom: 'openai-codex', email: 'blockedember@agentmail.to', disabled: false },
      ],
      pools: [{ name: 'openai-codex', providers: ['greasyhands', 'nastypolice', 'steadyatlas', 'blockedember'], routes: [] }],
      policy: {},
    });

    seedJson(authPath, {
      greasyhands: { email: 'greasyhands@agentmail.to', access: 'tok-g', expires: Date.now() + 60_000, accountId: 'acct-g' },
      nastypolice: { email: 'nastypolice@agentmail.to', access: 'tok-n', expires: Date.now() + 60_000, accountId: 'acct-n' },
      steadyatlas: { email: 'steadyatlas@agentmail.to', access: 'tok-s', expires: Date.now() + 60_000, accountId: 'acct-s' },
      blockedember: { email: 'blockedember@agentmail.to', access: 'tok-b', expires: Date.now() + 60_000, accountId: 'acct-b' },
    });

    seedJson(healthPath, {
      version: 1,
      providers: {},
      models: {
        'greasyhands/gpt-5.4': { quotaRemainingFraction: 0.9, quotaCheckedAt: Date.now() - 86_400_000 },
        'nastypolice/gpt-5.4': { quotaRemainingFraction: 0.95, quotaCheckedAt: Date.now() - 86_400_000 },
        'steadyatlas/gpt-5.4': { quotaRemainingFraction: 0.9, quotaCheckedAt: Date.now() },
        'blockedember/gpt-5.4': { quotaRemainingFraction: 0.8, quotaCheckedAt: Date.now() },
      },
    });

    const probeAlias = jest.fn(async ({ aliasId }) => {
      if (aliasId === 'nastypolice') {
        return {
          liveCheckedAt: Date.now(),
          codexReachable: false,
          workspaceMembership: true,
          recoverable: true,
          quotaSource: 'live-probe',
        };
      }
      if (aliasId === 'steadyatlas') {
        return {
          liveCheckedAt: Date.now(),
          codexReachable: true,
          workspaceMembership: true,
          quotaSource: 'live-probe',
        };
      }
      if (aliasId === 'blockedember') {
        return {
          liveCheckedAt: Date.now(),
          blockedReason: 'workspace-hard-cap',
          quotaSource: 'live-probe',
        };
      }
      throw new Error(`unexpected alias ${aliasId}`);
    });

    const audit = await auditCodexFleetLive({
      routerPath,
      authPath,
      healthPath,
      excludedAliases: ['greasyhands'],
      probeAlias,
    });

    expect(audit.excludedAliases).toEqual(['greasyhands']);
    expect(audit.aliases.map((alias) => alias.aliasId)).toEqual(['nastypolice', 'steadyatlas', 'blockedember']);

    expect(audit.aliases.find((alias) => alias.aliasId === 'nastypolice')).toEqual(expect.objectContaining({
      classification: 'recover-browserless',
      authPresent: true,
      quotaSource: 'live-probe',
    }));
    expect(audit.aliases.find((alias) => alias.aliasId === 'steadyatlas')).toEqual(expect.objectContaining({
      classification: 'keep-live',
    }));
    expect(audit.aliases.find((alias) => alias.aliasId === 'blockedember')).toEqual(expect.objectContaining({
      classification: 'blocked',
      blockerReason: 'workspace-hard-cap',
    }));

    expect(probeAlias).toHaveBeenCalledTimes(3);
  });

  test('classifies aliases without reusable auth as recreate-browserless', async () => {
    seedJson(routerPath, {
      version: 1,
      aliases: [
        { id: 'freshreplace', cloneFrom: 'openai-codex', email: 'freshreplace@agentmail.to', disabled: false },
      ],
      pools: [{ name: 'openai-codex', providers: ['freshreplace'], routes: [] }],
      policy: {},
    });
    seedJson(authPath, {});
    seedJson(healthPath, { version: 1, providers: {}, models: {} });

    const audit = await auditCodexFleetLive({
      routerPath,
      authPath,
      healthPath,
      probeAlias: async () => ({ liveCheckedAt: Date.now(), recreateNeeded: true, quotaSource: 'live-probe' }),
    });

    expect(audit.aliases).toHaveLength(1);
    expect(audit.aliases[0]).toEqual(expect.objectContaining({
      aliasId: 'freshreplace',
      classification: 'recreate-browserless',
      authPresent: false,
    }));
  });
});
