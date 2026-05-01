import { describe, expect, test } from '@jest/globals';
import { buildCliConfig, parseArgs } from '../../src/cli/pipeline-auth-catalog.js';

describe('parseArgs', () => {
  test('parses --trace-dir', () => {
    const cfg = parseArgs(['--trace-dir', '/tmp/my-trace']);
    expect(cfg.traceDir).toBe('/tmp/my-trace');
  });

  test('parses --dry-run flag', () => {
    const cfg = parseArgs(['--trace-dir', '/tmp/my-trace', '--dry-run']);
    expect(cfg.dryRun).toBe(true);
  });

  test('defaults dryRun to false', () => {
    const cfg = parseArgs(['--trace-dir', '/tmp/my-trace']);
    expect(cfg.dryRun).toBe(false);
  });
});

describe('buildCliConfig', () => {
  test('returns valid config from parsed args', () => {
    const cfg = buildCliConfig({ traceDir: '/tmp/t', dryRun: false });
    expect(cfg.traceDir).toBe('/tmp/t');
    expect(cfg.dryRun).toBe(false);
  });
});
