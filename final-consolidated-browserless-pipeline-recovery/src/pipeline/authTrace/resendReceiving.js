import fs from 'node:fs';
import path from 'node:path';

const RESEND_RECEIVING_URL = 'https://api.resend.com/emails/receiving';
const DEFAULT_DOMAIN = 'epistemophile.store';
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_FETCH_ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseCreatedAt(value) {
  if (!value) return 0;
  const normalized = String(value)
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1')
    .replace(/([+-]\d{2})$/, '$1:00');
  return new Date(normalized).getTime();
}

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function parseEnvFile(raw) {
  const env = {};
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    env[trimmed.slice(0, index)] = trimmed.slice(index + 1).replace(/^['"]|['"]$/g, '');
  }
  return env;
}

function loadEnv({ cwd = process.cwd(), maxDepth = 6 } = {}) {
  let current = cwd;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = path.join(current, '.env');
    if (fs.existsSync(candidate)) return parseEnvFile(fs.readFileSync(candidate, 'utf8'));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return {};
}

function resolveApiKey(apiKey = null) {
  return apiKey ?? process.env.RESEND_API_KEY ?? loadEnv().RESEND_API_KEY ?? null;
}

function isTransientFetchError(error) {
  const code = String(error?.code ?? error?.cause?.code ?? '').toUpperCase();
  const message = String(error?.message ?? '');
  return code === 'ETIMEDOUT'
    || code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === 'EAI_AGAIN'
    || error?.name === 'AbortError'
    || error?.name === 'TimeoutError'
    || /fetch failed/i.test(message)
    || /\bETIMEDOUT\b/i.test(message);
}

async function fetchWithTransientRetry(url, options = {}, {
  fetchImpl = globalThis.fetch,
  attempts = DEFAULT_FETCH_ATTEMPTS,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    try {
      const timeoutSignal = typeof AbortSignal?.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined;
      return await fetchImpl(url, {
        ...options,
        ...(timeoutSignal ? { signal: timeoutSignal } : {}),
      });
    } catch (error) {
      if (attempt >= Math.max(1, attempts) || !isTransientFetchError(error)) {
        throw error;
      }
      await sleep(250 * attempt);
    }
  }
  throw new Error('unreachable fetch retry state');
}

function messageText(message = {}) {
  return [
    message.subject ?? '',
    message.text ?? '',
    message.html ?? '',
    message.headers ? JSON.stringify(message.headers) : '',
  ].join(' ');
}

export function isResendReceivingAddress(email, { domain = process.env.RESEND_RECEIVING_DOMAIN ?? DEFAULT_DOMAIN } = {}) {
  return normalizeEmail(email).endsWith(`@${normalizeEmail(domain)}`);
}

export function extractOtpFromResendEmail(message = {}) {
  const match = messageText(message).match(/\b(\d{6})\b/);
  return match ? match[1] : null;
}

export async function listResendReceivedEmails({
  apiKey,
  fetchImpl = globalThis.fetch,
  limit = 50,
} = {}) {
  const effectiveApiKey = resolveApiKey(apiKey);
  if (!effectiveApiKey) throw new Error('RESEND_API_KEY is required to list received emails');

  const response = await fetchWithTransientRetry(`${RESEND_RECEIVING_URL}?limit=${encodeURIComponent(limit)}`, {
    headers: { Authorization: `Bearer ${effectiveApiKey}` },
  }, { fetchImpl });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    throw new Error(`Resend received-email list failed: ${response.status}${text ? ` ${text.slice(0, 300)}` : ''}`);
  }

  return json?.data ?? [];
}

export async function getResendReceivedEmail({
  emailId,
  apiKey,
  fetchImpl = globalThis.fetch,
} = {}) {
  const effectiveApiKey = resolveApiKey(apiKey);
  if (!effectiveApiKey) throw new Error('RESEND_API_KEY is required to retrieve received email');
  if (!emailId) throw new Error('getResendReceivedEmail requires emailId');

  const response = await fetchWithTransientRetry(`${RESEND_RECEIVING_URL}/${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${effectiveApiKey}` },
  }, { fetchImpl });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    throw new Error(`Resend received-email retrieve failed: ${response.status}${text ? ` ${text.slice(0, 300)}` : ''}`);
  }

  return json;
}

export async function fetchLatestResendReceivedEmail({
  email,
  apiKey,
  fetchImpl = globalThis.fetch,
  sinceMs = 0,
  limit = 50,
  matcher = () => true,
} = {}) {
  const target = normalizeEmail(email);
  const messages = await listResendReceivedEmails({ apiKey, fetchImpl, limit });
  const candidates = messages
    .filter((message) => (message.to ?? []).some((to) => normalizeEmail(to) === target))
    .filter((message) => parseCreatedAt(message.created_at) >= sinceMs)
    .filter(matcher)
    .sort((left, right) => parseCreatedAt(right.created_at) - parseCreatedAt(left.created_at));

  for (const candidate of candidates) {
    const fullMessage = await getResendReceivedEmail({ emailId: candidate.id, apiKey, fetchImpl });
    if (matcher(fullMessage)) {
      return fullMessage;
    }
  }

  throw new Error(`No matching Resend received email found for ${email}`);
}

export async function pollResendReceivedOtp({
  email,
  apiKey,
  fetchImpl = globalThis.fetch,
  sinceMs = 0,
  pollIntervalMs = 1_000,
  timeoutMs = 120_000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const message = await fetchLatestResendReceivedEmail({
        email,
        apiKey,
        fetchImpl,
        sinceMs,
        limit: 100,
        matcher: (candidate) => {
          const subject = String(candidate.subject ?? '').toLowerCase();
          return subject.includes('verification code') || Boolean(extractOtpFromResendEmail(candidate));
        },
      });
      const otp = extractOtpFromResendEmail(message);
      if (otp) {
        return {
          otp,
          messageId: message.id,
          receivedAtMs: parseCreatedAt(message.created_at),
          subject: message.subject ?? '',
          raw: message,
        };
      }
      lastError = new Error(`Resend email ${message.id} did not contain a 6-digit OTP`);
    } catch (error) {
      lastError = error;
    }

    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }

  throw new Error(`Resend OTP poll timeout for ${email}: ${lastError?.message ?? 'no fresh OTP'}`);
}
