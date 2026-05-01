import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

import {
  buildFillEmailScript,
  handlePostSubmitStateScript,
} from './chatGptAccountCreator.js';
import { waitForInboundOtp } from '../authTrace/agentMailOtp.js';
import { acquireOwnedOpenAiOauth as acquireOwnedOpenAiOauthImpl } from '../authTrace/openaiOwnedOauth.js';
import { emailToAliasId, registerAlias } from './piAccountRegistrar.js';
import { recoverBrowserlessIdentity as recoverBrowserlessIdentityImpl } from '../authTrace/recoverBrowserlessIdentity.js';
import { onboardBrowserlessWorkspaceMember } from './browserlessMemberOnboarder.js';
import { markInboxInUse } from './inboxPoolManager.js';
import { createRuntimeVerifiedAliasProbe } from './runtimeAliasProbe.js';
import { createLifecycleReconciler } from './lifecycleReconciler.js';
import { createCodexLbLifecycleStore, resolveExistingCodexLbStorePath } from './codexLbLifecycleStore.js';
import { createConfiguredCodexLbStore } from './codexLbLocalImportClient.js';
import { buildBillingBoundaryHandoff, writeBillingBoundaryProbeArtifact } from './billingBoundaryProbe.js';
import { writeHandoffBundle as defaultWriteHandoffBundle } from '../evidence/handoff.js';

const DEFAULT_POOL = 'openai-codex';
const DEFAULT_MODEL = 'gpt-5.4';
const DEFAULT_CHROME = process.env.LOCAL_CHROME_BIN ?? process.env.CHROME_BIN ?? resolveChromePath();
const DEFAULT_AUTH_JSON_PATH = path.join(os.homedir(), '.pi', 'agent', 'auth.json');
const DEFAULT_ROUTER_JSON_PATH = path.join(os.homedir(), '.pi', 'agent', 'account-router.json');
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';
const EMAIL_INPUT_SELECTOR = '#email-input, input[type="email"], input[name="email"], input[autocomplete="email"], input[placeholder*="email" i]';
const OTP_ENTRY_SELECTOR = 'input[maxlength="1"], input[inputmode="numeric"], input[autocomplete="one-time-code"], input[name*="code"], input[placeholder*="code"]';


export function extractRouterAuthFromSession(session, expectedEmail) {
  const accessToken = String(session?.accessToken ?? '').trim();
  if (!accessToken) throw new Error('Session missing accessToken');

  const identityEmail = String(session?.user?.email ?? '').trim();
  if (!identityEmail) throw new Error('Session missing user.email');
  if (expectedEmail && identityEmail.toLowerCase() !== String(expectedEmail).toLowerCase()) {
    throw new Error(`Session email mismatch: expected ${expectedEmail}, got ${identityEmail}`);
  }

  return {
    accessToken,
    refreshToken: getRefreshToken(session),
    expiresAt: session?.expires ? new Date(session.expires).getTime() : null,
    accountId: session?.account?.id ?? null,
    identityEmail,
  };
}

function getRefreshToken(value) {
  if (typeof value?.refreshToken === 'string') return value.refreshToken;
  if (typeof value?.refresh_token === 'string') return value.refresh_token;
  return null;
}

function getSessionFromReplay(replay) {
  if (replay?.session?.accessToken) return replay.session;
  return replay?.steps?.find((step) => step.name === 'chatgpt_session')?.responseJson ?? null;
}

function assertRefreshBearingRouterAuth({ email, auth, source = 'router onboarding' }) {
  const refreshToken = String(getRefreshToken(auth) ?? '').trim();
  if (!refreshToken) {
    throw new Error(`${source} for ${email} is missing refresh token; refusing to register degraded auth`);
  }
}

export function verifyPiRouterOnboarding({
  aliasId,
  email,
  authJsonPath,
  routerJsonPath,
  poolName = DEFAULT_POOL,
  expectedWorkspaceId = null,
  requireWorkspacePlan = false,
}) {
  const auth = JSON.parse(fs.readFileSync(authJsonPath, 'utf8'));
  const router = JSON.parse(fs.readFileSync(routerJsonPath, 'utf8'));
  const checks = {};
  const details = {};

  checks.aliasInAuth = Boolean(auth[aliasId]);
  checks.noTempAliases = !Object.keys(auth).some((k) => k.toLowerCase().includes('openai-codex-tmp'));
  checks.authHasAccessToken = typeof auth[aliasId]?.access === 'string' && auth[aliasId].access.trim().length > 0;
  checks.authHasDurableRefresh = typeof auth[aliasId]?.refresh === 'string' && auth[aliasId].refresh.trim().length > 0;

  const alias = (router.aliases ?? []).find((a) => a.id === aliasId);
  checks.aliasInRouter = Boolean(alias);
  checks.aliasEmailMatches = String(alias?.email ?? '') === email;
  checks.aliasCloneFromCodex = String(alias?.cloneFrom ?? '') === 'openai-codex';
  checks.aliasWorkspaceMatchesExpected = !expectedWorkspaceId || String(alias?.workspaceId ?? '') === String(expectedWorkspaceId);

  const pool = (router.pools ?? []).find((p) => p.name === poolName) ?? { providers: [], routes: [] };
  checks.aliasInPoolProviders = (pool.providers ?? []).includes(aliasId);
  const route = (pool.routes ?? []).find((r) => r.provider === aliasId);
  checks.aliasHasPoolRoute = Boolean(route);

  const payload = decodeJwtPayload(auth[aliasId]?.access ?? '');
  const authAccountId = auth[aliasId]?.accountId ?? null;
  const planType = payload?.['https://api.openai.com/auth']?.chatgpt_plan_type ?? null;
  const jwtEmail = payload?.['https://api.openai.com/profile']?.email ?? null;
  const jwtVerified = payload?.['https://api.openai.com/profile']?.email_verified === true;
  checks.jwtIdentityEmailMatches = jwtEmail === email;
  checks.jwtEmailVerified = jwtVerified;
  checks.authAccountMatchesExpectedWorkspace = !expectedWorkspaceId || authAccountId === expectedWorkspaceId;
  checks.jwtHasWorkspacePlan = !requireWorkspacePlan || (planType !== 'free' && planType !== 'guest' && planType != null);

  details.aliasEmail = alias?.email ?? null;
  details.aliasCloneFrom = alias?.cloneFrom ?? null;
  details.aliasWorkspaceId = alias?.workspaceId ?? null;
  details.aliasPlacementContext = alias?.placementContext ?? null;
  details.routeModel = route?.model ?? null;
  details.identityEmail = jwtEmail;
  details.identitySource = payload ? 'auth-jwt' : 'unknown';
  details.identityEmailVerified = jwtVerified;
  details.metadataMismatch = jwtEmail === email ? 'no' : 'yes';
  details.planType = planType;
  details.authAccountId = authAccountId;
  details.hasDurableRefresh = checks.authHasDurableRefresh;
  details.expectedWorkspaceId = expectedWorkspaceId;

  return { pass: Object.values(checks).every(Boolean), aliasId, email, poolName, checks, details };
}

function buildRouterLifecycleFinalize({
  routerJsonPath,
  poolName,
  modelId,
} = {}) {
  return async ({
    finalId,
    email,
    baseProviderId = 'openai-codex',
    placementContext = null,
  } = {}) => {
    registerAlias({
      aliasId: finalId,
      email,
      label: finalId,
      poolName,
      modelId,
      baseProviderId,
      routerJsonPath,
      placementContext,
    });
    return { ok: true, validation: 'ok' };
  };
}

function buildRuntimeVerificationError({ email, verification = null, fallbackError = null } = {}) {
  const probeReason = verification?.failureDetails?.liveCodexProbe?.probeReason
    ?? verification?.codexProbe?.reason
    ?? verification?.codexProbe?.blockerReason
    ?? fallbackError
    ?? 'unknown reason';
  return new Error(`Runtime verification failed for ${email}: ${probeReason}`);
}

function shouldAutoAttachCodexLbStore({
  authJsonPath,
  routerJsonPath,
  codexLbStorePath,
} = {}) {
  if (codexLbStorePath !== undefined) return true;
  return path.resolve(authJsonPath) === path.resolve(DEFAULT_AUTH_JSON_PATH)
    && path.resolve(routerJsonPath) === path.resolve(DEFAULT_ROUTER_JSON_PATH);
}

function getExpectedWorkspaceId({ placementContext = null, workspaceId = null } = {}) {
  return placementContext?.workspaceId ?? workspaceId ?? null;
}

function buildPersistedPlacementContext({
  placementContext = null,
  workspaceId = null,
} = {}) {
  if (placementContext || workspaceId) {
    return {
      ...(placementContext ?? {}),
      ...(workspaceId ? { workspaceId } : {}),
    };
  }
  return null;
}

function getPlanTypeFromAccessToken(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  return payload?.['https://api.openai.com/auth']?.chatgpt_plan_type ?? null;
}

export function assertWorkspaceScopedOnboardingAuth({
  email,
  auth,
  placementContext = null,
  workspaceId = null,
}) {
  const expectedWorkspaceId = getExpectedWorkspaceId({ placementContext, workspaceId });
  if (!expectedWorkspaceId) return;

  const accountId = auth?.accountId ?? null;
  const planType = getPlanTypeFromAccessToken(auth?.accessToken ?? null);

  if (accountId !== expectedWorkspaceId) {
    throw new Error(`Workspace onboarding for ${email} stayed on account ${accountId ?? 'missing'}; expected workspace ${expectedWorkspaceId}`);
  }
  if (planType === 'free' || planType === 'guest' || planType == null) {
    throw new Error(`Workspace onboarding for ${email} returned non-workspace plan ${planType ?? 'missing'} for workspace ${expectedWorkspaceId}`);
  }
}

export async function createStealthBrowserSession() {
  puppeteerExtra.use(StealthPlugin());
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-onboard-'));
  const hasDisplay = Boolean(process.env.DISPLAY);
  const browser = await puppeteerExtra.launch({
    executablePath: DEFAULT_CHROME,
    headless: !hasDisplay,
    userDataDir: profileDir,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-features=IsolateOrigins,site-per-process',
      '--lang=en-US,en',
      '--window-size=1280,1024',
      `--user-agent=${USER_AGENT}`,
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const pages = await browser.pages();
  const page = pages[0] ?? await browser.newPage();
  await applyStealthPatches(page);
  return {
    page,
    browser,
    cleanup: async () => {
      try { await browser.close(); } catch {}
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
    },
  };
}

export async function prepareChatGptOtpLogin({ email, createBrowserSession = createStealthBrowserSession }) {
  const session = await createBrowserSession();
  const { page } = session;

  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  await sleep(3_000);
  await page.goto('https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  await sleep(3_000);

  const loginBtn = await page.waitForSelector('::-p-text(Log in), [data-testid="login-button"], [data-testid="signup-button"]', { timeout: 8_000 }).catch(() => null);
  if (loginBtn) {
    const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null);
    await loginBtn.click().catch(() => {});
    await navPromise;
    await sleep(2_000);
  }

  await page.waitForSelector(EMAIL_INPUT_SELECTOR, { timeout: 15_000 });
  const otpRequestedAt = Date.now();
  const fillRes = await page.evaluate(buildFillEmailScript(), email);
  await page.waitForSelector(OTP_ENTRY_SELECTOR + ', input[type="password"]', { timeout: 20_000 }).catch(() => {});

  let state = { state: 'loading', url: page.url() };
  for (let i = 0; i < 8; i++) {
    state = await page.evaluate(handlePostSubmitStateScript);
    if (state.state !== 'loading') break;
    await sleep(1_500);
  }

  if (state.state === 'attempting-email-code') {
    await sleep(4_000);
  }

  return {
    ...session,
    otpRequestedAt,
    fillRes,
    state,
  };
}

export async function completeChatGptOtpLogin({ email, otp, page, cleanup, fillRes = null, state = null }) {
  try {
    let filled = false;
    for (let i = 0; i < 12; i++) {
      filled = await fillOtpInputs(page, otp);
      if (filled) break;
      await sleep(1_500);
    }
    if (!filled) {
      throw new Error(`OTP inputs not found for ${email} at ${page.url()}`);
    }

    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await sleep(8_000);

    const session = await page.evaluate(async () => {
      const response = await fetch('/api/auth/session', { credentials: 'include' });
      return await response.json();
    });

    return {
      finalUrl: page.url(),
      title: await page.title().catch(() => null),
      fillRes,
      state,
      session,
    };
  } finally {
    await cleanup?.().catch(() => {});
  }
}

export async function onboardInboxToPiRouter({
  email,
  apiKey,
  authJsonPath = DEFAULT_AUTH_JSON_PATH,
  routerJsonPath = DEFAULT_ROUTER_JSON_PATH,
  poolPath = null,
  poolInboxAddress = null,
  poolName = DEFAULT_POOL,
  modelId = DEFAULT_MODEL,
  fetchImpl = fetch,
  createBrowserSession = createStealthBrowserSession,
  prepareLogin = prepareChatGptOtpLogin,
  completeLogin = completeChatGptOtpLogin,
  browserlessOnboardMember = onboardBrowserlessWorkspaceMember,
  recoverBrowserlessIdentity = recoverBrowserlessIdentityImpl,
  acquireOwnedOAuth = acquireOwnedOpenAiOauthImpl,
  inviteMember = null,
  ownerClient = null,
  placementContext = null,
  authTraceDir = null,
  legacyBrowserFlow = false,
  waitForInboundOtp: waitForInboundOtpImpl = waitForInboundOtp,
  markInboxInUseImpl = markInboxInUse,
  probeVerifiedAlias = null,
  codexLbStore = null,
  codexLbStorePath = undefined,
  billingBoundaryProbe = null,
  billingBoundaryArtifactDir = null,
  writeHandoffBundleImpl = defaultWriteHandoffBundle,
  billingBoundaryResumeCommand = 'echo "billing-boundary resume not configured"',
  billingBoundaryStatusCommand = 'echo "billing-boundary status not configured"',
  log = () => {},
}) {
  const aliasId = emailToAliasId(email);
  const tempAliasId = `${aliasId}_router_onboard_pending`;
  const poolEntryInboxAddress = poolInboxAddress ?? email;
  const reconcilePoolEntry = ({
    accountId,
    placementContext: authoritativePlacementContext = null,
    workspaceId = null,
  } = {}) => {
    if (!poolPath) return;
    const updated = markInboxInUseImpl(poolEntryInboxAddress, {
      linkedAliasId: aliasId,
      chatGptAccountId: accountId ?? null,
      placementContext: authoritativePlacementContext,
      ...(workspaceId != null ? { workspaceId } : {}),
      poolPath,
    });
    if (!updated) {
      throw new Error(`Pool reconciliation failed for ${email}: no matching inbox entry for ${poolEntryInboxAddress}`);
    }
  };
  const runtimeAliasProbe = probeVerifiedAlias ?? createRuntimeVerifiedAliasProbe({
    authJsonPath,
    routerPath: routerJsonPath,
  });
  const resolvedCodexLbStore = codexLbStore ?? (() => {
    const configuredImportStore = createConfiguredCodexLbStore({ storePath: codexLbStorePath });
    if (configuredImportStore) {
      return configuredImportStore;
    }
    if (!shouldAutoAttachCodexLbStore({ authJsonPath, routerJsonPath, codexLbStorePath })) {
      return null;
    }
    const existingStorePath = resolveExistingCodexLbStorePath(codexLbStorePath);
    return existingStorePath
      ? createCodexLbLifecycleStore({ storePath: existingStorePath })
      : null;
  })();
  const finalizePersistedOnboarding = async ({
    accountId,
    auth,
    onboarded = null,
    placementContext: persistedPlacementContext = null,
    result,
  }) => {
    const expectedWorkspaceId = getExpectedWorkspaceId({
      placementContext: persistedPlacementContext,
      workspaceId: onboarded?.workspaceId ?? accountId ?? null,
    });
    const lifecycleReconciler = createLifecycleReconciler({
      authPath: authJsonPath,
      routerPath: routerJsonPath,
      archivePath: path.join(path.dirname(routerJsonPath), '.router-onboard-lifecycle-archive.json'),
      finalize: buildRouterLifecycleFinalize({
        routerJsonPath,
        poolName,
        modelId,
      }),
      verifyRecoveredAliasImpl: async ({ probeCodex } = {}) => {
        const verification = verifyPiRouterOnboarding({
          aliasId,
          email,
          authJsonPath,
          routerJsonPath,
          poolName,
          expectedWorkspaceId,
          requireWorkspacePlan: Boolean(expectedWorkspaceId),
        });
        let runtimeVerification = { ok: true, skipped: true, reason: 'verification-probe-not-required' };
        if (typeof probeCodex === 'function') {
          try {
            runtimeVerification = await probeCodex();
          } catch (error) {
            runtimeVerification = {
              ok: false,
              blockerReason: 'live-codex-probe-failed',
              reason: String(error?.message ?? error),
            };
          }
        }
        const failures = [];
        if (!verification.pass) failures.push('router-verification-failed');
        if (runtimeVerification?.ok === false) failures.push('live-codex-probe-failed');
        return {
          ok: failures.length === 0,
          reason: failures[0] ?? 'verified',
          failures,
          routerVerification: verification,
          codexProbe: runtimeVerification,
        };
      },
      probeVerifiedAlias: async ({ aliasId: probeAliasId }) => runtimeAliasProbe({ aliasId: probeAliasId }),
      codexLbStore: resolvedCodexLbStore,
      log,
    });

    const reconcileResult = await lifecycleReconciler.reconcileAppendOnlyOnboarding({
      inbox: { inboxAddress: email },
      auth: {
        access: auth.accessToken,
        refresh: auth.refreshToken,
        expires: auth.expiresAt,
        accountId,
      },
      newAliasId: aliasId,
      tempAliasId,
      onboarded,
      placementContext: persistedPlacementContext,
    });

    if (!reconcileResult?.ok) {
      if (reconcileResult?.verification?.routerVerification?.pass === false) {
        throw new Error(`Router verification failed for ${email}`);
      }
      const liveProbeFailed = reconcileResult?.verification?.failures?.includes('live-codex-probe-failed')
        || reconcileResult?.verification?.reason === 'live-codex-probe-failed';
      if (liveProbeFailed) {
        throw buildRuntimeVerificationError({
          email,
          verification: reconcileResult.verification,
          fallbackError: reconcileResult.error,
        });
      }
      throw new Error(String(reconcileResult?.error ?? 'append-only lifecycle reconcile failed'));
    }

    try {
      reconcilePoolEntry({
        accountId,
        placementContext: persistedPlacementContext,
        workspaceId: persistedPlacementContext?.workspaceId ?? onboarded?.workspaceId ?? accountId ?? null,
      });
    } catch (error) {
      const rollback = await lifecycleReconciler.rollbackAppendOnlyOnboarding({
        tempAliasId,
        finalAliasId: aliasId,
        email,
        rollbackReason: `pool-reconciliation: ${String(error?.message ?? error)}`,
      });
      if (rollback?.ok === false) {
        throw new Error(rollback.rollbackResidue ?? rollback.rollbackReason ?? String(error?.message ?? error));
      }
      throw error;
    }

    return {
      ...result,
      verification: reconcileResult.verification?.routerVerification ?? result.verification,
      runtimeVerification: reconcileResult.verification?.codexProbe ?? null,
    };
  };
  const handleBillingBoundaryProbe = async ({
    auth,
    onboarded,
    placementContext: probePlacementContext = null,
  } = {}) => {
    if (typeof billingBoundaryProbe !== 'function') {
      return { proceedToPersistence: true, probeResult: null };
    }
    const probeResult = await billingBoundaryProbe({
      aliasId,
      email,
      auth,
      onboarded,
      placementContext: probePlacementContext,
    });
    if (!probeResult || probeResult.status === 'promotable') {
      return { proceedToPersistence: true, probeResult };
    }
    if (probeResult.status === 'billing-boundary-reached') {
      let proofPaths = [];
      if (billingBoundaryArtifactDir && typeof writeHandoffBundleImpl === 'function') {
        const probePath = await writeBillingBoundaryProbeArtifact(billingBoundaryArtifactDir, probeResult);
        proofPaths = [probePath];
        await writeHandoffBundleImpl(billingBoundaryArtifactDir, buildBillingBoundaryHandoff({
          probeResult,
          proofPaths,
          resumeCommand: billingBoundaryResumeCommand,
          statusCommand: billingBoundaryStatusCommand,
          target: email,
          inviter: probePlacementContext?.ownerEmail ?? probePlacementContext?.ownerAliasId ?? 'browserless-billing-probe',
        }));
      }
      return {
        proceedToPersistence: false,
        probeResult,
        result: {
          status: 'billing-boundary-reached',
          aliasId,
          email,
          auth,
          onboarded,
          placementContext: probePlacementContext,
          artifactDir: billingBoundaryArtifactDir,
          proofPaths,
          billingBoundary: probeResult,
        },
      };
    }
    return {
      proceedToPersistence: false,
      probeResult,
      result: {
        status: probeResult.status ?? 'blocked',
        aliasId,
        email,
        auth,
        onboarded,
        placementContext: probePlacementContext,
        billingBoundary: probeResult,
        blockerReason: probeResult.blockerReason ?? null,
        reason: probeResult.reason ?? null,
      },
    };
  };

  if (!legacyBrowserFlow && prepareLogin === prepareChatGptOtpLogin && completeLogin === completeChatGptOtpLogin) {
    try {
      log(`[routerOnboarder] Starting browserless onboarding for ${email}`);
      const onboarded = await browserlessOnboardMember({
        email,
        agentMailApiKey: apiKey,
        inviteMember,
        ownerClient,
        placementContext,
        authTraceDir: authTraceDir ?? undefined,
        fetchImpl,
        log,
      });

      const auth = {
        accessToken: onboarded.accessToken,
        refreshToken: getRefreshToken(onboarded),
        expiresAt: onboarded.expiresAt,
        accountId: onboarded.accountId ?? onboarded.workspaceId ?? onboarded.personalAccountId ?? null,
        identityEmail: onboarded.identityEmail,
      };
      assertWorkspaceScopedOnboardingAuth({
        email,
        auth,
        placementContext,
        workspaceId: onboarded.workspaceId ?? null,
      });
      assertRefreshBearingRouterAuth({
        email,
        auth,
        source: 'browserless onboarding',
      });
      const persistedPlacementContext = buildPersistedPlacementContext({
        placementContext,
        workspaceId: onboarded.workspaceId ?? null,
      });
      const probeGate = await handleBillingBoundaryProbe({
        auth,
        onboarded,
        placementContext: persistedPlacementContext,
      });
      if (!probeGate.proceedToPersistence) {
        return probeGate.result;
      }

      const persistedResult = await finalizePersistedOnboarding({
        accountId: auth.accountId,
        auth,
        onboarded,
        placementContext: persistedPlacementContext,
        result: { aliasId, email, auth, onboarded, placementContext: persistedPlacementContext },
      });
      return probeGate.probeResult
        ? { ...persistedResult, billingBoundary: probeGate.probeResult }
        : persistedResult;
    } catch (error) {
      const message = String(error?.message ?? error);
      const shouldAttemptBrowserlessRecovery = message.includes('NO_EMAIL_CODE_OPTION');
      if (!shouldAttemptBrowserlessRecovery || typeof recoverBrowserlessIdentity !== 'function') {
        throw error;
      }

      log(`[routerOnboarder] Browserless onboarding hit password-only auth for ${email}; attempting browserless recovery`);
      const recovery = await recoverBrowserlessIdentity({
        email,
        agentMailApiKey: apiKey,
        authTraceDir: authTraceDir ?? undefined,
        inviteMember,
        ownerClient,
        placementContext,
        fetchImpl,
        failure: error,
      });
      if (recovery?.status !== 'recovered' || !recovery.auth?.accessToken) {
        throw new Error(`Browserless recovery failed for ${email}: ${recovery?.reason ?? recovery?.status ?? 'unknown error'}`);
      }
      const recoveredWorkspaceId = placementContext?.workspaceId ?? recovery.workspaceId ?? null;
      if (!recoveredWorkspaceId) {
        throw new Error(`Browserless recovery for ${email} is missing workspace evidence; refusing to register recovered auth`);
      }

      const auth = {
        accessToken: recovery.auth.accessToken,
        refreshToken: getRefreshToken(recovery.auth),
        expiresAt: recovery.auth.expiresAt,
        accountId: recovery.auth.accountId ?? null,
        identityEmail: recovery.auth.identityEmail ?? email,
      };
      let recoveryOwnedOAuth = null;
      if (!auth.refreshToken && typeof acquireOwnedOAuth === 'function') {
        const recoverySession = getSessionFromReplay(recovery.replay);
        const recoveryCookies = recovery.replay?.finalCookies?.cookies ?? [];
        if (recoverySession?.accessToken && recoveryCookies.length > 0) {
          log(`[routerOnboarder] Upgrading recovered session for ${email} to owned OAuth`);
          recoveryOwnedOAuth = await acquireOwnedOAuth({
            email,
            workspaceId: recoveredWorkspaceId,
            replay: recovery.replay,
            session: recoverySession,
            cookies: recoveryCookies,
            agentMailApiKey: apiKey,
            fetchImpl,
          });
          auth.accessToken = recoveryOwnedOAuth.accessToken;
          auth.refreshToken = getRefreshToken(recoveryOwnedOAuth);
          auth.expiresAt = recoveryOwnedOAuth.expiresAt ?? auth.expiresAt;
          auth.accountId = recoveryOwnedOAuth.accountId ?? auth.accountId;
          auth.identityEmail = recoveryOwnedOAuth.identityEmail ?? auth.identityEmail;
        }
      }
      assertWorkspaceScopedOnboardingAuth({
        email,
        auth,
        placementContext,
        workspaceId: recoveredWorkspaceId,
      });
      assertRefreshBearingRouterAuth({
        email,
        auth,
        source: 'browserless recovery',
      });
      const persistedPlacementContext = buildPersistedPlacementContext({
        placementContext,
        workspaceId: recoveredWorkspaceId,
      });
      const recoveredOnboarded = { workspaceId: recoveredWorkspaceId };
      const probeGate = await handleBillingBoundaryProbe({
        auth,
        onboarded: recoveredOnboarded,
        placementContext: persistedPlacementContext,
      });
      if (!probeGate.proceedToPersistence) {
        return probeGate.result;
      }

      const persistedResult = await finalizePersistedOnboarding({
        accountId: auth.accountId,
        auth,
        onboarded: recoveredOnboarded,
        placementContext: persistedPlacementContext,
        result: {
          aliasId,
          email,
          auth,
          recovery,
          ownedOAuth: recoveryOwnedOAuth,
          placementContext: persistedPlacementContext,
        },
      });
      return probeGate.probeResult
        ? { ...persistedResult, billingBoundary: probeGate.probeResult }
        : persistedResult;
    }
  }

  log(`[routerOnboarder] Preparing browser login for ${email}`);
  const prepared = await prepareLogin({ email, createBrowserSession });

  log(`[routerOnboarder] Fetching OTP for ${email}`);
  let otp;
  try {
    otp = await waitForInboundOtpImpl({
      inboxId: email,
      apiKey,
      fetchImpl,
      sinceMs: Math.max(0, Number(prepared.otpRequestedAt ?? 0) - 5_000),
    });
  } catch (error) {
    await prepared.cleanup?.().catch(() => {});
    throw error;
  }

  log(`[routerOnboarder] Completing browser session for ${email}`);
  const capture = await completeLogin({
    email,
    otp: otp.otp,
    page: prepared.page,
    cleanup: prepared.cleanup,
    fillRes: prepared.fillRes,
    state: prepared.state,
  });

  const auth = extractRouterAuthFromSession(capture.session, email);
  assertWorkspaceScopedOnboardingAuth({
    email,
    auth,
    placementContext,
  });
  assertRefreshBearingRouterAuth({
    email,
    auth,
    source: 'browser onboarding',
  });

  const persistedPlacementContext = buildPersistedPlacementContext({
    placementContext,
    workspaceId: placementContext?.workspaceId ?? null,
  });
  return await finalizePersistedOnboarding({
    accountId: auth.accountId,
    auth,
    onboarded: { workspaceId: placementContext?.workspaceId ?? auth.accountId ?? null },
    placementContext: persistedPlacementContext,
    result: { aliasId, email, otp, capture, auth, placementContext: persistedPlacementContext },
  });
}

async function applyStealthPatches(page) {
  try { await page.setUserAgent(USER_AGENT); } catch {}
  try { await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en' }); } catch {}
  try {
    await page.evaluateOnNewDocument(() => {
      try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
      try { Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' }); } catch {}
      try { window.chrome = window.chrome || { runtime: {} }; } catch {}
    });
  } catch {}
}

async function fillOtpInputs(page, otp) {
  const cells = await page.$$('input[maxlength="1"], input[inputmode="numeric"]');
  if (cells.length >= 6) {
    for (let i = 0; i < 6; i++) {
      await cells[i].click().catch(() => {});
      await cells[i].type(String(otp[i] ?? ''), { delay: 20 }).catch(() => {});
    }
    return true;
  }
  const single = await page.$('input[autocomplete="one-time-code"], input[name*="code"], input[placeholder*="code"]');
  if (single) {
    await single.click().catch(() => {});
    await single.type(String(otp), { delay: 20 }).catch(() => {});
    return true;
  }
  return false;
}

function resolveChromePath() {
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? '/usr/bin/google-chrome';
}

function decodeJwtPayload(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
