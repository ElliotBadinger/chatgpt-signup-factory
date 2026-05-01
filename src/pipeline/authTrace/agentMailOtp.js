const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function fetchInboxMessage({ inboxId, messageId, apiKey, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`AgentMail message fetch failed for ${inboxId}/${messageId}: ${res.status}`);
  return res.json();
}

export async function fetchLatestInboxOtp({ inboxId, apiKey, limit = 10, sinceMs = 0, sinceGraceMs = 5_000, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages?limit=${limit}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`AgentMail list failed for ${inboxId}: ${res.status}`);
  const data = await res.json();

  const freshMessages = (data.messages ?? [])
    .map((m) => ({
      messageId: m.message_id,
      timestamp: m.timestamp,
      subject: m.subject ?? '',
      preview: m.preview ?? '',
      receivedAtMs: m.timestamp ? new Date(m.timestamp).getTime() : 0,
      raw: m,
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

export async function pollFreshInboxOtp({
  inboxId,
  apiKey,
  sinceMs,
  sinceGraceMs = 5_000,
  pollIntervalMs = 1_000,
  timeoutMs = 120_000,
  fetchImpl = fetch,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      return await fetchLatestInboxOtp({ inboxId, apiKey, sinceMs, sinceGraceMs, fetchImpl });
    } catch (error) {
      lastError = error;
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }

  throw new Error(`OTP poll timeout for ${inboxId}: ${lastError?.message ?? 'no fresh OTP'}`);
}

export const waitForInboundOtp = pollFreshInboxOtp;
