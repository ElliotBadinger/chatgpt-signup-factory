import { describe, expect, jest, test } from '@jest/globals';

import { parseProxyOnlyCaptureArgs, runProxyOnlyCaptureCli, createTtyEnterPrompt } from '../../src/cli/pipeline-auth-capture-proxy-only.js';

describe('pipeline auth capture proxy-only CLI', () => {
  test('parses flags and delegates to runProxyOnlyAuthCapture', async () => {
    expect(parseProxyOnlyCaptureArgs([
      '--scenario', 'signup-new',
      '--label', 'proxy-only-run',
      '--artifact-dir', '/tmp/auth-traces',
      '--start-url', 'https://auth.openai.com/log-in-or-create-account',
      '--proxy-port', '9988',
      '--mitm-bin', '/home/me/.local/bin/mitmdump',
      '--chrome-bin', '/usr/bin/google-chrome',
    ])).toEqual({
      scenario: 'signup-new',
      label: 'proxy-only-run',
      artifactDir: '/tmp/auth-traces',
      startUrl: 'https://auth.openai.com/log-in-or-create-account',
      proxyPort: 9988,
      mitmBin: '/home/me/.local/bin/mitmdump',
      chromeBin: '/usr/bin/google-chrome',
    });

    const runProxyOnlyAuthCapture = jest.fn(async () => ({ status: 'ok' }));
    const waitForEnter = jest.fn(async () => {});
    const result = await runProxyOnlyCaptureCli(['--label', 'x'], { runProxyOnlyAuthCapture, waitForEnter });
    expect(runProxyOnlyAuthCapture).toHaveBeenCalledWith(expect.objectContaining({ label: 'x' }), expect.objectContaining({ waitForEnter }));
    expect(result.status).toBe('ok');
  });

  test('createTtyEnterPrompt uses /dev/tty instead of process stdin', async () => {
    const rl = { question: jest.fn(async () => {}), close: jest.fn() };
    const createInterface = jest.fn(() => rl);
    const openTty = jest.fn(() => ({ input: 'tty-in', output: 'tty-out' }));
    const prompt = createTtyEnterPrompt({ createInterface, openTty });

    await prompt('hello');

    expect(openTty).toHaveBeenCalled();
    expect(createInterface).toHaveBeenCalledWith({ input: 'tty-in', output: 'tty-out' });
    expect(rl.question).toHaveBeenCalledWith('hello\n');
    expect(rl.close).toHaveBeenCalled();
  });
});
