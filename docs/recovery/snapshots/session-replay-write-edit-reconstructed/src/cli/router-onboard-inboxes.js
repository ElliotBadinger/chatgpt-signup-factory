#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { onboardInboxToPiRouter } from '../pipeline/rotation/routerOnboarder.js';

const POOL_PATH = path.join(os.homedir(), '.pi', 'agent', 'codex-inbox-pool.json');

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    emails: [],
    poolPath: POOL_PATH,
    authJsonPath: path.join(os.homedir(), '.pi', 'agent', 'auth.json'),
    routerJsonPath: path.join(os.homedir(), '.pi', 'agent', 'account-router.json'),
    evidenceBase: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--email') opts.emails.push(argv[++i]);
    else if (arg === '--pool-path') opts.poolPath = argv[++i];
    else if (arg === '--auth-json-path') opts.authJsonPath = argv[++i];
    else if (arg === '--router-json-path') opts.routerJsonPath = argv[++i];
    else if (arg === '--evidence-base') opts.evidenceBase = argv[++i];
  }
  return opts;
}

function loadPool(poolPath) {
  return JSON.parse(fs.readFileSync(poolPath, 'utf8'));
}

function findPoolEntry(pool, email) {
  const entry = (pool.entries ?? []).find((item) => String(item.inboxAddress ?? '').toLowerCase() === String(email).toLowerCase());
  if (!entry) throw new Error(`No pool entry found for ${email}`);
  if (!entry.rootApiKey) throw new Error(`Pool entry for ${email} is missing rootApiKey`);
  return entry;
}

async function main() {
  const opts = parseArgs();
  if (opts.emails.length === 0) {
    throw new Error('At least one --email is required');
  }

  const pool = loadPool(opts.poolPath);
  const results = [];

  for (const email of opts.emails) {
    const entry = findPoolEntry(pool, email);
    console.log(`[router-onboard] Starting ${email}`);
    const result = await onboardInboxToPiRouter({
      email,
      apiKey: entry.rootApiKey,
      authJsonPath: opts.authJsonPath,
      routerJsonPath: opts.routerJsonPath,
      log: (...args) => console.log(...args),
    });

    if (opts.evidenceBase) {
      const aliasDir = path.join(opts.evidenceBase, `${result.aliasId}-agentmail-to`);
      fs.mkdirSync(aliasDir, { recursive: true });
      fs.writeFileSync(path.join(aliasDir, 'otp-found.json'), JSON.stringify(result.otp, null, 2));
      fs.writeFileSync(path.join(aliasDir, 'captured-session.json'), JSON.stringify({
        aliasId: result.aliasId,
        email: result.email,
        captureUrl: result.capture.finalUrl,
        title: result.capture.title,
        verification: result.verification,
        sessionSummary: {
          user: result.capture.session.user,
          expires: result.capture.session.expires,
          account: result.capture.session.account,
          authProvider: result.capture.session.authProvider,
          hasAccessToken: Boolean(result.capture.session.accessToken),
          hasSessionToken: Boolean(result.capture.session.sessionToken),
        },
      }, null, 2));
      fs.writeFileSync(path.join(aliasDir, 'verify.json'), JSON.stringify(result.verification, null, 2));
    }

    results.push({
      aliasId: result.aliasId,
      email: result.email,
      verification: result.verification.pass,
      accountId: result.auth.accountId,
      finalUrl: result.capture.finalUrl,
    });
    console.log(`[router-onboard] Completed ${email} -> ${result.aliasId}`);
  }

  console.log(JSON.stringify({ ok: true, count: results.length, results }, null, 2));
}

main().catch((err) => {
  console.error('[router-onboard] Fatal error:', err.message);
  process.exit(1);
});
