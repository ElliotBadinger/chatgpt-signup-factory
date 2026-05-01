import { createAgentMailInboundTransport } from './agentMailInboundTransport.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isTransientFetchError(error) {
  const code = String(error?.code ?? error?.cause?.code ?? '').toUpperCase();
  const message = String(error?.message ?? '');
  return code === 'ETIMEDOUT'
    || code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === 'EAI_AGAIN'
    || error?.name === 'AbortError'
    || /fetch failed/i.test(message)
    || /\bETIMEDOUT\b/i.test(message);
}

async function requestJson(url, { fetchImpl = fetch, headers = {} } = {}) {
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const timeoutSignal = typeof AbortSignal?.timeout === 'function'
        ? AbortSignal.timeout(30_000)
        : undefined;
      const res = await fetchImpl(url, {
        headers,
        ...(timeoutSignal ? { signal: timeoutSignal } : {}),
      });
      if (!res.ok) {
        throw new Error(`HTTP_${res.status}`);
      }
      return await res.json();
    } catch (error) {
      if (String(error?.message ?? '').startsWith('HTTP_')) {
        throw error;
      }
      if (attempts >= maxAttempts || !isTransientFetchError(error)) {
        throw error;
      }
      await sleep(250 * attempts);
    }
  }
}

function extractOtpFromMessageFields(message = {}) {
  const text = [
    message.subject ?? '',
    message.preview ?? '',
    message.text ?? '',
    message.body ?? '',
    message.extracted_text ?? '',
    message.html ?? '',
  ].join(' ');
  const match = text.match(/(\d{6})/);
  return match ? match[1] : null;
}

function toReceivedAtMs(value) {
  if (!value) {
    return null;
  }
  const receivedAtMs = new Date(value).getTime();
  return Number.isFinite(receivedAtMs) ? receivedAtMs : null;
}

function normalizeListedMessages(data = {}) {
  const rawMessages = Array.isArray(data?.messages)
    ? data.messages
    : (Array.isArray(data?.items) ? data.items : []);

  return rawMessages.map((message) => ({
    messageId: message?.message_id ?? message?.messageId ?? message?.id ?? null,
    timestamp: message?.timestamp ?? message?.receivedAt ?? message?.received_at ?? null,
    subject: message?.subject ?? '',
    preview: message?.preview ?? '',
    raw: message,
  }));
}

function normalizeInboundOtpCandidate(event = {}) {
  const message = event.message ?? {};
  const content = event.content ?? {};
  const normalizedMessage = {
    subject: message.subject ?? '',
    preview: message.preview ?? '',
    text: content.text ?? message.text ?? '',
    body: content.preferredBody ?? message.body ?? message.html ?? message.text ?? '',
    extracted_text: message.extracted_text ?? '',
    html: content.html ?? message.html ?? '',
  };
  const otp = extractOtpFromMessageFields(normalizedMessage);
  if (!otp) {
    return null;
  }

  const receivedAt = event.receivedAt ?? message.timestamp ?? message.receivedAt ?? message.received_at ?? null;
  return {
    inboxId: event.inboxId ?? message.inboxId ?? message.inbox_id ?? null,
    messageId: event.messageId ?? message.messageId ?? message.message_id ?? null,
    timestamp: receivedAt,
    receivedAtMs: toReceivedAtMs(receivedAt),
    subject: normalizedMessage.subject,
    preview: normalizedMessage.preview,
    otp,
    raw: event.raw ?? event,
    fullMessage: message,
    event,
  };
}

async function fetchInboxMessage({ inboxId, messageId, apiKey, fetchImpl = fetch }) {
  try {
    return await requestJson(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      fetchImpl,
    });
  } catch (error) {
    if (String(error?.message ?? '').startsWith('HTTP_')) {
      const status = String(error.message).replace('HTTP_', '');
      throw new Error(`AgentMail message fetch failed for ${inboxId}/${messageId}: ${status}`);
    }
    throw error;
  }
}

export async function fetchLatestInboxOtp({ inboxId, apiKey, limit = 10, sinceMs = 0, sinceGraceMs = 5_000, fetchImpl = fetch }) {
  let data;
  try {
    data = await requestJson(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages?limit=${limit}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      fetchImpl,
    });
  } catch (error) {
    if (String(error?.message ?? '').startsWith('HTTP_')) {
      const status = String(error.message).replace('HTTP_', '');
      throw new Error(`AgentMail list failed for ${inboxId}: ${status}`);
    }
    throw error;
  }

  const freshMessages = normalizeListedMessages(data)
    .map((message) => ({
      ...message,
      receivedAtMs: toReceivedAtMs(message.timestamp) ?? 0,
    }))
    .filter((m) => m.receivedAtMs >= Math.max(0, sinceMs - sinceGraceMs))
    .sort((a, b) => b.receivedAtMs - a.receivedAtMs);

  const candidates = [];
  for (const message of freshMessages) {
    let fullMessage = null;
    if (message.messageId) {
      try {
        fullMessage = await fetchInboxMessage({ inboxId, messageId: message.messageId, apiKey, fetchImpl });
      } catch {
        fullMessage = null;
      }
    }
    const otp = extractOtpFromMessageFields(fullMessage ?? message.raw ?? message);
    if (!otp) continue;
    candidates.push({
      ...message,
      subject: fullMessage?.subject ?? message.subject,
      preview: fullMessage?.preview ?? message.preview,
      otp,
      fullMessage,
    });
  }

  if (candidates.length === 0) {
    throw new Error(`No OTP-bearing AgentMail message found for ${inboxId}`);
  }
  return candidates[0];
}

export async function waitForInboundOtp({
  inboxId,
  apiKey,
  sinceMs = 0,
  sinceGraceMs = 5_000,
  timeoutMs = 120_000,
  fetchImpl = fetch,
  createTransport = createAgentMailInboundTransport,
}) {
  try {
    return await fetchLatestInboxOtp({
      inboxId,
      apiKey,
      sinceMs,
      sinceGraceMs,
      fetchImpl,
    });
  } catch (error) {
    if (
      error?.message !== `No OTP-bearing AgentMail message found for ${inboxId}`
      && !isTransientFetchError(error)
    ) {
      throw error;
    }
  }

  const transport = createTransport({ apiKey, fetchImpl });
  try {
    const event = await transport.waitForMatchingMessage({
      inboxId,
      timeoutMs,
      matcher: (inboundEvent) => {
        const candidate = normalizeInboundOtpCandidate(inboundEvent);
        if (!candidate) {
          return false;
        }
        if (candidate.receivedAtMs == null) {
          return true;
        }
        return candidate.receivedAtMs >= Math.max(0, sinceMs - sinceGraceMs);
      },
    });

    const candidate = normalizeInboundOtpCandidate(event);
    if (!candidate) {
      throw new Error(`No OTP-bearing AgentMail message found for ${inboxId}`);
    }
    return candidate;
  } catch (error) {
    if (/Timed out waiting for AgentMail message/i.test(String(error?.message ?? ''))) {
      return await fetchLatestInboxOtp({
        inboxId,
        apiKey,
        sinceMs,
        sinceGraceMs,
        fetchImpl,
      });
    }
    throw error;
  } finally {
    await transport.shutdown?.();
  }
}

export async function pollFreshInboxOtp({
  inboxId,
  apiKey,
  sinceMs,
  sinceGraceMs = 5_000,
  pollIntervalMs = 1_000,
  timeoutMs = 120_000,
  fetchImpl = fetch,
  createTransport = createAgentMailInboundTransport,
}) {
  void pollIntervalMs;

  try {
    return await waitForInboundOtp({
      inboxId,
      apiKey,
      sinceMs,
      sinceGraceMs,
      timeoutMs,
      fetchImpl,
      createTransport,
    });
  } catch (error) {
    if (/Timed out waiting for AgentMail message/i.test(String(error?.message ?? ''))) {
      throw new Error(`OTP poll timeout for ${inboxId}: ${error.message}`);
    }
    throw error;
  }
}
