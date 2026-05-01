import os from 'node:os';
import path from 'node:path';

import { acquireOwnedOpenAiOauth } from '../authTrace/openaiOwnedOauth.js';
import { onboardBrowserlessWorkspaceMember } from './browserlessMemberOnboarder.js';
import { emailToAliasId, registerNewMember } from './piAccountRegistrar.js';
import { assertDurableAuth, verifyPiRouterOnboarding } from './routerVerification.js';

const DEFAULT_POOL = 'openai-codex';
const DEFAULT_MODEL = 'gpt-5.4';

export async function onboardBrowserlessInboxToPiRouter({
  email,
  apiKey,
  authJsonPath = path.join(os.homedir(), '.pi', 'agent', 'auth.json'),
  routerJsonPath = path.join(os.homedir(), '.pi', 'agent', 'account-router.json'),
  poolName = DEFAULT_POOL,
  modelId = DEFAULT_MODEL,
  fetchImpl = fetch,
  browserlessOnboardMember = onboardBrowserlessWorkspaceMember,
  inviteMember = null,
  ownerClient = null,
  selectedWorkspace = null,
  placementContext = null,
  authTraceDir = null,
  acquireOwnedOAuth = acquireOwnedOpenAiOauth,
  log = () => {},
}) {
  const aliasId = emailToAliasId(email);

  log(`[routerOnboarder] Starting browserless onboarding for ${email}`);
  const onboarded = await browserlessOnboardMember({
    email,
    agentMailApiKey: apiKey,
    inviteMember,
    ownerClient,
    selectedWorkspace,
    placementContext,
    authTraceDir: authTraceDir ?? undefined,
    fetchImpl,
    acquireOwnedOAuth,
  });

  const auth = {
    accessToken: onboarded.accessToken,
    refreshToken: onboarded.refreshToken ?? onboarded.ownedOAuth?.refreshToken ?? null,
    expiresAt: onboarded.expiresAt,
    accountId: onboarded.accountId ?? onboarded.workspaceId ?? onboarded.personalAccountId ?? null,
    identityEmail: onboarded.identityEmail,
  };
  assertDurableAuth({ email, auth, source: 'browserless onboarding' });

  log(`[routerOnboarder] Registering ${email} as ${aliasId}`);
  registerNewMember({
    email,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    expiresAt: auth.expiresAt,
    accountId: auth.accountId,
    poolName,
    modelId,
    authJsonPath,
    routerJsonPath,
    log,
  });

  const verification = verifyPiRouterOnboarding({
    aliasId,
    email,
    authJsonPath,
    routerJsonPath,
    poolName,
  });
  if (!verification.pass) {
    throw new Error(`Router verification failed for ${email}`);
  }

  return { aliasId, email, auth, verification, onboarded };
}
