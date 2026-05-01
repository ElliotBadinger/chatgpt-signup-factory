import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '../../src/cli/pipeline-check-archive-replace.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-preremove-permission-boundary-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('pipeline-check-archive-replace pre-removal permission boundary handling', () => {
  test('skips aliases that cannot remove other users and continues to removable members', () => {
    const archivePath = path.join(tmpDir, 'archive.json');
    const poolPath = path.join(tmpDir, 'pool.json');
    const healthPath = path.join(tmpDir, 'health.json');
    const routerPath = path.join(tmpDir, 'router.json');
    const authPath = path.join(tmpDir, 'auth.json');
    const registryPath = path.join(tmpDir, 'registry.json');
    const usersPath = path.join(tmpDir, 'workspace-users.json');

    fs.writeFileSync(archivePath, JSON.stringify({ version: 1, aliases: [] }));
    fs.writeFileSync(poolPath, JSON.stringify({
      version: 1,
      entries: [
        { inboxAddress: 'available-a@agentmail.to', status: 'available', statusUpdatedAt: Date.now() },
        { inboxAddress: 'available-b@agentmail.to', status: 'available', statusUpdatedAt: Date.now() },
      ],
      lastCheckedAt: 0,
      allEntriesExhausted: false,
    }));
    fs.writeFileSync(healthPath, JSON.stringify({
      version: 1,
      providers: {
        blockedAlias: { status: 'cooldown' },
        memberAlias: { status: 'cooldown' },
      },
      models: {},
    }));
    fs.writeFileSync(routerPath, JSON.stringify({
      version: 1,
      aliases: [
        { id: 'blockedAlias', cloneFrom: 'openai-codex', email: 'blocked@agentmail.to', label: 'blockedAlias', disabled: false },
        { id: 'memberAlias', cloneFrom: 'openai-codex', email: 'member@agentmail.to', label: 'memberAlias', disabled: false },
      ],
      pools: [{ name: 'openai-codex', providers: ['blockedAlias', 'memberAlias'], routes: [] }],
      policy: {},
    }));
    fs.writeFileSync(authPath, JSON.stringify({
      blockedAlias: { access: 'tok-blocked', expires: Date.now() + 60_000, accountId: 'workspace-a' },
      memberAlias: { access: 'tok-member', expires: Date.now() + 60_000, accountId: 'workspace-a' },
    }));
    fs.writeFileSync(registryPath, JSON.stringify({
      discoveredAt: Date.now(),
      owners: [{ ownerAliasId: 'blockedAlias', ownerEmail: null, ownerAccountId: 'workspace-a', lineage: 'blockedAlias' }],
      workspaces: [{
        workspaceId: 'workspace-a',
        workspaceName: 'Workspace A',
        ownerAliasId: 'blockedAlias',
        ownerEmail: null,
        ownerAccountId: 'workspace-a',
        lineage: 'blockedAlias',
        currentMembers: 2,
        maxMembers: 8,
        healthyAccounts: 0,
      }],
    }));
    fs.writeFileSync(usersPath, JSON.stringify({
      'workspace-a': {
        items: [
          { id: 'u-blocked', email: 'blocked@agentmail.to', role: 'standard-user' },
          { id: 'u-member', email: 'member@agentmail.to', role: 'standard-user' },
        ],
      },
    }));

    const result = spawnSync(process.execPath, ['--experimental-vm-modules', CLI,
      '--archive-path', archivePath,
      '--pool-path', poolPath,
      '--health-path', healthPath,
      '--router-path', routerPath,
      '--auth-path', authPath,
    ], {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_REGISTRY_PATH: registryPath,
        PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_WORKSPACE_USERS_PATH: usersPath,
        PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_PERMISSION_BOUNDARY_WORKSPACE: 'workspace-a',
        PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_PERMISSION_BOUNDARY_EMAIL: 'blocked@agentmail.to',
        PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_EXIT_AFTER_PRE_REMOVE: '1',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Pre-removing 2 exhausted workspace member/);
    expect(result.stdout + result.stderr).toMatch(/Skipped pre-removal for blocked@agentmail\.to: insufficient-permissions/);
    expect(result.stdout + result.stderr).toMatch(/✓ Removed member@agentmail\.to from workspace-a/);
    expect(result.stdout + result.stderr).toMatch(/Test exit after pre-remove/);
    expect(result.stdout + result.stderr).not.toMatch(/Live-fix preparation failed/);
  });
});