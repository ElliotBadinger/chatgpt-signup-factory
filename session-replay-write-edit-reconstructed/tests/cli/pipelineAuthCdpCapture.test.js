import { describe, expect, jest, test } from '@jest/globals';

import { parseAuthCdpCaptureArgs, runAuthCdpCaptureCli } from '../../src/cli/pipeline-auth-cdp-capture.js';

describe('pipeline auth cdp capture CLI', () => {
  test('parses flags and delegates to runAuthCdpCapture', async () => {
    expect(parseAuthCdpCaptureArgs([
      '--scenario', 'signup-new',
      '--label', 'cdp-run',
      '--artifact-dir', '/tmp/auth-traces',
      '--start-url', 'https://auth.openai.com/log-in-or-create-account',
      '--target', 'ABCDEF12',
      '--cdp-port', '41565',
    ])).toEqual({
      scenario: 'signup-new',
      label: 'cdp-run',
      artifactDir: '/tmp/auth-traces',
      startUrl: 'https://auth.openai.com/log-in-or-create-account',
      target: 'ABCDEF12',
      cdpPort: 41565,
      cdpWsUrl: null,
    });

    const runAuthCdpCapture = jest.fn(async () => ({ status: 'ok' }));
    const waitForEnter = jest.fn(async () => {});
    const result = await runAuthCdpCaptureCli(['--label', 'x'], { runAuthCdpCapture, waitForEnter });
    expect(runAuthCdpCapture).toHaveBeenCalledWith(expect.objectContaining({ label: 'x' }), expect.objectContaining({ waitForEnter }));
    expect(result.status).toBe('ok');
  });
});
