import { describe, expect, test } from '@jest/globals';

import { parseOpenAiReportArgs } from '../../src/cli/pipeline-auth-openai-report.js';

describe('parseOpenAiReportArgs', () => {
  test('parses trace dir and dry-run flag', () => {
    const args = parseOpenAiReportArgs(['--trace-dir', '/tmp/trace', '--dry-run']);
    expect(args.traceDir).toBe('/tmp/trace');
    expect(args.dryRun).toBe(true);
  });
});
