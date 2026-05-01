function toDate(now) {
  return typeof now === 'function' ? now() : new Date();
}

export async function createAgentMailInbox({
  apiKey,
  displayName = 'OpenAI Signup Replay',
  fetchImpl = fetch,
  now = null,
}) {
  if (!apiKey) {
    throw new Error('createAgentMailInbox requires apiKey');
  }

  const response = await fetchImpl('https://api.agentmail.to/v0/inboxes', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ display_name: displayName }),
  });

  if (!response.ok) {
    const bodySnippet = typeof response.text === 'function'
      ? (await response.text()).slice(0, 500)
      : '';
    throw new Error(`AgentMail inbox creation failed with status ${response.status}${bodySnippet ? `: ${bodySnippet}` : ''}`);
  }

  const body = await response.json();
  const inboxId = body.inbox_id ?? body.email ?? body.address ?? null;
  if (!inboxId) {
    throw new Error('AgentMail inbox creation response missing inbox_id');
  }

  return {
    inboxId,
    email: inboxId,
    displayName: body.display_name ?? displayName,
    createdAt: toDate(now).toISOString(),
    raw: body,
  };
}
