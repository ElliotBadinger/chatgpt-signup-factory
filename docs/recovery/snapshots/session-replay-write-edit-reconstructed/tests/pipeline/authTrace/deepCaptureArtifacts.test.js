import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from '@jest/globals';

import { buildMitmAddonSource, writeJsonArtifact } from '../../../src/pipeline/authTrace/deepCapture/deepCaptureArtifacts.js';

describe('deepCaptureArtifacts', () => {
  test('buildMitmAddonSource embeds output path config variable name', () => {
    const source = buildMitmAddonSource();
    expect(source).toContain('pi_flows_path');
    expect(source).toContain('requestheaders');
    expect(source).toContain('responseheaders');
  });

  test('writeJsonArtifact writes pretty json', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'deep-cap-artifact-'));
    const file = path.join(dir, 'x.json');
    await writeJsonArtifact(file, { ok: true });
    const content = await readFile(file, 'utf8');
    expect(content).toContain('"ok": true');
  });
});
