import { describe, expect, jest, test } from '@jest/globals';

import { parseAuthTraceArgs, runAuthTraceCli } from '../../src/cli/pipeline-auth-trace.js';

describe('pipeline auth trace CLI', () => {
  test('parses flags and delegates to runAuthTrace', async () => {
    expect(parseAuthTraceArgs([
      '--mode', 'manual',
      '--scenario', 'signup-new',
      '--label', 'local-smoke',
      '--artifact-dir', '/tmp/auth-traces',
      '--start-url', 'https://chatgpt.com/',
    ])).toEqual({
      mode: 'manual',
      scenario: 'signup-new',
      label: 'local-smoke',
      artifactDir: '/tmp/auth-traces',
      startUrl: 'https://chatgpt.com/',
    });

    const runAuthTrace = jest.fn(async (opts) => ({ status: 'ok', opts }));
    const waitForEnter = jest.fn(async () => {});
    const result = await runAuthTraceCli(['--mode', 'manual', '--label', 'x'], { runAuthTrace, waitForEnter });
    expect(runAuthTrace).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'manual', label: 'x' }),
      expect.objectContaining({ waitForEnter }),
    );
    expect(result.status).toBe('ok');
  });

  test('does not inject waitForEnter for non-manual modes', async () => {
    const runAuthTrace = jest.fn(async (opts) => ({ status: 'ok', opts }));
    const waitForEnter = jest.fn(async () => {});
    await runAuthTraceCli(['--mode', 'assisted', '--label', 'x'], { runAuthTrace, waitForEnter });
    expect(runAuthTrace).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'assisted', label: 'x' }),
      expect.not.objectContaining({ waitForEnter }),
    );
  });
});
