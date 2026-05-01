import { describe, expect, test } from '@jest/globals';

import { parseBrowserlessBootstrapReplayArgs } from '../../src/cli/pipeline-auth-bootstrap-replay.js';

describe('parseBrowserlessBootstrapReplayArgs', () => {
  test('parses run dir, output path, and plan path', () => {
    const args = parseBrowserlessBootstrapReplayArgs(['--run-dir', '/tmp/run', '--plan', '/tmp/plan.json', '--output', '/tmp/out.json']);
    expect(args.runDir).toBe('/tmp/run');
    expect(args.planPath).toBe('/tmp/plan.json');
    expect(args.outputPath).toBe('/tmp/out.json');
  });
});
