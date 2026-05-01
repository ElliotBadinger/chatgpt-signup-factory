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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-preremove-codex-lb-protected-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('pipeline-check-archive-replace pre-removal codex-lb protection handling', () => {
  test('pre-removes only actionable aliases after codex-lb target-workspace protection', () => {
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
      entries: [{ inboxAddress: 'available@agentmail.to', status: 'available', statusUpdatedAt: Date.now() }],
      lastCheckedAt: 0,
      allEntriesExhausted: false,
    }));
    fs.writeFileSync(healthPath, JSON.stringify({
      version: 1,
      providers: {
        aliasKeep: { status: 'cooldown' },
        aliasReplace: { status: 'cooldown' },
      },
      models: {},
    }));
    fs.writeFileSync(routerPath, JSON.stringify({
      version: 1,
      aliases: [
        { id: 'aliasKeep', cloneFrom: 'openai-codex', email: 'keep@agentmail.to', label: 'aliasKeep', disabled: false },
        { id: 'aliasReplace', cloneFrom: 'openai-codex', email: 'replace@agentmail.to', label: 'aliasReplace', disabled: false },
      ],
      pools: [{ name: 'openai-codex', providers: ['aliasKeep', 'aliasReplace'], routes: [] }],
      policy: {},
    }));
    fs.writeFileSync(authPath, JSON.stringify({
      aliasKeep: { access: 'tok-keep', expires: Date.now() + 60_000, accountId: 'workspace-a' },
      aliasReplace: { access: 'tok-replace', expires: Date.now() + 60_000, accountId: 'workspace-a' },
    }));
    fs.writeFileSync(registryPath, JSON.stringify({
      discoveredAt: Date.now(),
      owners: [{ ownerAliasId: 'owner-a', ownerEmail: null, ownerAccountId: 'workspace-a', lineage: 'lineage-a' }],
      workspaces: [{
        workspaceId: 'workspace-a',
        workspaceName: 'Workspace A',
        ownerAliasId: 'owner-a',
        ownerEmail: null,
        ownerAccountId: 'workspace-a',
        lineage: 'lineage-a',
        currentMembers: 2,
        maxMembers: 8,
        healthyAccounts: 0,
      }],
    }));
    fs.writeFileSync(usersPath, JSON.stringify({
      'workspace-a': {
        items: [
          { id: 'u-keep', email: 'keep@agentmail.to', role: 'standard-user' },
          { id: 'u-replace', email: 'replace@agentmail.to', role: 'standard-user' },
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
        PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_TARGET_WORKSPACE_ID: 'workspace-a',
        PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_CODEX_LB_QUOTA_POSITIVE_EMAILS: 'keep@agentmail.to',
        PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_EXIT_AFTER_PRE_REMOVE: '1',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Pre-removing 1 exhausted workspace member/);
    expect(result.stdout + result.stderr).toMatch(/✓ Removed replace@agentmail\.to from workspace-a/);
    expect(result.stdout + result.stderr).not.toMatch(/keep@agentmail\.to/);
    expect(result.stdout + result.stderr).toMatch(/Test exit after pre-remove/);
    expect(result.stdout + result.stderr).not.toMatch(/Live-fix preparation failed/);
  });
});