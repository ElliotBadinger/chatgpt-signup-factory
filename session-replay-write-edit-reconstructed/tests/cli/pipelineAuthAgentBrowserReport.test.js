import { describe, expect, test } from '@jest/globals';

import { parseAgentBrowserReportArgs } from '../../src/cli/pipeline-auth-agent-browser-report.js';

describe('parseAgentBrowserReportArgs', () => {
  test('parses run dir and dry-run flag', () => {
    const args = parseAgentBrowserReportArgs(['--run-dir', '/tmp/run', '--dry-run']);
    expect(args.runDir).toBe('/tmp/run');
    expect(args.dryRun).toBe(true);
  });
});
