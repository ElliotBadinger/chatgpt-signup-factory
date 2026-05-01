import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from '@jest/globals';

import {
  ensureTraceRunDir,
  traceArtifactDir,
  traceRunId,
} from '../../../src/pipeline/authTrace/artifacts.js';

describe('traceRunId', () => {
  test('returns deterministic run id for label and date', () => {
    const now = new Date('2026-03-15T18:00:01.000Z');
    expect(traceRunId('local smoke', now)).toBe('2026-03-15T18-00-01-000Z-local-smoke');
  });
});

describe('traceArtifactDir', () => {
  test('nests run id under base dir', () => {
    expect(traceArtifactDir('/tmp/auth-traces', 'run-123')).toBe(path.join('/tmp/auth-traces', 'run-123'));
  });
});

describe('ensureTraceRunDir', () => {
  test('creates base, checkpoints, screenshots, requests, responses dirs', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'auth-trace-artifacts-'));
    const runDir = path.join(base, 'run-a');

    await ensureTraceRunDir(runDir);

    for (const rel of ['', 'checkpoints', 'screenshots', 'requests', 'responses']) {
      const info = await stat(path.join(runDir, rel));
      expect(info.isDirectory()).toBe(true);
    }
  });
});
