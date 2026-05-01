import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from '@jest/globals';

import { writeDetailedArtifact } from '../../../src/pipeline/authTrace/detailedArtifacts.js';

describe('writeDetailedArtifact', () => {
  test('writes requests/responses artifacts as json files', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'trace-detail-'));
    const filePath = await writeDetailedArtifact(path.join(dir, 'requests'), 'req-1', { url: 'https://chatgpt.com/api/auth/session' });
    const raw = await readFile(filePath, 'utf8');
    expect(JSON.parse(raw)).toEqual({ url: 'https://chatgpt.com/api/auth/session' });
  });
});
