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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-livefix-failclosed-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_FAIL_PREPARATION;
});

function seedFiles() {
  const archivePath = path.join(tmpDir, 'archive.json');
  const poolPath = path.join(tmpDir, 'pool.json');
  const healthPath = path.join(tmpDir, 'health.json');
  const routerPath = path.join(tmpDir, 'router.json');
  const authPath = path.join(tmpDir, 'auth.json');

  fs.writeFileSync(archivePath, JSON.stringify({ version: 1, aliases: [] }));
  fs.writeFileSync(poolPath, JSON.stringify({ version: 1, entries: [], lastCheckedAt: 0, allEntriesExhausted: false }));
  fs.writeFileSync(healthPath, JSON.stringify({
    version: 1,
    providers: { alias1: { status: 'cooldown', reason: 'usage-limit' } },
    models: {},
  }));
  fs.writeFileSync(routerPath, JSON.stringify({
    version: 1,
    aliases: [{ id: 'alias1', cloneFrom: 'openai-codex', email: 'alias1@agentmail.to', label: 'alias1', disabled: false }],
    pools: [{ name: 'openai-codex', providers: ['alias1'], routes: [] }],
    policy: {},
  }));
  fs.writeFileSync(authPath, JSON.stringify({
    workspaceOwner: { access: 'tok', expires: Date.now() + 60_000, accountId: 'workspace-1', email: 'root@example.com' },
  }));

  return { archivePath, poolPath, healthPath, routerPath, authPath };
}

describe('pipeline-check-archive-replace live-fix preparation fail-closed', () => {
  test('exits non-zero instead of warning-and-continuing when live-fix preparation auth discovery fails', () => {
    const { archivePath, poolPath, healthPath, routerPath, authPath } = seedFiles();
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', CLI,
      '--dry-run',
      '--archive-path', archivePath,
      '--pool-path', poolPath,
      '--health-path', healthPath,
      '--router-path', routerPath,
      '--auth-path', authPath,
    ], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_FAIL_PREPARATION: 'workspaceOwner' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toMatch(/Live-fix preparation failed/);
    expect(result.stderr + result.stdout).toMatch(/workspaceOwner/);
    expect(result.stdout).not.toMatch(/=== Result ===/);
  });
});
