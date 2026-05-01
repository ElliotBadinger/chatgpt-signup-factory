import dns from 'node:dns/promises';

const DEFAULT_REQUIRED_HOSTS = [
  'chatgpt.com',
  'auth.openai.com',
  'api.resend.com',
];
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_FETCH_ATTEMPTS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function serializeError(error) {
  return {
    name: error?.name ?? null,
    message: error?.message ?? String(error),
    code: error?.code ?? error?.cause?.code ?? null,
    syscall: error?.syscall ?? error?.cause?.syscall ?? null,
    hostname: error?.hostname ?? error?.cause?.hostname ?? null,
  };
}

async function checkDns(hostname) {
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    return { ok: addresses.length > 0, hostname, addresses };
  } catch (error) {
    return { ok: false, hostname, error: serializeError(error) };
  }
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

async function checkFetch(url, {
  fetchImpl = fetch,
  attempts = DEFAULT_FETCH_ATTEMPTS,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    try {
      const timeoutSignal = typeof AbortSignal?.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined;
      const response = await fetchImpl(url, {
        method: 'HEAD',
        redirect: 'manual',
        ...(timeoutSignal ? { signal: timeoutSignal } : {}),
      });
      return { ok: true, url, status: response.status, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt >= Math.max(1, attempts) || !isTransientFetchError(error)) {
        break;
      }
      await sleep(500 * attempt);
    }
  }
  return { ok: false, url, error: serializeError(lastError), attempts: Math.max(1, attempts) };
}

export async function checkBrowserlessNetwork({
  hosts = DEFAULT_REQUIRED_HOSTS,
  urls = ['https://chatgpt.com/', 'https://api.resend.com/domains'],
  fetchImpl = fetch,
  fetchAttempts = DEFAULT_FETCH_ATTEMPTS,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  const dnsChecks = [];
  for (const hostname of hosts) {
    dnsChecks.push(await checkDns(hostname));
  }

  const fetchChecks = [];
  for (const url of urls) {
    fetchChecks.push(await checkFetch(url, { fetchImpl, attempts: fetchAttempts, timeoutMs: fetchTimeoutMs }));
  }

  const ok = dnsChecks.every((check) => check.ok) && fetchChecks.every((check) => check.ok);
  return {
    ok,
    dns: dnsChecks,
    fetch: fetchChecks,
  };
}

export function assertBrowserlessNetwork(preflight) {
  if (preflight?.ok) return;
  const dnsFailures = (preflight?.dns ?? [])
    .filter((check) => !check.ok)
    .map((check) => `${check.hostname}:${check.error?.code ?? check.error?.message ?? 'failed'}`);
  const fetchFailures = (preflight?.fetch ?? [])
    .filter((check) => !check.ok)
    .map((check) => `${check.url}:${check.error?.code ?? check.error?.message ?? 'failed'}`);
  throw new Error(`Browserless network preflight failed; dns=[${dnsFailures.join(', ')}] fetch=[${fetchFailures.join(', ')}]`);
}
