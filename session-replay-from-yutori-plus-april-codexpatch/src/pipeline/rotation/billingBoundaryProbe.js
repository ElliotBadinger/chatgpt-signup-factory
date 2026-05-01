import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createCookieJar,
  renderCookieHeader,
  snapshotCookies,
  updateCookieJarFromHeader,
} from '../authTrace/httpCookies.js';
import { ensureArtifactDir } from '../evidence/artifacts.js';

export const DEFAULT_TEAM_TRIAL_ENTRY_URL = 'https://chatgpt.com/team-sign-up?promo_campaign=team-1-month-free&utm_campaign=WEB-team-1-month-free&utm_internal_medium=referral&utm_internal_source=openai_business&referrer=https%3A%2F%2Fchatgpt.com%2F';
export const DEFAULT_BILLING_URL = 'https://chatgpt.com/admin/billing';
const SESSION_URL = 'https://chatgpt.com/api/auth/session';

function parseJsonSafe(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function normalizeString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function readSetCookieHeader(headers = null) {
  if (!headers) return null;
  if (typeof headers.getSetCookie === 'function') {
    const lines = headers.getSetCookie();
    if (Array.isArray(lines) && lines.length > 0) return lines.join(', ');
  }
  if (typeof headers.get === 'function') {
    return headers.get('set-cookie');
  }
  return null;
}

function headerValue(headers = null, name) {
  if (!headers || typeof headers.get !== 'function') return null;
  return headers.get(name);
}

function extractCheckoutFlags(text = '') {
  const knownFlags = [
    'enabled_custom_checkout_for_team',
    'is_checkout_redesign',
    'is_save_stripe_payment_info_enabled',
    'show_billing_address_after_payment_details',
    'should_show_manage_my_subscription_link',
  ];
  return knownFlags.filter((flag) => text.includes(flag));
}

function extractStripeCandidateUrls(text = '') {
  const matches = String(text ?? '').match(/https:\/\/[^"'()\s>]*stripe[^"'()\s>]*/gi) ?? [];
  return [...new Set(matches)];
}

function buildStep({
  url,
  status,
  ok,
  location = null,
  cfMitigated = null,
  body = '',
  json = null,
  contentType = null,
} = {}) {
  return {
    url,
    status,
    ok,
    location,
    cfMitigated,
    contentType,
    title: extractHtmlTitle(body),
    authStatus: extractAuthStatus(body),
    checkoutFlags: extractCheckoutFlags(body),
    stripeCandidateUrls: extractStripeCandidateUrls(body),
    bodySnippet: String(body ?? '').slice(0, 500),
    json,
  };
}

function extractHtmlTitle(html = '') {
  const match = String(html ?? '').match(/<title>([^<]+)<\/title>/i);
  return match ? match[1].trim() : null;
}

function extractAuthStatus(html = '') {
  const match = String(html ?? '').match(/"authStatus"\s*:\s*"([^"]+)"/i);
  return match ? match[1] : null;
}

function isCloudflareChallengeStep(step = null) {
  const body = String(step?.bodySnippet ?? '');
  return step?.cfMitigated === 'challenge'
    || (step?.status === 403 && /cf-mitigated/i.test(body))
    || (step?.status === 403 && /challenge-platform/i.test(body));
}

async function requestStep(url, {
  jar,
  fetchImpl = fetch,
  referer = 'https://chatgpt.com/',
} = {}) {
  const headers = {
    accept: '*/*',
    'accept-language': 'en-US,en',
    referer,
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  };
  const cookieHeader = renderCookieHeader(jar, url);
  if (cookieHeader) headers.cookie = cookieHeader;

  const response = await fetchImpl(url, {
    method: 'GET',
    headers,
    redirect: 'manual',
  });
  const setCookieHeader = readSetCookieHeader(response.headers);
  if (setCookieHeader) {
    updateCookieJarFromHeader(jar, setCookieHeader, url);
  }
  const text = typeof response.text === 'function' ? await response.text() : '';
  const json = parseJsonSafe(text, null);
  return buildStep({
    url,
    status: response.status,
    ok: response.ok,
    location: headerValue(response.headers, 'location'),
    cfMitigated: headerValue(response.headers, 'cf-mitigated'),
    body: text,
    json,
    contentType: headerValue(response.headers, 'content-type'),
  });
}

function classifyProbe({
  sessionStep,
  teamEntryStep,
  redirectedTeamStep,
  billingStep,
  expectedEmail = null,
  expectedWorkspaceId = null,
} = {}) {
  const session = sessionStep?.json ?? null;
  const observedEmail = normalizeString(session?.user?.email);
  const observedWorkspaceId = normalizeString(session?.account?.id);

  if (!sessionStep?.ok || !session?.accessToken) {
    return {
      status: 'blocked',
      blockerReason: 'auth-session-drift',
      reason: 'session-unavailable',
    };
  }
  if (expectedEmail && observedEmail && observedEmail.toLowerCase() !== expectedEmail.toLowerCase()) {
    return {
      status: 'blocked',
      blockerReason: 'auth-session-drift',
      reason: 'session-email-mismatch',
    };
  }
  if (expectedWorkspaceId && observedWorkspaceId && observedWorkspaceId !== expectedWorkspaceId) {
    return {
      status: 'blocked',
      blockerReason: 'workspace-drift',
      reason: 'session-workspace-mismatch',
    };
  }
  if (isCloudflareChallengeStep(teamEntryStep) || isCloudflareChallengeStep(redirectedTeamStep) || isCloudflareChallengeStep(billingStep)) {
    return {
      status: 'blocked',
      blockerReason: 'cloudflare-challenge-boundary',
      reason: 'billing-surface-challenged',
    };
  }
  if (!teamEntryStep?.ok && !teamEntryStep?.location) {
    return {
      status: 'blocked',
      blockerReason: 'route-api-mismatch',
      reason: 'team-sign-up-unreachable',
    };
  }
  if (billingStep?.ok && billingStep.checkoutFlags?.length > 0) {
    return {
      status: 'billing-boundary-reached',
      blockerReason: null,
      reason: 'openai-billing-shell-reached',
    };
  }
  if (billingStep?.ok) {
    return {
      status: 'probe-inconclusive',
      blockerReason: 'billing-surface-ambiguity',
      reason: 'billing-shell-missing-checkout-flags',
    };
  }
  return {
    status: 'blocked',
    blockerReason: 'route-api-mismatch',
    reason: 'billing-route-unreachable',
  };
}

export async function probeBillingBoundary({
  runtimeCookies = [],
  fetchImpl = fetch,
  entryUrl = DEFAULT_TEAM_TRIAL_ENTRY_URL,
  billingUrl = DEFAULT_BILLING_URL,
  expectedEmail = null,
  expectedWorkspaceId = null,
  freshIdentity = null,
} = {}) {
  const jar = createCookieJar(Array.isArray(runtimeCookies) ? runtimeCookies : []);
  const sessionStep = await requestStep(SESSION_URL, { jar, fetchImpl });
  const teamEntryStep = await requestStep(entryUrl, {
    jar,
    fetchImpl,
    referer: 'https://chatgpt.com/pricing',
  });
  const redirectedTeamUrl = teamEntryStep.location
    ? new URL(teamEntryStep.location, entryUrl).toString()
    : null;
  const redirectedTeamStep = redirectedTeamUrl
    ? await requestStep(redirectedTeamUrl, {
        jar,
        fetchImpl,
        referer: entryUrl,
      })
    : null;
  const billingStep = await requestStep(billingUrl, {
    jar,
    fetchImpl,
    referer: redirectedTeamUrl ?? entryUrl,
  });

  const classification = classifyProbe({
    sessionStep,
    teamEntryStep,
    redirectedTeamStep,
    billingStep,
    expectedEmail,
    expectedWorkspaceId,
  });
  const accountContext = sessionStep.json
    ? {
        accountId: sessionStep.json.account?.id ?? null,
        planType: sessionStep.json.account?.planType ?? null,
        structure: sessionStep.json.account?.structure ?? null,
        email: sessionStep.json.user?.email ?? null,
      }
    : null;
  const redirectChain = [teamEntryStep, redirectedTeamStep, billingStep].filter(Boolean).map((step) => ({
    url: step.url,
    status: step.status,
    location: step.location,
    authStatus: step.authStatus,
    checkoutFlags: step.checkoutFlags,
  }));
  const candidateStripeUrls = [
    ...(teamEntryStep?.stripeCandidateUrls ?? []),
    ...(redirectedTeamStep?.stripeCandidateUrls ?? []),
    ...(billingStep?.stripeCandidateUrls ?? []),
  ];

  return {
    ...classification,
    entryUrl,
    billingUrl,
    redirectedTeamUrl,
    session: accountContext,
    freshIdentity,
    redirectChain,
    checkoutFlags: [...new Set([
      ...(teamEntryStep?.checkoutFlags ?? []),
      ...(redirectedTeamStep?.checkoutFlags ?? []),
      ...(billingStep?.checkoutFlags ?? []),
    ])],
    candidateStripeUrls: [...new Set(candidateStripeUrls)],
    candidateBillingUrl: billingStep?.ok ? billingUrl : redirectedTeamUrl ?? billingUrl,
    candidatePromotionSignals: [
      {
        source: '/api/auth/session',
        accountId: accountContext?.accountId ?? null,
        planType: accountContext?.planType ?? null,
        structure: accountContext?.structure ?? null,
      },
    ],
    observedPages: {
      session: sessionStep,
      teamEntry: teamEntryStep,
      redirectedTeam: redirectedTeamStep,
      billing: billingStep,
    },
    runtimeCookieCount: snapshotCookies(jar).length,
  };
}

export async function writeBillingBoundaryProbeArtifact(artifactDir, probeResult) {
  await ensureArtifactDir(artifactDir);
  const probePath = path.join(artifactDir, 'billing-boundary-probe.json');
  await writeFile(probePath, `${JSON.stringify(probeResult, null, 2)}\n`, 'utf8');
  return probePath;
}

export function buildBillingBoundaryHandoff({
  probeResult,
  proofPaths = [],
  resumeCommand,
  statusCommand,
  nextCommand = null,
  target = null,
  inviter = null,
} = {}) {
  return {
    target: target ?? probeResult?.session?.email ?? 'billing-boundary-target',
    inviter: inviter ?? 'browserless-billing-probe',
    inviteLink: probeResult?.candidateBillingUrl ?? probeResult?.entryUrl ?? '',
    proofPaths,
    status: probeResult?.status ?? 'probe-inconclusive',
    resumeCommand,
    statusCommand,
    nextCommand,
    blocker: probeResult?.blockerReason
      ? `${probeResult.blockerReason}: ${probeResult.reason ?? 'unknown blocker'}`
      : null,
    details: {
      currentEntryUrl: probeResult?.entryUrl ?? null,
      billingUrl: probeResult?.candidateBillingUrl ?? null,
      stripeUrls: probeResult?.candidateStripeUrls ?? [],
      redirectChain: probeResult?.redirectChain ?? [],
      accountContext: probeResult?.session ?? null,
      freshIdentity: probeResult?.freshIdentity ?? null,
      candidatePromotionSignals: probeResult?.candidatePromotionSignals ?? [],
    },
  };
}