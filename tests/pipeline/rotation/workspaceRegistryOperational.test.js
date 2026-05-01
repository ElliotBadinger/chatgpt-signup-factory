import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { discoverOperationalWorkspaceRegistry, mergeUsableSupplyRoots } from '../../../src/pipeline/rotation/workspaceRegistry.js';

let tmpDir;
let authPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-registry-operational-'));
  authPath = path.join(tmpDir, 'auth.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe('discoverOperationalWorkspaceRegistry', () => {
  test('invalid member alias does not block discovery when a valid owner/root token exists for the same workspace account id', async () => {
    fs.writeFileSync(authPath, JSON.stringify({
      invalidMember: {
        access: 'tok-bad',
        expires: Date.now() + 60_000,
        accountId: 'workspace-a',
      },
      workspaceOwner: {
        access: 'tok-good',
        expires: Date.now() + 60_000,
        accountId: 'workspace-a',
        email: 'root-a@example.com',
        lineage: 'lineage-a',
      },
    }, null, 2));

    const listWorkspacesForOwner = jest.fn(async ({ ownerAliasId }) => {
      if (ownerAliasId === 'invalidMember') {
        throw new Error('Your authentication token has been invalidated. Please try signing in again.');
      }
      return [{ workspaceId: 'workspace-a', workspaceName: 'Workspace A', currentMembers: 2, maxMembers: 8 }];
    });

    const registry = await discoverOperationalWorkspaceRegistry({
      authPath,
      listWorkspacesForOwner,
    });

    expect(listWorkspacesForOwner).toHaveBeenCalledTimes(2);
    expect(listWorkspacesForOwner).toHaveBeenCalledWith(expect.objectContaining({ ownerAliasId: 'workspaceOwner' }));
    expect(registry.owners).toEqual([
      expect.objectContaining({ ownerAliasId: 'workspaceOwner', ownerEmail: 'root-a@example.com', lineage: 'lineage-a' }),
    ]);
    expect(registry.workspaces).toEqual([
      expect.objectContaining({ workspaceId: 'workspace-a', ownerAliasId: 'workspaceOwner', ownerEmail: 'root-a@example.com', lineage: 'lineage-a' }),
    ]);
  });

  test('retains deactivated workspace observations but selects a live usable workspace for the lineage', async () => {
    fs.writeFileSync(authPath, JSON.stringify({
      deadOwner: {
        access: 'tok-dead',
        expires: Date.now() + 60_000,
        accountId: 'personal-dead',
        email: 'dead-root@example.com',
        lineage: 'lineage-a',
      },
      liveOwner: {
        access: 'tok-live',
        expires: Date.now() + 60_000,
        accountId: 'personal-live',
        email: 'live-root@example.com',
        lineage: 'lineage-a',
      },
    }, null, 2));

    const listWorkspacesForOwner = jest.fn(async ({ ownerAliasId }) => {
      if (ownerAliasId === 'deadOwner') {
        return [{
          workspaceId: 'workspace-dead',
          workspaceName: 'Dead Workspace',
          lineage: 'lineage-a',
          deactivated: true,
          eligible: false,
          usable: false,
          eligibilityStatus: 'workspace-deactivated',
        }];
      }
      return [{
        workspaceId: 'workspace-live',
        workspaceName: 'Live Workspace',
        lineage: 'lineage-a',
        currentMembers: 2,
        maxMembers: 8,
        healthyAccounts: 3,
      }];
    });

    const registry = await discoverOperationalWorkspaceRegistry({
      authPath,
      listWorkspacesForOwner,
    });

    expect(registry.observedWorkspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspaceId: 'workspace-dead', usable: false, deactivated: true, eligibilityStatus: 'workspace-deactivated' }),
      expect.objectContaining({ workspaceId: 'workspace-live', usable: true, deactivated: false, ownerAliasId: 'liveOwner' }),
    ]));
    expect(registry.usableByLineage['lineage-a']).toEqual(expect.objectContaining({
      ownerAliasId: 'liveOwner',
      ownerEmail: 'live-root@example.com',
      workspaceId: 'workspace-live',
    }));
    expect(registry.workspaces).toEqual([
      expect.objectContaining({ workspaceId: 'workspace-live', ownerAliasId: 'liveOwner' }),
    ]);
  });

  test('fails closed when no valid usable workspace exists for any lineage', async () => {
    fs.writeFileSync(authPath, JSON.stringify({
      invalidA: {
        access: 'tok-a',
        expires: Date.now() + 60_000,
        accountId: 'workspace-a',
      },
      invalidB: {
        access: 'tok-b',
        expires: Date.now() + 60_000,
        accountId: 'workspace-a',
      },
    }, null, 2));

    const listWorkspacesForOwner = jest.fn(async ({ ownerAliasId }) => {
      throw new Error(`token invalid for ${ownerAliasId}`);
    });

    await expect(discoverOperationalWorkspaceRegistry({
      authPath,
      listWorkspacesForOwner,
    })).rejects.toMatchObject({
      message: expect.stringContaining('No valid operational workspace auth'),
      codePath: 'workspace-registry-operational-auth',
      ownerAccountId: 'workspace-a',
      attemptedOwnerAliasIds: ['invalidA', 'invalidB'],
    });
  });
});

describe('mergeUsableSupplyRoots', () => {
  test('adds a new verified supply root record without mutating usable workspace selection', () => {
    const registry = {
      workspaces: [
        { workspaceId: 'workspace-a', workspaceName: 'Workspace A', lineage: 'lineage-a', ownerAliasId: 'owner-a', ownerEmail: 'owner-a@example.com', usable: true },
      ],
      usableSupplyRoots: [],
    };

    const updated = mergeUsableSupplyRoots(registry, [{
      rootEmail: 'fresh-root@example.com',
      ownerAliasId: 'owner-a',
      lineage: 'lineage-a',
      workspaceId: 'workspace-a',
      workspaceName: 'Workspace A',
      lastVerifiedAt: '2026-03-17T12:00:00.000Z',
    }]);

    expect(updated.workspaces).toEqual(registry.workspaces);
    expect(updated.usableSupplyRoots).toEqual([
      expect.objectContaining({
        rootEmail: 'fresh-root@example.com',
        ownerAliasId: 'owner-a',
        lineage: 'lineage-a',
        workspaceId: 'workspace-a',
      }),
    ]);
    expect(updated.usableSupplyRootsByLineage['lineage-a']).toEqual(expect.objectContaining({
      rootEmail: 'fresh-root@example.com',
      workspaceId: 'workspace-a',
    }));
  });
});
