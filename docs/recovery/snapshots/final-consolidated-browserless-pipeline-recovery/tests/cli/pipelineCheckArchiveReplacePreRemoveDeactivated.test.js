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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-preremove-deactivated-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('pipeline-check-archive-replace pre-removal deactivated workspace handling', () => {
  test('skips deactivated resolved workspace during pre-removal and reports explicit context', () => {
    const archivePath = path.join(tmpDir, 'archive.json');
    const poolPath = path.join(tmpDir, 'pool.json');
    const healthPath = path.join(tmpDir, 'health.json');
    const routerPath = path.join(tmpDir, 'router.json');
    const authPath = path.join(tmpDir, 'auth.json');
    const registryPath = path.join(tmpDir, 'registry.json');

    fs.writeFileSync(archivePath, JSON.stringify({ version: 1, aliases: [] }));
    fs.writeFileSync(poolPath, JSON.stringify({
      version: 1,
      entries: [{ inboxAddress: 'available@agentmail.to', status: 'available', statusUpdatedAt: Date.now() }],
      lastCheckedAt: 0,
      allEntriesExhausted: false,
    }));
    fs.writeFileSync(healthPath, JSON.stringify({
      version: 1,
      providers: { aliasDead: { status: 'cooldown' } },
      models: {},
    }));
    fs.writeFileSync(routerPath, JSON.stringify({
      version: 1,
      aliases: [
        { id: 'aliasDead', cloneFrom: 'openai-codex', email: 'dead@agentmail.to', label: 'aliasDead', disabled: false },
      ],
      pools: [{ name: 'openai-codex', providers: ['aliasDead'], routes: [] }],
      policy: {},
    }));
    fs.writeFileSync(authPath, JSON.stringify({
      aliasDead: { access: 'tok-dead', expires: Date.now() + 60_000, accountId: 'workspace-dead' },
    }));
    fs.writeFileSync(registryPath, JSON.stringify({
      discoveredAt: Date.now(),
      owners: [{ ownerAliasId: 'openai-codex', ownerEmail: null, ownerAccountId: 'workspace-dead', lineage: 'openai-codex' }],
      workspaces: [{
        workspaceId: 'workspace-dead',
        workspaceName: 'Dead Workspace',
        ownerAliasId: 'openai-codex',
        ownerEmail: null,
        ownerAccountId: 'workspace-dead',
        lineage: 'openai-codex',
        currentMembers: 0,
        maxMembers: 8,
        healthyAccounts: 0,
      }],
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
        PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_DEACTIVATED_WORKSPACE: 'workspace-dead',
        PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_EXIT_AFTER_PRE_REMOVE: '1',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Pre-removing 1 exhausted workspace member/);
    expect(result.stdout + result.stderr).toMatch(/Skipped pre-removal for dead@agentmail\.to: workspace-deactivated/);
    expect(result.stdout + result.stderr).toMatch(/Test exit after pre-remove/);
    expect(result.stdout + result.stderr).not.toMatch(/Live-fix preparation failed/);
  });
});
