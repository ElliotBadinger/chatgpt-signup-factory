import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startRotationDaemon } from '../../src/pipeline/rotation/rotationDaemon.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '../../src/cli/pipeline-rotate.js');

describe('pipeline-rotate unattended mutation policy', () => {
  test('blocks live single-cycle rotation outside the canonical locked entrypoint', () => {
    const result = spawnSync(process.execPath, [CLI], {
      encoding: 'utf8',
      timeout: 15_000,
      env: process.env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/deep-interview fleet concurrency policy/i);
    expect(result.stderr).toMatch(/pipeline-check-archive-replace\.js/i);
  });

  test('blocks direct live daemon startup outside the canonical locked entrypoint', () => {
    expect(() => startRotationDaemon({ dryRun: false })).toThrow(
      /deep-interview fleet concurrency policy/i,
    );
  });
});