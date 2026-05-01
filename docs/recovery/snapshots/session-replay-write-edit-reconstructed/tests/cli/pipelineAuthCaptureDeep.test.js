import { describe, expect, jest, test } from '@jest/globals';

import { parseDeepCaptureArgs, runDeepCaptureCli } from '../../src/cli/pipeline-auth-capture-deep.js';

describe('pipeline auth capture deep CLI', () => {
  test('parses flags and delegates to runDeepAuthCapture', async () => {
    expect(parseDeepCaptureArgs([
      '--scenario', 'signup-new',
      '--label', 'deep-run',
      '--artifact-dir', '/tmp/auth-traces',
      '--start-url', 'https://chatgpt.com/',
      '--proxy-port', '8899',
      '--mitm-bin', '/home/me/.local/bin/mitmdump',
      '--chrome-bin', '/usr/bin/google-chrome',
      '--certutil-bin', '/home/me/.local/bin/certutil',
      '--browser-url', 'http://127.0.0.1:9223',
    ])).toEqual({
      scenario: 'signup-new',
      label: 'deep-run',
      artifactDir: '/tmp/auth-traces',
      startUrl: 'https://chatgpt.com/',
      proxyPort: 8899,
      mitmBin: '/home/me/.local/bin/mitmdump',
      chromeBin: '/usr/bin/google-chrome',
      certutilBin: '/home/me/.local/bin/certutil',
      browserUrl: 'http://127.0.0.1:9223',
    });

    const runDeepAuthCapture = jest.fn(async () => ({ status: 'ok' }));
    const waitForEnter = jest.fn(async () => {});
    const result = await runDeepCaptureCli(['--label', 'x'], { runDeepAuthCapture, waitForEnter });
    expect(runDeepAuthCapture).toHaveBeenCalledWith(expect.objectContaining({ label: 'x' }), expect.objectContaining({ waitForEnter }));
    expect(result.status).toBe('ok');
  });
});
