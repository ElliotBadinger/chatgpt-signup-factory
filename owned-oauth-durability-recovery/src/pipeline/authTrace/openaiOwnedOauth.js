import crypto from "node:crypto";

import { waitForInboundOtp } from "./agentMailOtp.js";
import {
  buildSignupPassword,
  defaultCompleteForgotPassword,
  defaultConsumeResetEmail,
  defaultInitiateForgotPassword,
} from "./openaiAuthReplay.js";
import {
  createCookieJar,
  renderCookieHeader,
  snapshotCookies,
  updateCookieJarFromHeader,
} from "./httpCookies.js";

const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_REDIRECT_URI = "http://localhost:1455/auth/callback";
const DEFAULT_ORIGINATOR = "codex_chatgpt_desktop";
const DEFAULT_SCOPE = "openid profile email offline_access";

function toDate(now) {
  return typeof now === "function" ? now() : new Date();
}

function serializeTimestamp(now) {
  return toDate(now).toISOString();
}

function parseJsonSafe(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function tryResolveUrl(value, baseUrl = undefined) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function getSetCookieHeader(headers) {
  if (typeof headers?.getSetCookie === "function") {
    const values = headers.getSetCookie();
    if (values.length > 0) return values;
  }
  return headers?.get?.("set-cookie") ?? null;
}

function finalizeHeaders(headers) {
  return {
    location: headers?.get?.("location") ?? null,
    "content-type": headers?.get?.("content-type") ?? null,
    "set-cookie": getSetCookieHeader(headers),
  };
}

function base64UrlSha256(input) {
  return crypto.createHash("sha256").update(input).digest("base64url");
}

function buildPkceVerifier() {
  return crypto.randomBytes(48).toString("base64url");
}

function decodeJwtPayload(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function buildTokenSummary(responseJson) {
  if (!responseJson) return null;
  return {
    hasAccessToken: Boolean(responseJson.access_token),
    hasRefreshToken: Boolean(responseJson.refresh_token),
    hasIdToken: Boolean(responseJson.id_token),
    tokenType: responseJson.token_type ?? null,
    error: responseJson.error ?? null,
    errorDescription: responseJson.error_description ?? null,
  };
}

function decodeSignedJsonCookie(cookieValue) {
  if (typeof cookieValue !== "string" || !cookieValue) return null;
  const [payloadSegment] = cookieValue.split(".");
  if (!payloadSegment) return null;

  const candidates = [
    payloadSegment,
    payloadSegment.replace(/-/g, "+").replace(/_/g, "/"),
  ];

  for (const candidate of candidates) {
    try {
      const padded = `${candidate}${"=".repeat((4 - (candidate.length % 4)) % 4)}`;
      return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

function findCookie(jar, name) {
  return snapshotCookies(jar).find((cookie) => cookie?.name === name) ?? null;
}

function authSessionIncludesWorkspace({ jar, workspaceId }) {
  if (!workspaceId) return false;
  const payload = decodeSignedJsonCookie(
    findCookie(jar, "oai-client-auth-session")?.value ?? null,
  );
  const workspaceIds = Array.isArray(payload?.workspaces)
    ? payload.workspaces.map((workspace) => workspace?.id).filter(Boolean)
    : [];
  return workspaceIds.includes(workspaceId);
}

function isExpectedRedirect(url, redirectUri) {
  const parsedUrl = tryResolveUrl(url);
  const parsedRedirectUri = tryResolveUrl(redirectUri);
  if (!parsedUrl || !parsedRedirectUri) return false;

  const resolvedUrl = new URL(parsedUrl);
  const resolvedRedirectUri = new URL(parsedRedirectUri);
  return (
    resolvedUrl.origin === resolvedRedirectUri.origin &&
    resolvedUrl.pathname === resolvedRedirectUri.pathname
  );
}

function resolveNavigationUrl(
  value,
  { baseUrl = null, redirectUri = null } = {},
) {
  const candidates = [
    tryResolveUrl(value),
    tryResolveUrl(value, baseUrl ?? undefined),
    tryResolveUrl(value, redirectUri ?? undefined),
  ].filter(Boolean);

  if (redirectUri) {
    const redirectMatch = candidates.find((candidate) =>
      isExpectedRedirect(candidate, redirectUri),
    );
    if (redirectMatch) return redirectMatch;
  }

  return candidates[0] ?? null;
}

function withResolvedContinueUrl(
  result,
  { baseUrl = null, redirectUri = null } = {},
) {
  if (!result) return result;
  const continueUrl = resolveNavigationUrl(
    result.continueUrl ??
      result.continue_url ??
      result.responseJson?.continue_url ??
      result.step?.responseJson?.continue_url ??
      null,
    { baseUrl, redirectUri },
  );
  if (!continueUrl) return result;
  return {
    ...result,
    continueUrl,
  };
}

function withResolvedResetUrl(
  result,
  { baseUrl = null, redirectUri = null } = {},
) {
  if (!result) return result;
  const resetUrl = resolveNavigationUrl(result.resetUrl ?? null, {
    baseUrl,
    redirectUri,
  });
  if (!resetUrl) return result;
  return {
    ...result,
    resetUrl,
  };
}

function prefixOwnedOauthStep(step) {
  if (!step) return step;
  return {
    ...step,
    name: step.name.startsWith("owned_oauth_")
      ? step.name
      : `owned_oauth_${step.name}`,
  };
}

function pushOwnedOauthSteps(steps, result) {
  if (Array.isArray(result?.steps)) {
    steps.push(...result.steps.map(prefixOwnedOauthStep));
    return;
  }
  if (result?.step) {
    steps.push(prefixOwnedOauthStep(result.step));
  }
}

function summarizeStepFailure(result) {
  const lastStep = Array.isArray(result?.steps)
    ? result.steps.at(-1)
    : (result?.step ?? null);
  const payload = lastStep?.responseJson ?? result?.responseJson ?? null;
  return {
    status: lastStep?.status ?? null,
    code:
      payload?.error?.message ??
      payload?.error ??
      payload?.type ??
      payload?.message ??
      null,
  };
}

function createOwnedOauthError(
  message,
  { blockerReason = null, blockerDetail = null, replay = null } = {},
) {
  const error = new Error(message);
  if (blockerReason) error.blockerReason = blockerReason;
  if (blockerDetail != null) error.blockerDetail = blockerDetail;
  if (replay) error.replay = replay;
  return error;
}

function isLoginOrResetEntry(url) {
  const resolved = tryResolveUrl(url);
  if (!resolved) return false;
  const pathname = new URL(resolved).pathname;
  return pathname.includes("/log-in") || pathname.includes("/reset-password");
}

/**
 * Extracts the `login_challenge` query parameter from a Hydra OIDC login challenge URL
 * (`/api/accounts/login?login_challenge=<opaque_token>`).  Returns null for any other URL.
 *
 * The server issues these challenge URLs when an OAuth authorize flow encounters an existing
 * session.  Presenting a valid `unified_session_manifest` cookie via POST to this endpoint
 * (the "SSO continuation" path) lets the server issue an authorization code without requiring
 * the caller to re-authenticate through the password-reset OTP dance.
 */
function extractLoginChallenge(url) {
  const resolved = tryResolveUrl(url);
  if (!resolved) return null;
  const parsedUrl = new URL(resolved);
  if (!parsedUrl.hostname.endsWith("openai.com")) return null;
  if (parsedUrl.pathname !== "/api/accounts/login") return null;
  return parsedUrl.searchParams.get("login_challenge") ?? null;
}

function extractReplayFallbackUrl(replay, { redirectUri = null } = {}) {
  if (!replay) return null;
  const steps = Array.isArray(replay?.steps) ? replay.steps : [];
  const candidates = [
    steps.find((step) => step?.name === "load_password_login")?.url ?? null,
    steps.find((step) => step?.name === "authorize_with_login_hint")
      ?.responseHeaders?.location ?? null,
    ...steps.flatMap((step) => [
      step?.responseHeaders?.location ?? null,
      step?.url ?? null,
    ]),
  ];

  for (const candidate of candidates) {
    const resolved = resolveNavigationUrl(candidate, { redirectUri });
    if (resolved && isLoginOrResetEntry(resolved)) return resolved;
  }

  return null;
}

function buildResetStageFailureMessage(stage, email, failure) {
  return (
    `Owned OAuth ${stage} failed for ${email ?? "unknown email"}: ` +
    `${failure.status ?? "unknown"} ${failure.code ?? "unknown_error"}`
  );
}

async function followOwnedOauthContinuationToCallback({
  jar,
  startUrl,
  fetchImpl,
  now,
  redirectUri,
  steps,
}) {
  let currentUrl = resolveNavigationUrl(startUrl, { redirectUri });
  let referer = "https://auth.openai.com/";

  for (
    let redirectCount = 0;
    currentUrl && redirectCount < 10;
    redirectCount += 1
  ) {
    if (isExpectedRedirect(currentUrl, redirectUri)) {
      return currentUrl;
    }

    const continuationStep = await performRequest({
      jar,
      url: currentUrl,
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        referer,
      },
      fetchImpl,
      now,
      stepName: `owned_oauth_post_reset_redirect_${redirectCount}`,
    });
    steps.push(continuationStep.step);

    const location = resolveNavigationUrl(
      continuationStep.response.headers.get("location") ??
        continuationStep.responseJson?.continue_url ??
        null,
      {
        baseUrl: currentUrl,
        redirectUri,
      },
    );
    if (!location) return null;

    referer = currentUrl;
    currentUrl = location;
  }

  return isExpectedRedirect(currentUrl, redirectUri) ? currentUrl : null;
}

async function provideOtp({
  email,
  sinceMs,
  otpProvider,
  agentMailApiKey,
  fetchImpl,
}) {
  if (typeof otpProvider === "function") {
    return otpProvider({ email, sinceMs });
  }
  if (!agentMailApiKey) {
    throw new Error(
      `Owned OAuth OTP requires agentMailApiKey or otpProvider for ${email ?? "unknown email"}`,
    );
  }
  return waitForInboundOtp({
    inboxId: email,
    apiKey: agentMailApiKey,
    sinceMs,
    fetchImpl,
  });
}

async function performRequest({
  jar,
  url,
  method = "GET",
  headers = {},
  body = null,
  fetchImpl,
  now,
  stepName,
  summarizeJson = null,
  redactRequestBody = false,
  redactResponseBody = false,
}) {
  const mergedHeaders = {
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    "accept-language": "en-US,en;q=0.9",
    ...headers,
  };
  const cookieHeader = renderCookieHeader(jar, url);
  if (cookieHeader) mergedHeaders.cookie = cookieHeader;

  const startedAt = Date.now();
  const response = await fetchImpl(url, {
    method,
    headers: mergedHeaders,
    body,
    redirect: "manual",
  });
  const text = await response.text();
  updateCookieJarFromHeader(jar, getSetCookieHeader(response.headers), url);
  const responseJson = parseJsonSafe(text, null);

  return {
    response,
    responseJson,
    step: {
      name: stepName,
      url,
      method,
      requestedAt: serializeTimestamp(now),
      elapsedMs: Date.now() - startedAt,
      status: response.status,
      requestHeaders: mergedHeaders,
      requestBody: redactRequestBody ? "[redacted]" : body,
      responseHeaders: finalizeHeaders(response.headers),
      responseJson: summarizeJson ? summarizeJson(responseJson) : responseJson,
      responseTextPreview: redactResponseBody
        ? "[redacted oauth token response]"
        : text.slice(0, 400),
    },
  };
}

export function buildOwnedOauthAuthorizeUrl({
  state,
  codeChallenge,
  loginHint = null,
  clientId = DEFAULT_CLIENT_ID,
  redirectUri = DEFAULT_REDIRECT_URI,
  originator = DEFAULT_ORIGINATOR,
  scope = DEFAULT_SCOPE,
} = {}) {
  const url = new URL("https://auth.openai.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", originator);
  // login_hint tells the server which email to associate with the login challenge.
  // Without it the server creates a challenge with no email context, which causes
  // passwordless/send-otp to return 409 because it cannot determine who to OTP.
  if (loginHint) {
    url.searchParams.set("login_hint", loginHint);
  }
  return url.toString();
}

export async function acquireOwnedOpenAiOauth({
  cookies = [],
  email = null,
  workspaceId = null,
  session = null,
  replay = null,
  otpProvider = null,
  agentMailApiKey = null,
  fetchImpl = fetch,
  now = () => new Date(),
  state = crypto.randomBytes(16).toString("base64url"),
  codeVerifier = buildPkceVerifier(),
  clientId = DEFAULT_CLIENT_ID,
  redirectUri = DEFAULT_REDIRECT_URI,
  originator = DEFAULT_ORIGINATOR,
  scope = DEFAULT_SCOPE,
} = {}) {
  let jar = createCookieJar(Array.isArray(cookies) ? cookies : []);
  const steps = [];
  const sessionAlreadyTargetsWorkspace =
    workspaceId && String(session?.account?.id ?? "") === String(workspaceId);

  if (
    workspaceId &&
    !sessionAlreadyTargetsWorkspace &&
    !authSessionIncludesWorkspace({ jar, workspaceId })
  ) {
    const workspaceSelect = await performRequest({
      jar,
      url: "https://auth.openai.com/api/accounts/workspace/select",
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: "https://auth.openai.com",
        referer: "https://auth.openai.com/workspace",
      },
      body: JSON.stringify({ workspace_id: workspaceId }),
      fetchImpl,
      now,
      stepName: "owned_oauth_workspace_select",
    });
    steps.push(workspaceSelect.step);
    if (workspaceSelect.response.status >= 400) {
      throw new Error(
        `Owned OAuth workspace select failed for ${email ?? "unknown email"}: ` +
          `${workspaceSelect.response.status} ${workspaceSelect.responseJson?.error ?? workspaceSelect.responseJson?.type ?? "unknown_error"}`,
      );
    }
  }
  const preAuthorizeCookies = snapshotCookies(jar);

  const authorizeUrl = buildOwnedOauthAuthorizeUrl({
    state,
    codeChallenge: base64UrlSha256(codeVerifier),
    loginHint: email ?? undefined,
    clientId,
    redirectUri,
    originator,
    scope,
  });
  let callbackUrl = null;
  let currentAuthorizeUrl = authorizeUrl;
  let lastVisitedAuthorizeUrl = currentAuthorizeUrl;
  let usedResetFallback = false;
  for (let redirectCount = 0; redirectCount < 10; redirectCount += 1) {
    const authorizeStep = await performRequest({
      jar,
      url: currentAuthorizeUrl,
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        referer: "https://chatgpt.com/",
      },
      fetchImpl,
      now,
      stepName:
        redirectCount === 0
          ? "owned_oauth_authorize"
          : `owned_oauth_authorize_redirect_${redirectCount}`,
    });
    steps.push(authorizeStep.step);
    lastVisitedAuthorizeUrl = currentAuthorizeUrl;

    const location = resolveNavigationUrl(
      authorizeStep.response.headers.get("location"),
      {
        baseUrl: currentAuthorizeUrl,
        redirectUri,
      },
    );
    if (!location) break;
    if (isExpectedRedirect(location, redirectUri)) {
      callbackUrl = location;
      break;
    }

    // When the authorize chain redirects to a Hydra OIDC login challenge URL, attempt the
    // SSO session-continuation path before falling back to the GET-based redirect chain.
    //
    // The correct continuation is a POST to /api/accounts/login with the challenge token and
    // the existing `unified_session_manifest` / `oai-client-auth-session` cookies.  Those
    // cookies survive the email-OTP validate step that clears `login_session`, so this path
    // works even after a passwordless OTP login has completed.
    //
    // If the server does not return a redirect (e.g. 409 "Invalid session") the challenge
    // POST is treated as a no-op and the loop continues with a normal GET to the challenge
    // URL, which eventually falls through to the password-reset-OTP fallback below.
    const loginChallenge = extractLoginChallenge(location);
    if (loginChallenge) {
      const hydraChallengeStep = await performRequest({
        jar,
        url: "https://auth.openai.com/api/accounts/login",
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          origin: "https://auth.openai.com",
          referer: "https://auth.openai.com/log-in",
        },
        body: JSON.stringify({ login_challenge: loginChallenge }),
        fetchImpl,
        now,
        stepName: "owned_oauth_hydra_login_challenge",
      });
      steps.push(hydraChallengeStep.step);

      const hydraLocation = resolveNavigationUrl(
        hydraChallengeStep.response.headers.get("location") ?? null,
        { baseUrl: "https://auth.openai.com/", redirectUri },
      );

      if (
        hydraChallengeStep.response.status >= 300 &&
        hydraChallengeStep.response.status < 400 &&
        hydraLocation
      ) {
        if (isExpectedRedirect(hydraLocation, redirectUri)) {
          // Server accepted the session manifest and issued the auth code directly.
          callbackUrl = hydraLocation;
          break;
        }
        // Server redirected to an intermediate step (e.g. Hydra consent page).
        // Follow the remaining redirects to reach the callback.
        callbackUrl = await followOwnedOauthContinuationToCallback({
          jar,
          startUrl: hydraLocation,
          fetchImpl,
          now,
          redirectUri,
          steps,
        });
        break;
      }
      // Hydra POST did not return a redirect — the server did not recognise the session
      // (e.g. unified_session_manifest absent or stale).  Fall through so the loop
      // performs the normal GET to the challenge URL, which redirects to /log-in and
      // eventually enables the password-reset-OTP fallback path.
    }

    currentAuthorizeUrl = location;
  }

  const fallbackEntryUrl = isLoginOrResetEntry(lastVisitedAuthorizeUrl)
    ? lastVisitedAuthorizeUrl
    : extractReplayFallbackUrl(replay, { redirectUri });

  if (!callbackUrl && fallbackEntryUrl) {
    // ── Passwordless OTP path (primary) ──────────────────────────────────────
    // POST /api/accounts/passwordless/send-otp does NOT require a live
    // login_session cookie — it triggers a fresh email-OTP authentication
    // directly against the active unified_session_manifest.  When the OTP is
    // validated via email-otp/validate the Hydra login-challenge bound to the
    // current jar is resolved and the server returns a continue_url that leads
    // back to the Codex OAuth callback, giving us an authorization code without
    // ever touching the reset-password state machine.
    //
    // IMPORTANT: the passwordless path uses the CURRENT jar (not preAuthorizeCookies)
    // because the authorize redirect chain sets a hydra_redirect cookie that encodes
    // the Codex OAuth session context.  The passwordless/send-otp endpoint needs this
    // cookie to associate the OTP with the correct OAuth challenge.  The jar reset to
    // preAuthorizeCookies only happens for the password-reset fallback path below,
    // which needs the original oai-client-auth-session (without the authorize-loop
    // overwrite) but does not require hydra_redirect.
    const passwordlessOtpSinceMs = toDate(now).getTime();
    const passwordlessSendOtpResult = await performRequest({
      jar,
      url: "https://auth.openai.com/api/accounts/passwordless/send-otp",
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: "https://auth.openai.com",
        referer: fallbackEntryUrl,
      },
      fetchImpl,
      now,
      stepName: "owned_oauth_passwordless_send_otp",
    });
    steps.push(passwordlessSendOtpResult.step);

    if (
      passwordlessSendOtpResult.response.status >= 200 &&
      passwordlessSendOtpResult.response.status < 300
    ) {
      const passwordlessEmailVerificationUrl = resolveNavigationUrl(
        passwordlessSendOtpResult.responseJson?.continue_url ??
          "https://auth.openai.com/email-verification",
        { baseUrl: "https://auth.openai.com/", redirectUri },
      );

      const passwordlessEmailVerificationPage = await performRequest({
        jar,
        url: passwordlessEmailVerificationUrl,
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          referer: fallbackEntryUrl,
        },
        fetchImpl,
        now,
        stepName: "owned_oauth_load_passwordless_email_verification",
      });
      steps.push(passwordlessEmailVerificationPage.step);

      const passwordlessOtpResult = await provideOtp({
        email,
        sinceMs: passwordlessOtpSinceMs,
        otpProvider,
        agentMailApiKey,
        fetchImpl,
      });
      const passwordlessOtpCode =
        passwordlessOtpResult?.otp ?? passwordlessOtpResult?.code ?? null;

      if (!passwordlessOtpCode) {
        throw createOwnedOauthError(
          `Owned OAuth passwordless OTP missing for ${email ?? "unknown email"}`,
          {
            blockerReason: "passwordless-otp-missing",
            blockerDetail: "otp-provider-returned-no-code",
            replay,
          },
        );
      }

      const passwordlessValidateResult = await performRequest({
        jar,
        url: "https://auth.openai.com/api/accounts/email-otp/validate",
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          origin: "https://auth.openai.com",
          referer: passwordlessEmailVerificationUrl,
        },
        body: JSON.stringify({ code: passwordlessOtpCode }),
        fetchImpl,
        now,
        stepName: "owned_oauth_passwordless_otp_validate",
      });
      steps.push(passwordlessValidateResult.step);

      if (passwordlessValidateResult.response.status < 400) {
        const passwordlessContinueUrl = resolveNavigationUrl(
          passwordlessValidateResult.responseJson?.continue_url ?? null,
          { baseUrl: "https://auth.openai.com/", redirectUri },
        );

        if (passwordlessContinueUrl) {
          if (isExpectedRedirect(passwordlessContinueUrl, redirectUri)) {
            callbackUrl = passwordlessContinueUrl;
          } else {
            callbackUrl = await followOwnedOauthContinuationToCallback({
              jar,
              startUrl: passwordlessContinueUrl,
              fetchImpl,
              now,
              redirectUri,
              steps,
            });
          }
        }
      }
    }

    // ── Password-reset OTP path (fallback) ───────────────────────────────────
    // Only entered when the passwordless path was not available or did not
    // produce a callback URL.  Requires a live login_session cookie — used in
    // scenarios where the OAuth chain was entered before any prior login step
    // had a chance to clear it (e.g. replay fallback that re-navigates to
    // /log-in/password and restores login_session).
    if (!callbackUrl) {
      usedResetFallback = true;
      // Reset the jar to the pre-authorize snapshot so the password-reset path
      // starts from a clean session (restoring oai-client-auth-session without
      // any overwrites introduced by the authorize redirect chain).
      jar = createCookieJar(preAuthorizeCookies);
      const initiateForgotPasswordResult = await defaultInitiateForgotPassword({
        redirectLocation: fallbackEntryUrl,
        jar,
        fetchImpl,
        now,
      });
      const initiateForgotPassword = withResolvedContinueUrl(
        initiateForgotPasswordResult,
        {
          baseUrl:
            initiateForgotPasswordResult?.resetUrl ?? lastVisitedAuthorizeUrl,
          redirectUri,
        },
      );
      pushOwnedOauthSteps(steps, initiateForgotPassword);
      const initiateFailure = summarizeStepFailure(initiateForgotPassword);
      if ((initiateFailure.status ?? 0) >= 400) {
        throw createOwnedOauthError(
          buildResetStageFailureMessage(
            "password reset send-otp",
            email,
            initiateFailure,
          ),
          {
            blockerReason: "password-reset-initiation-failed",
            blockerDetail:
              `${initiateFailure.status ?? "unknown"} ${initiateFailure.code ?? "unknown_error"}`.trim(),
            replay,
          },
        );
      }

      const consumeResetEmailResult = await defaultConsumeResetEmail({
        email,
        initiateResult: initiateForgotPassword,
        jar,
        fetchImpl,
        now,
        otpProvider,
        poolPath: null,
        agentMailApiKey,
      });
      const consumeResetEmail = withResolvedResetUrl(consumeResetEmailResult, {
        baseUrl:
          initiateForgotPassword?.continueUrl ??
          initiateForgotPassword?.resetUrl ??
          lastVisitedAuthorizeUrl,
        redirectUri,
      });
      pushOwnedOauthSteps(steps, consumeResetEmail);
      const consumeFailure = summarizeStepFailure(consumeResetEmail);
      if ((consumeFailure.status ?? 0) >= 400) {
        throw createOwnedOauthError(
          buildResetStageFailureMessage(
            "password reset email verification",
            email,
            consumeFailure,
          ),
          {
            blockerReason: "password-reset-email-consumption-failed",
            blockerDetail:
              `${consumeFailure.status ?? "unknown"} ${consumeFailure.code ?? "unknown_error"}`.trim(),
            replay,
          },
        );
      }

      const completeForgotPasswordResult = await defaultCompleteForgotPassword({
        resetUrl: consumeResetEmail?.resetUrl ?? null,
        newPassword: buildSignupPassword(email),
        jar,
        fetchImpl,
        now,
        sentinelProvider: null,
      });
      const completeForgotPassword = withResolvedContinueUrl(
        completeForgotPasswordResult,
        {
          baseUrl:
            consumeResetEmail?.resetUrl ??
            initiateForgotPassword?.resetUrl ??
            lastVisitedAuthorizeUrl,
          redirectUri,
        },
      );
      pushOwnedOauthSteps(steps, completeForgotPassword);
      const completeFailure = summarizeStepFailure(completeForgotPassword);
      if ((completeFailure.status ?? 0) >= 400) {
        throw createOwnedOauthError(
          buildResetStageFailureMessage(
            "password reset completion",
            email,
            completeFailure,
          ),
          {
            blockerReason: "password-reset-completion-failed",
            blockerDetail:
              `${completeFailure.status ?? "unknown"} ${completeFailure.code ?? "unknown_error"}`.trim(),
            replay,
          },
        );
      }

      const continuationUrl = resolveNavigationUrl(
        completeForgotPassword?.continueUrl ?? null,
        {
          baseUrl:
            consumeResetEmail?.resetUrl ??
            initiateForgotPassword?.resetUrl ??
            lastVisitedAuthorizeUrl,
          redirectUri,
        },
      );
      if (!continuationUrl) {
        throw createOwnedOauthError(
          `Owned OAuth password reset continuation failed for ${email ?? "unknown email"}: forgot-password-continue-url-missing`,
          {
            blockerReason: "password-reset-continuation-missing",
            blockerDetail: "forgot-password-continue-url-missing",
            replay,
          },
        );
      }

      callbackUrl = await followOwnedOauthContinuationToCallback({
        jar,
        startUrl: continuationUrl,
        fetchImpl,
        now,
        redirectUri,
        steps,
      });
    } // end password-reset fallback
  }

  if (usedResetFallback && !isExpectedRedirect(callbackUrl, redirectUri)) {
    throw createOwnedOauthError(
      `Owned OAuth password reset continuation failed for ${email ?? "unknown email"}: callback-missing`,
      {
        blockerReason: "password-reset-continuation-missing",
        blockerDetail: callbackUrl ?? "callback-missing",
        replay,
      },
    );
  }

  if (!isExpectedRedirect(callbackUrl, redirectUri)) {
    throw new Error(
      `Owned OAuth authorize did not return callback for ${email ?? "unknown email"}: ${callbackUrl ?? "missing location"}`,
    );
  }

  const parsedCallback = new URL(callbackUrl);
  if (parsedCallback.searchParams.get("state") !== state) {
    throw new Error(
      `Owned OAuth state mismatch for ${email ?? "unknown email"}`,
    );
  }
  const code = parsedCallback.searchParams.get("code");
  if (!code) {
    throw new Error(
      `Owned OAuth callback code missing for ${email ?? "unknown email"}`,
    );
  }

  const tokenExchange = await performRequest({
    jar,
    url: "https://auth.openai.com/oauth/token",
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://auth.openai.com",
      referer: "https://auth.openai.com/",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }).toString(),
    fetchImpl,
    now,
    stepName: "owned_oauth_token_exchange",
    summarizeJson: buildTokenSummary,
    redactRequestBody: false,
    redactResponseBody: true,
  });
  steps.push(tokenExchange.step);

  const accessToken = tokenExchange.responseJson?.access_token ?? null;
  const refreshToken = tokenExchange.responseJson?.refresh_token ?? null;
  if (!accessToken || !refreshToken) {
    throw new Error(
      `Owned OAuth token exchange failed for ${email ?? "unknown email"}` +
        `: ${tokenExchange.responseJson?.error ?? tokenExchange.response.status}`,
    );
  }

  const payload = decodeJwtPayload(accessToken);
  const authClaims = payload?.["https://api.openai.com/auth"] ?? {};
  const profileClaims = payload?.["https://api.openai.com/profile"] ?? {};
  const accountId = authClaims.chatgpt_account_id ?? null;
  if (workspaceId && accountId !== workspaceId) {
    throw new Error(
      `Owned OAuth workspace mismatch for ${email ?? "unknown email"}: ` +
        `expected ${workspaceId}, got ${accountId ?? "none"}`,
    );
  }

  return {
    accessToken,
    refreshToken,
    idToken: tokenExchange.responseJson?.id_token ?? null,
    expiresAt: Number.isFinite(tokenExchange.responseJson?.expires_in)
      ? toDate(now).getTime() +
        Number(tokenExchange.responseJson.expires_in) * 1000
      : null,
    accountId,
    planType: authClaims.chatgpt_plan_type ?? null,
    identityEmail: profileClaims.email ?? null,
    emailVerified: profileClaims.email_verified === true,
    steps,
    finalCookies: { cookies: snapshotCookies(jar) },
  };
}
