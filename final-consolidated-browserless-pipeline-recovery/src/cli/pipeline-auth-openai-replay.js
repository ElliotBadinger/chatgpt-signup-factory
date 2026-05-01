#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { analyzeOpenAiAuthTelemetry } from '../pipeline/authTrace/openaiAuthTelemetryAnalysis.js';
import { replayOpenAiAuthFlow } from '../pipeline/authTrace/openaiAuthReplay.js';
import { createAgentMailInbox } from '../pipeline/authTrace/agentMailInboxProvisioning.js';
import { isResendReceivingAddress } from '../pipeline/authTrace/resendReceiving.js';

const DEFAULT_POOL_PATH = path.join(os.homedir(), '.pi', 'agent', 'codex-inbox-pool.json');

export function parseOpenAiReplayArgs(argv = process.argv.slice(2)) {
  let traceDir = null;
  let email = null;
  let mode = 'auto';
  let artifactDir = null;
  let poolPath = DEFAULT_POOL_PATH;
  let rootApiKey = null;
  let createNewInbox = false;
  let inboxDisplayName = 'OpenAI Signup Replay';
  let password = null;
  let profileName = 'Codex Agent';
  let birthdate = '2003-03-15';
  let createResendAlias = false;
  let resendAliasPrefix = 'openai';
  let resendDomain = process.env.RESEND_RECEIVING_DOMAIN ?? 'epistemophile.store';

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--trace-dir' && argv[index + 1]) {
      traceDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (argv[index] === '--email' && argv[index + 1]) {
      email = argv[index + 1];
      index += 1;
      continue;
    }
    if (argv[index] === '--mode' && argv[index + 1]) {
      mode = argv[index + 1];
      index += 1;
      continue;
    }
    if (argv[index] === '--artifact-dir' && argv[index + 1]) {
      artifactDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (argv[index] === '--pool-path' && argv[index + 1]) {
      poolPath = argv[index + 1];
      index += 1;
      continue;
    }
    if ((argv[index] === '--root-api-key' || argv[index] === '--agentmail-api-key') && argv[index + 1]) {
      rootApiKey = argv[index + 1];
      index += 1;
      continue;
    }
    if (argv[index] === '--create-new-inbox') {
      createNewInbox = true;
      continue;
    }
    if (argv[index] === '--create-resend-alias') {
      createResendAlias = true;
      continue;
    }
    if (argv[index] === '--resend-alias-prefix' && argv[index + 1]) {
      resendAliasPrefix = argv[index + 1];
      index += 1;
      continue;
    }
    if (argv[index] === '--resend-domain' && argv[index + 1]) {
      resendDomain = argv[index + 1];
      index += 1;
      continue;
    }
    if (argv[index] === '--inbox-display-name' && argv[index + 1]) {
      inboxDisplayName = argv[index + 1];
      index += 1;
      continue;
    }
    if (argv[index] === '--password' && argv[index + 1]) {
      password = argv[index + 1];
      index += 1;
      continue;
    }
    if (argv[index] === '--name' && argv[index + 1]) {
      profileName = argv[index + 1];
      index += 1;
      continue;
    }
    if (argv[index] === '--birthdate' && argv[index + 1]) {
      birthdate = argv[index + 1];
      index += 1;
    }
  }

  return {
    traceDir,
    email,
    mode,
    artifactDir,
    poolPath,
    rootApiKey,
    createNewInbox,
    inboxDisplayName,
    password,
    profileName,
    birthdate,
    createResendAlias,
    resendAliasPrefix,
    resendDomain,
  };
}

function readPool(poolPath) {
  return JSON.parse(fs.readFileSync(poolPath, 'utf8'));
}

function resolveRootApiKey(args) {
  if (args.rootApiKey) return args.rootApiKey;
  const pool = readPool(args.poolPath);
  const key = pool.entries?.find((entry) => entry.rootApiKey)?.rootApiKey ?? null;
  if (!key) {
    throw new Error(`No rootApiKey found in ${args.poolPath}`);
  }
  return key;
}

async function main() {
  const args = parseOpenAiReplayArgs();
  if (!args.traceDir) {
    console.error('Usage: pipeline-auth-openai-replay --trace-dir <path> [--email <inbox> | --create-new-inbox] [--mode auto|existing-login-otp|signup-new] [--artifact-dir <path>] [--pool-path <path>] [--root-api-key <key>]');
    process.exit(1);
  }

  const analysis = await analyzeOpenAiAuthTelemetry(args.traceDir, { dryRun: true });

  let newInbox = null;
  let effectiveEmail = args.email;
  let agentMailApiKey = args.rootApiKey ?? null;

  if (args.createNewInbox) {
    agentMailApiKey = resolveRootApiKey(args);
    newInbox = await createAgentMailInbox({
      apiKey: agentMailApiKey,
      displayName: args.inboxDisplayName,
    });
    effectiveEmail = newInbox.email;
  }

  if (args.createResendAlias) {
    const suffix = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    effectiveEmail = `${args.resendAliasPrefix}_${suffix}@${args.resendDomain}`;
  }

  if (!effectiveEmail) {
    console.error('Usage: pipeline-auth-openai-replay --trace-dir <path> [--email <inbox> | --create-new-inbox] [--mode auto|existing-login-otp|signup-new] [--artifact-dir <path>] [--pool-path <path>] [--root-api-key <key>]');
    process.exit(1);
  }

  const replay = await replayOpenAiAuthFlow({
    email: effectiveEmail,
    mode: args.mode,
    analysis,
    poolPath: args.poolPath,
    agentMailApiKey,
    resendApiKey: isResendReceivingAddress(effectiveEmail, { domain: args.resendDomain }) ? process.env.RESEND_API_KEY : null,
    password: args.password,
    profileName: args.profileName,
    birthdate: args.birthdate,
  });

  if (args.artifactDir) {
    await mkdir(args.artifactDir, { recursive: true });
    const summary = {
      email: effectiveEmail,
      branch: replay.branch,
      verdict: replay.verdict,
      startedAt: replay.startedAt,
      completedAt: replay.completedAt,
      latencyMs: replay.latencyMs,
      finalSession: replay.finalSession,
    };
    await Promise.all([
      writeFile(path.join(args.artifactDir, 'openai-auth-report.json'), `${JSON.stringify(analysis.report, null, 2)}\n`, 'utf8'),
      writeFile(path.join(args.artifactDir, 'openai-auth-plan.json'), `${JSON.stringify(analysis.plan, null, 2)}\n`, 'utf8'),
      writeFile(path.join(args.artifactDir, 'openai-auth-replay.json'), `${JSON.stringify(replay, null, 2)}\n`, 'utf8'),
      writeFile(path.join(args.artifactDir, 'signup-e2e-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8'),
      ...(newInbox
        ? [writeFile(path.join(args.artifactDir, 'new-inbox.json'), `${JSON.stringify(newInbox, null, 2)}\n`, 'utf8')]
        : []),
    ]);
  }

  process.stdout.write(`${JSON.stringify(replay, null, 2)}\n`);
  if (replay.verdict !== 'authenticated') {
    process.exit(2);
  }
}

if (process.argv[1]?.endsWith('pipeline-auth-openai-replay.js')) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
