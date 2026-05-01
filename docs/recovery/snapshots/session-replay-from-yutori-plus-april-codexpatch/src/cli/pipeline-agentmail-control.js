#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseArgs } from 'node:util';

import {
  DEFAULT_CONTROL_PLANE_PATH,
  createWorkspaceInbox,
  listWorkspaceInboxes,
  loadAgentMailControlPlane,
  resolveCanonicalWorkspaceParent,
  signUpWorkspaceParentOrganization,
  verifyWorkspaceParentOrganization,
} from '../agentmail/controlPlane.js';
import { loadRepoEnv } from '../pipeline/config/repoEnv.js';
import { resolveWorkspaceOwnerEmail } from '../pipeline/config/routingDomain.js';

const DEFAULT_ROUTER_PATH = path.join(os.homedir(), '.pi', 'agent', 'account-router.json');
const DEFAULT_AUTH_PATH = path.join(os.homedir(), '.pi', 'agent', 'auth.json');
const DEFAULT_POOL_PATH = path.join(os.homedir(), '.pi', 'agent', 'codex-inbox-pool.json');
const DEFAULT_WORKSPACE_REGISTRY_PATH = path.join(process.cwd(), 'state', 'rotation', 'live-workspace-registry.json');
const CANONICAL_PRODUCTION_WORKSPACE_ID = 'd3d588b2-8a74-4acc-aa2e-94662ff0e025';

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function resolveWorkspaceInput(values = {}) {
  return values['workspace-id']
    ?? process.env.TARGET_WORKSPACE_ID
    ?? process.env.WORKSPACE_ID
    ?? CANONICAL_PRODUCTION_WORKSPACE_ID;
}

function loadWorkspaceContext({
  workspaceId,
  routerPath,
  authPath,
  poolPath,
  registryPath,
  controlPlanePath,
} = {}) {
  const routerData = readJson(routerPath, { aliases: [], pools: [] });
  const authData = readJson(authPath, {});
  const poolData = readJson(poolPath, { entries: [] });
  const registry = readJson(registryPath, { workspaces: [], ownerCandidates: [] });
  const controlPlane = loadAgentMailControlPlane(controlPlanePath);
  const workspaceOwnerEmail = process.env.WORKSPACE_OWNER_EMAIL || resolveWorkspaceOwnerEmail({
    authData,
    env: process.env,
    nowMs: Date.now(),
  });
  const canonicalParent = resolveCanonicalWorkspaceParent({
    controlPlane,
    routerData,
    poolData,
    registry,
    targetWorkspaceId: workspaceId,
    workspaceOwnerEmail,
  });
  return {
    routerData,
    authData,
    poolData,
    registry,
    controlPlane,
    workspaceOwnerEmail,
    canonicalParent,
  };
}

function parseCommand(argv = process.argv.slice(2)) {
  const [command = 'status', ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      'workspace-id': { type: 'string' },
      'control-plane-path': { type: 'string', default: DEFAULT_CONTROL_PLANE_PATH },
      'registry-path': { type: 'string', default: DEFAULT_WORKSPACE_REGISTRY_PATH },
      'router-path': { type: 'string', default: DEFAULT_ROUTER_PATH },
      'auth-path': { type: 'string', default: DEFAULT_AUTH_PATH },
      'pool-path': { type: 'string', default: DEFAULT_POOL_PATH },
      'api-key': { type: 'string' },
      'otp-code': { type: 'string' },
      'display-name': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  return { command, values };
}

async function main() {
  loadRepoEnv({ cwd: process.cwd() });

  const { command, values } = parseCommand();
  const workspaceId = resolveWorkspaceInput(values);
  const context = loadWorkspaceContext({
    workspaceId,
    routerPath: values['router-path'],
    authPath: values['auth-path'],
    poolPath: values['pool-path'],
    registryPath: values['registry-path'],
    controlPlanePath: values['control-plane-path'],
  });

  if (command === 'status') {
    console.log(JSON.stringify({
      ok: true,
      workspaceId,
      workspaceOwnerEmail: context.workspaceOwnerEmail,
      canonicalParent: context.canonicalParent,
      controlPlaneWorkspace: context.controlPlane.workspaces?.[workspaceId] ?? null,
    }, null, 2));
    return;
  }

  if (command === 'sign-up') {
    if (!context.canonicalParent) {
      throw new Error(`Unable to resolve canonical AgentMail parent for workspace ${workspaceId}`);
    }
    const result = await signUpWorkspaceParentOrganization({
      workspace: context.canonicalParent,
      controlPlanePath: values['control-plane-path'],
      controlPlane: context.controlPlane,
      fetchImpl: fetch,
      env: process.env,
      now: () => Date.now(),
    });
    console.log(JSON.stringify({
      ok: true,
      workspaceId,
      canonicalParent: context.canonicalParent,
      record: result.record,
      verifyCommand: result.verifyCommand,
      controlPlanePath: values['control-plane-path'],
    }, null, 2));
    return;
  }

  if (command === 'verify') {
    if (!values['api-key']) throw new Error('--api-key is required for verify');
    if (!values['otp-code']) throw new Error('--otp-code is required for verify');
    const result = await verifyWorkspaceParentOrganization({
      workspaceId,
      apiKey: values['api-key'],
      otpCode: values['otp-code'],
      controlPlanePath: values['control-plane-path'],
      controlPlane: context.controlPlane,
      fetchImpl: fetch,
    });
    console.log(JSON.stringify({
      ok: true,
      workspaceId,
      verification: result.verification,
      workspace: result.workspace,
      controlPlanePath: values['control-plane-path'],
    }, null, 2));
    return;
  }

  if (command === 'list-inboxes') {
    const result = await listWorkspaceInboxes({
      workspaceId,
      controlPlanePath: values['control-plane-path'],
      controlPlane: context.controlPlane,
      fetchImpl: fetch,
    });
    console.log(JSON.stringify({
      ok: true,
      workspaceId,
      organization: {
        organizationId: result.organization.organizationId,
        humanEmail: result.organization.humanEmail,
        verifyStatus: result.organization.verifyStatus,
      },
      inboxes: result.inboxes,
    }, null, 2));
    return;
  }

  if (command === 'create-inbox') {
    const result = await createWorkspaceInbox({
      workspaceId,
      displayName: values['display-name'] ?? 'Codex Control Plane Inbox',
      controlPlanePath: values['control-plane-path'],
      controlPlane: context.controlPlane,
      fetchImpl: fetch,
    });
    console.log(JSON.stringify({
      ok: true,
      workspaceId,
      organization: {
        organizationId: result.organization.organizationId,
        humanEmail: result.organization.humanEmail,
      },
      inbox: result.inbox,
    }, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`[pipeline-agentmail-control] ${error.message}`);
  process.exit(1);
});