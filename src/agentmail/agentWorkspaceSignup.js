import fs from 'node:fs';
import path from 'node:path';

import { loadRepoEnv } from '../pipeline/config/repoEnv.js';
import { resolveRoutingDomain, WORKSPACE_OWNER_ALIAS_CANDIDATES } from '../pipeline/config/routingDomain.js';

export const AGENTMAIL_API_BASE_URL = 'https://api.agentmail.to/v0';
export const DEFAULT_SIGNUP_CSV_PATH = path.join(process.cwd(), 'state', 'agentmail', 'agentmail_accounts.csv');
export const CSV_FIELDS = [
  'workspaceAlias',
  'workspaceKey',
  'workspaceId',
  'workspaceName',
  'ownerEmail',
  'routingDomain',
  'humanEmail',
  'username',
  'organizationId',
  'inboxId',
  'apiKey',
  'verifyStatus',
  'createdAt',
  'updatedAt',
];

function csvEscape(value) {
  const text = String(value ?? '');
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export function loadSignupRecords(csvPath = DEFAULT_SIGNUP_CSV_PATH) {
  if (!fs.existsSync(csvPath)) return [];
  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/u).filter(Boolean);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}

export function saveSignupRecords(csvPath = DEFAULT_SIGNUP_CSV_PATH, records = []) {
  const rows = [CSV_FIELDS.join(',')];
  for (const record of records) {
    rows.push(CSV_FIELDS.map((field) => csvEscape(record[field] ?? '')).join(','));
  }
  atomicWrite(csvPath, `${rows.join('\n')}\n`);
}

function uniqueWorkspaceOwnerAliases(registry = {}) {
  const discovered = new Set(
    [...(registry.ownerCandidates ?? []), ...(registry.workspaces ?? [])]
      .map((entry) => entry?.ownerAliasId)
      .filter((value) => typeof value === 'string' && /^workspace-owner-[a-z0-9]+$/u.test(value)),
  );

  for (const alias of WORKSPACE_OWNER_ALIAS_CANDIDATES.filter((value) => /^workspace-owner-[a-z0-9]+$/u.test(value))) {
    discovered.add(alias);
  }

  return [...discovered].sort();
}

function workspaceKeyFromAlias(workspaceAlias) {
  return String(workspaceAlias).replace(/^workspace-owner-/u, '');
}

function preferredWorkspaceRecord(registry = {}, workspaceAlias) {
  const workspaceMatches = (registry.workspaces ?? []).filter((workspace) => workspace?.ownerAliasId === workspaceAlias);
  if (workspaceMatches.length > 0) return workspaceMatches[0];
  const ownerMatch = (registry.ownerCandidates ?? []).find((entry) => entry?.ownerAliasId === workspaceAlias);
  return ownerMatch ?? null;
}

function buildSignupIdentity({ workspaceAlias, ownerEmail = null, env = process.env, now = Date.now } = {}) {
  const workspaceKey = workspaceKeyFromAlias(workspaceAlias);
  const timestamp = Number(now());
  const identitySeed = `agentmailroot${workspaceKey}${timestamp}`;
  const routingDomain = resolveRoutingDomain({
    ...env,
    WORKSPACE_OWNER_EMAIL: ownerEmail || env.WORKSPACE_OWNER_EMAIL || '',
  });

  return {
    workspaceKey,
    routingDomain,
    humanEmail: `${identitySeed}@${routingDomain}`,
    username: identitySeed,
  };
}

export function buildWorkspaceSignupTargets({ registry = {}, env = process.env, now = Date.now } = {}) {
  return uniqueWorkspaceOwnerAliases(registry)
    .filter((workspaceAlias) => workspaceKeyFromAlias(workspaceAlias) !== 'b')
    .map((workspaceAlias) => {
      const record = preferredWorkspaceRecord(registry, workspaceAlias) ?? {};
      const identity = buildSignupIdentity({ workspaceAlias, ownerEmail: record.ownerEmail ?? null, env, now });
      return {
        workspaceAlias,
        workspaceKey: identity.workspaceKey,
        workspaceId: record.workspaceId ?? record.ownerAccountId ?? '',
        workspaceName: record.workspaceName ?? '',
        ownerEmail: record.ownerEmail ?? '',
        routingDomain: identity.routingDomain,
        humanEmail: identity.humanEmail,
        username: identity.username,
      };
    });
}

async function parseJsonResponse(response) {
  if (typeof response.json === 'function') {
    try {
      return await response.json();
    } catch {
      // fall through to text parsing
    }
  }

  const text = typeof response.text === 'function' ? await response.text() : '';
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function signUpAgentAccount({ humanEmail, username, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${AGENTMAIL_API_BASE_URL}/agent/sign-up`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ human_email: humanEmail, username }),
  });

  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(`AgentMail sign-up failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  return payload;
}

export async function verifyAccount(apiKey, otpCode, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${AGENTMAIL_API_BASE_URL}/agent/verify`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ otp_code: otpCode }),
  });

  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(`AgentMail verify failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  return payload;
}

export function formatVerifyCommand({ apiKey, workspaceAlias }) {
  return `node src/cli/pipeline-agentmail-verify.js --api-key ${apiKey} --otp-code <6-digit-otp>${workspaceAlias ? ` --workspace ${workspaceAlias}` : ''}`;
}

export async function provisionWorkspaceAliases({
  registry = {},
  csvPath = DEFAULT_SIGNUP_CSV_PATH,
  env = process.env,
  now = Date.now,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  const records = loadSignupRecords(csvPath);
  const targets = buildWorkspaceSignupTargets({ registry, env, now });
  const created = [];
  const skipped = [];
  const nowIso = new Date(Number(now())).toISOString();

  for (const target of targets) {
    const existing = records.find((record) => record.workspaceAlias === target.workspaceAlias);
    if (existing) {
      skipped.push({ ...target, reason: 'already-exists', existing });
      continue;
    }

    const payload = await signUpAgentAccount({
      humanEmail: target.humanEmail,
      username: target.username,
      fetchImpl,
    });

    const record = {
      workspaceAlias: target.workspaceAlias,
      workspaceKey: target.workspaceKey,
      workspaceId: target.workspaceId,
      workspaceName: target.workspaceName,
      ownerEmail: target.ownerEmail,
      routingDomain: target.routingDomain,
      humanEmail: target.humanEmail,
      username: target.username,
      organizationId: payload.organization_id ?? '',
      inboxId: payload.inbox_id ?? '',
      apiKey: payload.api_key ?? '',
      verifyStatus: 'PENDING_OTP',
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    records.push(record);
    created.push({
      ...record,
      otpInstruction: `OTP sent to ${record.humanEmail} — run verify once received`,
      verifyCommand: formatVerifyCommand({ apiKey: record.apiKey, workspaceAlias: record.workspaceAlias }),
    });
    log(`OTP sent to ${record.humanEmail} — run verify once received`);
    log(formatVerifyCommand({ apiKey: record.apiKey, workspaceAlias: record.workspaceAlias }));
  }

  saveSignupRecords(csvPath, records);
  return { csvPath, targets, created, skipped, records };
}

export function loadSignupRegistry(registryPath) {
  return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
}

export function bootstrapSignupEnv({ cwd = process.cwd() } = {}) {
  return loadRepoEnv({ cwd });
}
