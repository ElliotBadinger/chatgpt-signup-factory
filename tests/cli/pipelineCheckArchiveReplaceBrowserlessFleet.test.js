import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '../../src/cli/pipeline-check-archive-replace.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-browserless-fleet-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedFiles() {
  const archivePath = path.join(tmpDir, 'archive.json');
  const poolPath = path.join(tmpDir, 'pool.json');
  const healthPath = path.join(tmpDir, 'health.json');
  const routerPath = path.join(tmpDir, 'router.json');
  const authPath = path.join(tmpDir, 'auth.json');

  fs.writeFileSync(archivePath, JSON.stringify({ version: 1, aliases: [] }));
  fs.writeFileSync(poolPath, JSON.stringify({
    version: 1,
    entries: [{
      inboxAddress: 'standby-a@agentmail.to',
      rootEmail: 'root-a@example.com',
      rootOrgId: 'org-a',
      workspaceGroupKey: 'lineage-a',
      rootApiKeyPrefix: 'am_',
      cfRuleId: 'r1',
      cfKvNamespaceId: 'kv1',
      status: 'available',
      statusUpdatedAt: Date.now(),
    }],
    lastCheckedAt: 0,
    allEntriesExhausted: false,
  }));
  fs.writeFileSync(healthPath, JSON.stringify({
    version: 1,
    providers: {},
    models: {
      'aliasA/gpt-5.4': { quotaRemainingFraction: 0.0, quotaCheckedAt: Date.now(), quotaProofAmbiguous: false },
      'aliasB/gpt-5.4': { quotaRemainingFraction: 0.8, quotaCheckedAt: Date.now(), quotaProofAmbiguous: false },
    },
  }));
  fs.writeFileSync(routerPath, JSON.stringify({
    version: 1,
    aliases: [
      { id: 'aliasA', cloneFrom: 'openai-codex', email: 'aliasA@agentmail.to', label: 'aliasA', disabled: false, lineage: 'lineage-a' },
      { id: 'aliasB', cloneFrom: 'openai-codex', email: 'aliasB@agentmail.to', label: 'aliasB', disabled: false, lineage: 'lineage-b' },
    ],
    pools: [{ name: 'openai-codex', providers: ['aliasA', 'aliasB'], routes: [] }],
    policy: {},
  }));
  fs.writeFileSync(authPath, JSON.stringify({
    aliasA: { access: 'tok-a', expires: Date.now() + 60_000, accountId: 'acct-a' },
    aliasB: { access: 'tok-b', expires: Date.now() + 60_000, accountId: 'acct-b' },
  }));

  return { archivePath, poolPath, healthPath, routerPath, authPath };
}

describe('pipeline-check-archive-replace browserless fleet output', () => {
  test('writes browserless audit artifacts, prints grouped policy counts, and does not mention local Chrome fallback', () => {
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
      env: { ...process.env },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Browserless audit artifact:/);
    expect(result.stdout).toMatch(/Quota policy groups:/);
    expect(result.stdout).toMatch(/codex usability/i);
    expect(result.stdout).not.toMatch(/local Chrome fallback/i);

    const match = result.stdout.match(/Browserless audit artifact:\s+(.*)/);
    expect(match).toBeTruthy();
    const artifactPath = match[1].trim();
    expect(fs.existsSync(artifactPath)).toBe(true);

    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    expect(artifact.quotaPolicy.groups).toBeTruthy();
  });
});
