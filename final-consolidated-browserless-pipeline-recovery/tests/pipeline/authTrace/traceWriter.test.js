import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from '@jest/globals';

import { createTraceWriter } from '../../../src/pipeline/authTrace/traceWriter.js';

describe('createTraceWriter', () => {
  test('appends one redacted JSON object per line', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'trace-writer-'));
    const filePath = path.join(dir, 'trace.jsonl');
    const writer = createTraceWriter(filePath);

    await writer.write({ type: 'request', headers: { Authorization: 'Bearer topsecret' } });
    await writer.write({ type: 'nav', url: 'https://chatgpt.com/' });

    const raw = await readFile(filePath, 'utf8');
    const lines = raw.trim().split('\n').map((line) => JSON.parse(line));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ type: 'request', headers: { Authorization: '[REDACTED]' } });
    expect(lines[1]).toMatchObject({ type: 'nav', url: 'https://chatgpt.com/' });
  });
});
