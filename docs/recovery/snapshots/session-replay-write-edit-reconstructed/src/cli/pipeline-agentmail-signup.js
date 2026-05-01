#!/usr/bin/env node

import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  DEFAULT_SIGNUP_CSV_PATH,
  bootstrapSignupEnv,
  loadSignupRegistry,
  provisionWorkspaceAliases,
} from '../agentmail/agentWorkspaceSignup.js';

const { values } = parseArgs({
  options: {
    'registry-path': { type: 'string', default: path.join(process.cwd(), 'state', 'rotation', 'live-workspace-registry.json') },
    'csv-path': { type: 'string', default: DEFAULT_SIGNUP_CSV_PATH },
  },
  strict: true,
  allowPositionals: false,
});

bootstrapSignupEnv({ cwd: process.cwd() });

const registry = loadSignupRegistry(values['registry-path']);
const result = await provisionWorkspaceAliases({
  registry,
  csvPath: values['csv-path'],
  env: process.env,
});

console.log(JSON.stringify({
  ok: true,
  csvPath: result.csvPath,
  created: result.created.map((record) => ({
    workspaceAlias: record.workspaceAlias,
    humanEmail: record.humanEmail,
    organizationId: record.organizationId,
    inboxId: record.inboxId,
    apiKey: record.apiKey,
    verifyStatus: record.verifyStatus,
    otpInstruction: record.otpInstruction,
    verifyCommand: record.verifyCommand,
  })),
  skipped: result.skipped.map((item) => ({
    workspaceAlias: item.workspaceAlias,
    reason: item.reason,
  })),
}, null, 2));
