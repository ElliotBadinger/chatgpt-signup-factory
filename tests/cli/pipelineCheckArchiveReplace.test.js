import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '../../src/cli/pipeline-check-archive-replace.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-car-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedFiles(overrides = {}) {
  const archivePath = path.join(tmpDir, 'archive.json');
  const poolPath    = path.join(tmpDir, 'pool.json');
  const healthPath  = path.join(tmpDir, 'health.json');
  const routerPath  = path.join(tmpDir, 'router.json');
  const authPath    = path.join(tmpDir, 'auth.json');

  fs.writeFileSync(archivePath, JSON.stringify(overrides.archive ?? { version: 1, aliases: [] }));
  fs.writeFileSync(poolPath, JSON.stringify(overrides.pool ?? {
    version: 1,
    entries: [
      {
        inboxAddress: 'a@agentmail.to',
        rootEmail: 'root@example.com',
        rootOrgId: 'org1',
        rootApiKeyPrefix: 'am_',
        cfRuleId: 'r1',
        cfKvNamespaceId: 'kv1',
        status: 'available',
        statusUpdatedAt: Date.now(),
      },
      {
        inboxAddress: 'b@agentmail.to',
        rootEmail: 'root@example.com',
        rootOrgId: 'org1',
        rootApiKeyPrefix: 'am_',
        cfRuleId: 'r1',
        cfKvNamespaceId: 'kv1',
        status: 'in-use',
        statusUpdatedAt: Date.now(),
      },
    ],
    lastCheckedAt: 0,
    allEntriesExhausted: false,
  }));
  fs.writeFileSync(healthPath, JSON.stringify(overrides.health ?? {
    version: 1, providers: {}, models: {},
  }));
  fs.writeFileSync(routerPath, JSON.stringify(overrides.router ?? {
    version: 1,
    aliases: [
      { id: 'alias1', cloneFrom: 'openai-codex', apiKey: 'unused', email: 'alias1@agentmail.to', label: 'alias1', disabled: false },
    ],
    pools: [{ name: 'openai-codex', providers: ['alias1'], routes: [{ provider: 'alias1', model: 'gpt-5.4' }] }],
    policy: {},
  }));
  fs.writeFileSync(authPath, JSON.stringify(overrides.auth ?? {}));

  return { archivePath, poolPath, healthPath, routerPath, authPath };
}

function runCli(args, extraEnv = {}) {
  return spawnSync(
    process.execPath,
    ['--experimental-vm-modules', CLI, ...args],
    {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, ...extraEnv },
    },
  );
}

// ─────────────────────────── --status ────────────────────────────────────────────
describe('--status flag', () => {
  test('exits 0 and prints Archive: and Pool: sections', () => {
    const { archivePath, poolPath, healthPath, routerPath } = seedFiles();
    const r = runCli([
      '--status',
      '--archive-path', archivePath,
      '--pool-path', poolPath,
      '--health-path', healthPath,
      '--router-path', routerPath,
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Archive:/);
    expect(r.stdout).toMatch(/Pool:/);
  });

  test('--status shows correct available count', () => {
    const { archivePath, poolPath, healthPath, routerPath } = seedFiles();
    const r = runCli([
      '--status',
      '--archive-path', archivePath,
      '--pool-path', poolPath,
      '--health-path', healthPath,
      '--router-path', routerPath,
    ]);
    // Pool has 1 available, 1 in-use
    expect(r.stdout).toMatch(/1 available/);
    expect(r.stdout).toMatch(/1 in-use/);
  });

  test('--status shows archived alias count', () => {
    const archive = {
      version: 1,
      aliases: [
        { aliasId: 'old1', reinstated: false },
        { aliasId: 'old2', reinstated: true },
      ],
    };
    const { archivePath, poolPath, healthPath, routerPath } = seedFiles({ archive });
    const r = runCli([
      '--status',
      '--archive-path', archivePath,
      '--pool-path', poolPath,
      '--health-path', healthPath,
      '--router-path', routerPath,
    ]);
    expect(r.stdout).toMatch(/2 aliases archived/);
    expect(r.stdout).toMatch(/1 reinstated/);
  });
});

// ─────────────────────────── --dry-run ───────────────────────────────────────────
describe('--dry-run flag', () => {
  test('exits 0 and mentions dry-run in output', () => {
    const { archivePath, poolPath, healthPath, routerPath, authPath } = seedFiles();
    const r = runCli([
      '--dry-run',
      '--archive-path', archivePath,
      '--pool-path', poolPath,
      '--health-path', healthPath,
      '--router-path', routerPath,
      '--auth-path', authPath,
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout.toLowerCase()).toMatch(/dry.?run/);
  });

  test('--dry-run does not modify pool or archive files', () => {
    const { archivePath, poolPath, healthPath, routerPath, authPath } = seedFiles();
    const poolBefore    = fs.readFileSync(poolPath, 'utf8');
    const archiveBefore = fs.readFileSync(archivePath, 'utf8');

    runCli([
      '--dry-run',
      '--archive-path', archivePath,
      '--pool-path', poolPath,
      '--health-path', healthPath,
      '--router-path', routerPath,
      '--auth-path', authPath,
    ]);

    expect(fs.readFileSync(poolPath, 'utf8')).toBe(poolBefore);
    expect(fs.readFileSync(archivePath, 'utf8')).toBe(archiveBefore);
  });
});

// ─────────────────────────── prints result summary ───────────────────────────────
describe('result summary', () => {
  test('prints Exhausted processed and New accounts created lines', () => {
    const { archivePath, poolPath, healthPath, routerPath, authPath } = seedFiles();
    const r = runCli([
      '--dry-run',
      '--archive-path', archivePath,
      '--pool-path', poolPath,
      '--health-path', healthPath,
      '--router-path', routerPath,
      '--auth-path', authPath,
    ]);
    expect(r.stdout).toMatch(/Exhausted processed:/);
    expect(r.stdout).toMatch(/New accounts created:/);
  });

  test('prints Router onboarded when router-onboard emails are requested', () => {
    const { archivePath, poolPath, healthPath, routerPath, authPath } = seedFiles();
    const r = runCli([
      '--dry-run',
      '--router-onboard-email', 'a@agentmail.to',
      '--archive-path', archivePath,
      '--pool-path', poolPath,
      '--health-path', healthPath,
      '--router-path', routerPath,
      '--auth-path', authPath,
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Router onboarded:/);
  });
});
