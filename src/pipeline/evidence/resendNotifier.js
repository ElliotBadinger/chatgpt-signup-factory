import fs from 'node:fs';
import path from 'node:path';

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'onboarding@epistemophile.store';

function parseEnvFile(raw) {
  const env = {};
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
  return env;
}

export function loadResendEnv({ cwd = process.cwd(), maxDepth = 6 } = {}) {
  let current = cwd;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = path.join(current, '.env');
    if (fs.existsSync(candidate)) {
      return {
        path: candidate,
        values: parseEnvFile(fs.readFileSync(candidate, 'utf8')),
      };
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return { path: null, values: {} };
}

function resolveResendSetting(explicit, envKey, fallback) {
  if (explicit != null && explicit !== '') return explicit;
  return process.env[envKey] ?? loadResendEnv().values[envKey] ?? fallback;
}

function resendEnvValues() {
  return {
    ...loadResendEnv().values,
    ...process.env,
  };
}

export function shouldSendResendHandoff(resend = null) {
  if (resend?.enabled === true) return true;
  if (resend?.enabled === false) return false;

  const env = resendEnvValues();
  return Boolean(
    env.RESEND_API_KEY
      && (env.RESEND_HANDOFF_TO || env.RESEND_TO_EMAIL)
      && env.RESEND_HANDOFF_ENABLED !== 'false',
  );
}

function normalizeRecipients(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? '').trim()).filter(Boolean);
  }

  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function markdownToHtml(markdown) {
  return `<pre style="white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(markdown)}</pre>`;
}

export function redactResendApiKey(apiKey) {
  const value = String(apiKey ?? '');
  if (!value) return null;
  if (value.length <= 10) return `${value.slice(0, 3)}...`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function buildResendEmailPayload({
  from,
  to,
  subject = 'Pipeline handoff',
  text,
  html,
} = {}) {
  const resolvedFrom = resolveResendSetting(from, 'RESEND_FROM_EMAIL', DEFAULT_FROM);
  const resolvedTo = to
    ?? resolveResendSetting(null, 'RESEND_HANDOFF_TO')
    ?? resolveResendSetting(null, 'RESEND_TO_EMAIL');
  const recipients = normalizeRecipients(resolvedTo);
  if (recipients.length === 0) {
    throw new Error('Resend recipient missing: set RESEND_HANDOFF_TO or pass --resend-to');
  }

  const bodyText = String(text ?? '').trim();
  const bodyHtml = html ?? markdownToHtml(bodyText);
  if (!bodyText && !bodyHtml) {
    throw new Error('Resend message body is empty');
  }

  return {
    from: resolvedFrom,
    to: recipients,
    subject,
    text: bodyText,
    html: bodyHtml,
  };
}

export async function sendResendEmail({
  apiKey,
  fetchImpl = globalThis.fetch,
  endpoint = RESEND_EMAILS_URL,
  ...payloadOptions
} = {}) {
  const resolvedApiKey = resolveResendSetting(apiKey, 'RESEND_API_KEY');
  if (!resolvedApiKey) {
    throw new Error('RESEND_API_KEY is required to send handoff email');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required to send handoff email');
  }

  const payload = buildResendEmailPayload(payloadOptions);
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resolvedApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let responseJson = null;
  try {
    responseJson = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseJson = null;
  }

  if (!response.ok) {
    const message = responseJson?.message ?? responseText.slice(0, 500) ?? 'unknown error';
    const error = new Error(`Resend email failed with status ${response.status}: ${message}`);
    error.status = response.status;
    error.details = responseJson ?? responseText;
    throw error;
  }

  return {
    status: 'sent',
    provider: 'resend',
    id: responseJson?.id ?? null,
    to: payload.to,
    from: payload.from,
    subject: payload.subject,
    apiKey: redactResendApiKey(resolvedApiKey),
  };
}

export async function sendHandoffViaResend(handoffMarkdown, options = {}) {
  return sendResendEmail({
    ...options,
    subject: options.subject ?? 'Pipeline handoff ready',
    text: handoffMarkdown,
    html: options.html ?? markdownToHtml(handoffMarkdown),
  });
}
