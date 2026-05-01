#!/usr/bin/env node

import { parseArgs } from 'node:util';

import {
  DEFAULT_SIGNUP_CSV_PATH,
  loadSignupRecords,
  saveSignupRecords,
  verifyAccount,
} from '../agentmail/agentWorkspaceSignup.js';

const { values } = parseArgs({
  options: {
    'api-key': { type: 'string' },
    'otp-code': { type: 'string' },
    workspace: { type: 'string' },
    'csv-path': { type: 'string', default: DEFAULT_SIGNUP_CSV_PATH },
  },
  strict: true,
  allowPositionals: false,
});

if (!values['api-key']) {
  throw new Error('--api-key is required');
}
if (!values['otp-code']) {
  throw new Error('--otp-code is required');
}

const verification = await verifyAccount(values['api-key'], values['otp-code'], { fetchImpl: fetch });

const records = loadSignupRecords(values['csv-path']);
const nowIso = new Date().toISOString();
const nextRecords = records.map((record) => {
  if (record.apiKey !== values['api-key']) return record;
  if (values.workspace && record.workspaceAlias !== values.workspace) return record;
  return {
    ...record,
    verifyStatus: 'VERIFIED',
    updatedAt: nowIso,
  };
});
saveSignupRecords(values['csv-path'], nextRecords);

console.log(JSON.stringify({
  ok: true,
  verification,
  csvPath: values['csv-path'],
}, null, 2));
