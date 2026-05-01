import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, jest, test } from '@jest/globals';

import { attachChromeTraceSession } from '../../../src/pipeline/authTrace/chromeTraceSession.js';

describe('attachChromeTraceSession detailed artifacts', () => {
  test('writes detailed response artifacts for relevant internal endpoints', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'trace-response-artifacts-'));
    const listeners = new Map();
    const page = { on: jest.fn((event, fn) => listeners.set(event, fn)) };
    const writer = { write: jest.fn(async () => {}) };

    attachChromeTraceSession({ page, writer, runDir: dir });

    await listeners.get('response')({
      url: () => 'https://chatgpt.com/api/auth/session',
      status: () => 200,
      headers: () => ({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ accessToken: 'secret', user: { id: 'u1' } }),
    });

    const raw = await readFile(path.join(dir, 'responses', 'response-1.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.url).toBe('https://chatgpt.com/api/auth/session');
    expect(parsed.body.kind).toBe('json');
  });
});
