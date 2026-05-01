import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from '@jest/globals';

import {
  artifactDirPath,
  ensureArtifactDir,
  writeSummaryJson,
} from '../../../src/pipeline/evidence/artifacts.js';

describe('artifactDirPath', () => {
  test('returns deterministic path under baseDir keyed by runId', () => {
    const base = '/tmp/artifacts';
    const runId = 'run-abc-123';
    const result = artifactDirPath(base, runId);
    expect(result).toBe(path.join(base, runId));
  });

  test('same inputs always produce same output', () => {
    const base = '/data/runs';
    const runId = 'run-2026-03-13-xyz';
    expect(artifactDirPath(base, runId)).toBe(artifactDirPath(base, runId));
  });

  test('different runIds produce different paths', () => {
    const base = '/data/runs';
    expect(artifactDirPath(base, 'run-a')).not.toBe(artifactDirPath(base, 'run-b'));
  });

  test('different baseDirs produce different paths for same runId', () => {
    const runId = 'run-x';
    expect(artifactDirPath('/base-a', runId)).not.toBe(artifactDirPath('/base-b', runId));
  });

  test('path is always inside baseDir', () => {
    const base = '/my/base';
    const result = artifactDirPath(base, 'run-123');
    expect(result.startsWith(base + path.sep)).toBe(true);
  });
});

describe('ensureArtifactDir', () => {
  test('creates directory if it does not exist', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'artifacts-test-'));
    const artifactDir = path.join(base, 'run-new');

    await ensureArtifactDir(artifactDir);

    const info = await stat(artifactDir);
    expect(info.isDirectory()).toBe(true);
  });

  test('is idempotent — does not throw if directory already exists', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'artifacts-test-'));
    const artifactDir = path.join(base, 'run-existing');

    await ensureArtifactDir(artifactDir);
    await expect(ensureArtifactDir(artifactDir)).resolves.not.toThrow();
  });
});

describe('writeSummaryJson', () => {
  test('writes summary.json with formatted JSON inside artifactDir', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'artifacts-test-'));
    const artifactDir = path.join(base, 'run-summary');

    const data = {
      runId: 'run-summary',
      status: 'invited',
      target: 'user@example.com',
    };

    await writeSummaryJson(artifactDir, data);

    const filePath = path.join(artifactDir, 'summary.json');
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    expect(parsed).toEqual(data);
    // Verify pretty-printed format
    expect(raw).toContain('\n');
  });

  test('creates artifactDir if it does not exist before writing', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'artifacts-test-'));
    const artifactDir = path.join(base, 'run-autocreate');

    await writeSummaryJson(artifactDir, { foo: 'bar' });

    const filePath = path.join(artifactDir, 'summary.json');
    const raw = await readFile(filePath, 'utf8');
    expect(JSON.parse(raw)).toEqual({ foo: 'bar' });
  });

  test('overwrites existing summary.json', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'artifacts-test-'));
    const artifactDir = path.join(base, 'run-overwrite');

    await writeSummaryJson(artifactDir, { version: 1 });
    await writeSummaryJson(artifactDir, { version: 2 });

    const filePath = path.join(artifactDir, 'summary.json');
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    expect(parsed).toEqual({ version: 2 });
  });
});
