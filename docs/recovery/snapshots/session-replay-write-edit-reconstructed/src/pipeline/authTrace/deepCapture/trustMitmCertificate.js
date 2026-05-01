import { mkdir } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile as defaultExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(defaultExecFile);

export async function findCertutilBinary(opts = {}, deps = {}) {
  const candidates = opts.candidates ?? [
    process.env.CERTUTIL_BIN,
    'certutil',
    '/usr/bin/certutil',
    '/usr/local/bin/certutil',
    '/home/linuxbrew/.linuxbrew/bin/certutil',
  ].filter(Boolean);
  const exists = deps.exists ?? (async (p) => {
    try {
      await access(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

export async function ensureMitmCertificateTrusted(opts = {}, deps = {}) {
  const { homeDir, certPath, certutilBin } = opts;
  const execFile = deps.execFile ?? execFileAsync;
  const dbDir = path.join(homeDir, '.pki', 'nssdb');
  await mkdir(dbDir, { recursive: true });
  const sqlDb = `sql:${dbDir}`;

  await execFile(certutilBin, ['-N', '-d', sqlDb, '--empty-password']);
  try {
    await execFile(certutilBin, ['-D', '-d', sqlDb, '-n', 'mitmproxy']);
  } catch {}
  await execFile(certutilBin, ['-A', '-d', sqlDb, '-n', 'mitmproxy', '-t', 'C,,', '-i', certPath]);

  return { ok: true, dbDir, certPath, certutilBin };
}
