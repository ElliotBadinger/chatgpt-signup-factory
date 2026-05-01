/**
 * piAccountRegistrar.js
 *
 * Registers a newly onboarded ChatGPT team member into pi's account-router system:
 *   - Writes OAuth credentials to ~/.pi/agent/auth.json
 *   - Adds alias + route to ~/.pi/agent/account-router.json
 *   - Removes a retired alias from both files
 *
 * Uses the same JSON file contracts observed in the extension source:
 *   auth.json:           { [aliasId]: { type: 'oauth', access, refresh, expires, accountId } }
 *   account-router.json: { version:1, aliases: [...], pools: [...], policy: {} }
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
const AUTH_JSON_PATH = process.env.PI_AUTH_JSON_PATH || path.join(PI_AGENT_DIR, 'auth.json');
const ROUTER_JSON_PATH = process.env.PI_ROUTER_JSON_PATH || path.join(PI_AGENT_DIR, 'account-router.json');

const DEFAULT_POOL = 'default';
const DEFAULT_MODEL = 'gpt-5.4';
const BASE_PROVIDER = 'openai-codex';

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function atomicWrite(filePath, data) {
  ensureDir(filePath);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function loadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Derive a deterministic alias ID from an email address.
 * e.g. "brainydesk135@agentmail.to" → "brainydesk135"
 */
export function emailToAliasId(email) {
  if (typeof email !== 'string') throw new TypeError('email must be a string');
  const local = email.split('@')[0];
  // Normalize: lowercase, replace non-alphanumeric (except underscore) with underscore
  return local.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Write an OAuth credential entry to auth.json.
 */
export function writeAuthCredential({
  aliasId,
  accessToken,
  refreshToken = null,
  expiresAt = null,
  accountId = null,
  authJsonPath = AUTH_JSON_PATH,
}) {
  const data = loadJson(authJsonPath, {});
  data[aliasId] = {
    type: 'oauth',
    access: accessToken,
    ...(refreshToken ? { refresh: refreshToken } : {}),
    ...(expiresAt ? { expires: expiresAt } : {}),
    ...(accountId ? { accountId } : {}),
  };
  atomicWrite(authJsonPath, data);
}

/**
 * Remove an alias credential from auth.json.
 */
export function removeAuthCredential(aliasId, authJsonPath = AUTH_JSON_PATH) {
  const data = loadJson(authJsonPath, {});
  if (!(aliasId in data)) return false;
  delete data[aliasId];
  atomicWrite(authJsonPath, data);
  return true;
}

/**
 * Upsert an alias and add it to the route pool in account-router.json.
 */
export function registerAlias({
  aliasId,
  email,
  label = '',
  poolName = DEFAULT_POOL,
  modelId = DEFAULT_MODEL,
  baseProviderId = BASE_PROVIDER,
  routerJsonPath = ROUTER_JSON_PATH,
}) {
  const config = loadJson(routerJsonPath, { version: 1, aliases: [], pools: [], policy: {} });
  if (config.version !== 1) throw new Error(`Unsupported account-router.json version: ${config.version}`);

  // Upsert alias
  const aliases = Array.isArray(config.aliases) ? [...config.aliases] : [];
  const existingIdx = aliases.findIndex((a) => a.id === aliasId);
  const newAlias = {
    id: aliasId,
    cloneFrom: baseProviderId,
    apiKey: 'unused',
    email,
    label: label || aliasId,
    disabled: false,
  };
  if (existingIdx >= 0) {
    aliases[existingIdx] = { ...aliases[existingIdx], ...newAlias };
  } else {
    aliases.push(newAlias);
  }

  // Upsert pool and route
  const pools = Array.isArray(config.pools) ? [...config.pools] : [];
  let pool = pools.find((p) => p.name === poolName);
  if (!pool) {
    pool = { name: poolName, providers: [], routes: [] };
    pools.push(pool);
  }

  const providers = Array.isArray(pool.providers) ? [...pool.providers] : [];
  if (!providers.includes(aliasId)) providers.push(aliasId);

  const routes = Array.isArray(pool.routes) ? [...pool.routes] : [];
  if (!routes.some((r) => r.provider === aliasId && r.model === modelId)) {
    routes.push({ provider: aliasId, model: modelId });
  }

  // Rebuild pools
  const updatedPools = pools.map((p) =>
    p.name !== poolName ? p : { ...p, providers, routes },
  );

  atomicWrite(routerJsonPath, {
    ...config,
    aliases,
    pools: updatedPools,
  });
}

/**
 * Remove an alias and its routes from account-router.json.
 */
export function deregisterAlias(aliasId, {
  poolName = DEFAULT_POOL,
  routerJsonPath = ROUTER_JSON_PATH,
} = {}) {
  const config = loadJson(routerJsonPath, { version: 1, aliases: [], pools: [], policy: {} });

  const aliases = (config.aliases ?? []).filter((a) => a.id !== aliasId);

  const pools = (config.pools ?? []).map((pool) => {
    if (pool.name !== poolName && poolName !== '*') return pool;
    return {
      ...pool,
      providers: (pool.providers ?? []).filter((p) => p !== aliasId),
      routes: (pool.routes ?? []).filter((r) => r.provider !== aliasId),
    };
  });

  atomicWrite(routerJsonPath, { ...config, aliases, pools });
  return true;
}

/**
 * Full registration: write auth.json + account-router.json for a newly onboarded member.
 */
export function registerNewMember({
  email,
  accessToken,
  refreshToken = null,
  expiresAt = null,
  accountId = null,
  poolName = DEFAULT_POOL,
  modelId = DEFAULT_MODEL,
  authJsonPath = AUTH_JSON_PATH,
  routerJsonPath = ROUTER_JSON_PATH,
  log = () => {},
}) {
  const aliasId = emailToAliasId(email);
  log(`[piAccountRegistrar] Registering ${email} as alias ${aliasId}`);

  writeAuthCredential({
    aliasId,
    accessToken,
    refreshToken,
    expiresAt,
    accountId,
    authJsonPath,
  });
  log(`[piAccountRegistrar] Wrote auth.json for ${aliasId}`);

  registerAlias({
    aliasId,
    email,
    label: aliasId,
    poolName,
    modelId,
    routerJsonPath,
  });
  log(`[piAccountRegistrar] Wrote account-router.json for ${aliasId}`);

  return { aliasId, email };
}

/**
 * Full retirement: remove auth.json + account-router.json for an exhausted member.
 */
export function retireMember({
  email,
  aliasId: explicitAliasId,
  poolName = DEFAULT_POOL,
  authJsonPath = AUTH_JSON_PATH,
  routerJsonPath = ROUTER_JSON_PATH,
  log = () => {},
}) {
  const aliasId = explicitAliasId || emailToAliasId(email);
  log(`[piAccountRegistrar] Retiring ${email} (aliasId=${aliasId})`);

  const authRemoved = removeAuthCredential(aliasId, authJsonPath);
  const routerRemoved = deregisterAlias(aliasId, { poolName, routerJsonPath });

  log(`[piAccountRegistrar] Retired: auth=${authRemoved}, router=${routerRemoved}`);
  return { aliasId, authRemoved, routerRemoved };
}

/**
 * List all current codex aliases from account-router.json.
 */
export function listCodexAliases(routerJsonPath = ROUTER_JSON_PATH) {
  const config = loadJson(routerJsonPath, { version: 1, aliases: [] });
  return (config.aliases ?? []).filter(
    (a) => a.cloneFrom === BASE_PROVIDER && !a.disabled,
  );
}
