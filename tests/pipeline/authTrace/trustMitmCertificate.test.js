import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, jest, test } from '@jest/globals';

import { ensureMitmCertificateTrusted, findCertutilBinary } from '../../../src/pipeline/authTrace/deepCapture/trustMitmCertificate.js';

describe('findCertutilBinary', () => {
  test('returns first existing candidate', async () => {
    const exists = jest.fn(async (p) => p === '/x/certutil');
    await expect(findCertutilBinary({ candidates: ['/a/certutil', '/x/certutil'] }, { exists })).resolves.toBe('/x/certutil');
  });
});

describe('ensureMitmCertificateTrusted', () => {
  test('initializes NSS DB and imports cert', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'mitm-trust-'));
    const execFile = jest.fn(async () => ({ stdout: '', stderr: '' }));

    const result = await ensureMitmCertificateTrusted({
      homeDir,
      certPath: '/tmp/mitmproxy-ca-cert.pem',
      certutilBin: '/x/certutil',
    }, { execFile });

    expect(execFile).toHaveBeenCalledWith('/x/certutil', ['-N', '-d', expect.stringContaining('sql:'), '--empty-password']);
    expect(execFile).toHaveBeenCalledWith('/x/certutil', ['-A', '-d', expect.stringContaining('sql:'), '-n', 'mitmproxy', '-t', 'C,,', '-i', '/tmp/mitmproxy-ca-cert.pem']);
    expect(result.ok).toBe(true);
  });
});
