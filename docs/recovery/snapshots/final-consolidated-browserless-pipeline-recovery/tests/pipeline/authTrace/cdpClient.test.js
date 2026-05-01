import { describe, expect, jest, test } from '@jest/globals';

import { parseCdpList, selectTargetFromPages, runCdpCommand } from '../../../src/pipeline/authTrace/cdpLive/cdpClient.js';

describe('parseCdpList', () => {
  test('parses list output into page entries', () => {
    const pages = parseCdpList('ABCDEF12  ChatGPT                                      https://chatgpt.com/\n12345678  Login                                        https://auth.openai.com/log-in-or-create-account');
    expect(pages).toEqual([
      { targetIdPrefix: 'ABCDEF12', title: 'ChatGPT', url: 'https://chatgpt.com/' },
      { targetIdPrefix: '12345678', title: 'Login', url: 'https://auth.openai.com/log-in-or-create-account' },
    ]);
  });
});

describe('selectTargetFromPages', () => {
  test('auto-picks auth/chatgpt page when unique', () => {
    const target = selectTargetFromPages([
      { targetIdPrefix: 'ABCDEF12', title: 'Other', url: 'https://example.com/' },
      { targetIdPrefix: '12345678', title: 'Login', url: 'https://auth.openai.com/log-in-or-create-account' },
    ]);
    expect(target.targetIdPrefix).toBe('12345678');
  });

  test('throws when multiple candidates exist and no explicit target given', () => {
    expect(() => selectTargetFromPages([
      { targetIdPrefix: 'AAAABBBB', title: 'ChatGPT', url: 'https://chatgpt.com/' },
      { targetIdPrefix: 'CCCCDDDD', title: 'Login', url: 'https://auth.openai.com/' },
    ])).toThrow(/Ambiguous/);
  });

  test('uses explicit target prefix when provided', () => {
    const target = selectTargetFromPages([
      { targetIdPrefix: 'AAAABBBB', title: 'ChatGPT', url: 'https://chatgpt.com/' },
      { targetIdPrefix: 'CCCCDDDD', title: 'Login', url: 'https://auth.openai.com/' },
    ], 'CCCC');
    expect(target.targetIdPrefix).toBe('CCCCDDDD');
  });
});

describe('runCdpCommand', () => {
  test('executes vendored cdp script and returns stdout', async () => {
    const execFile = jest.fn(async () => ({ stdout: 'ok\n', stderr: '' }));
    const out = await runCdpCommand({ args: ['list'] }, { execFile });
    expect(execFile).toHaveBeenCalledWith(
      'node',
      expect.any(Array),
      expect.objectContaining({ cwd: process.cwd(), env: expect.any(Object) }),
    );
    expect(out.trim()).toBe('ok');
  });

  test('passes cdp port override through environment', async () => {
    const execFile = jest.fn(async () => ({ stdout: 'ok\n', stderr: '' }));
    await runCdpCommand({ args: ['list'], cdpPort: 41565 }, { execFile });
    expect(execFile).toHaveBeenCalledWith(
      'node',
      expect.any(Array),
      expect.objectContaining({ env: expect.objectContaining({ CDP_PORT: '41565' }) }),
    );
  });
});
