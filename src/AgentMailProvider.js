import fetch from 'node-fetch';

export class AgentMailProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.agentmail.to/v0';
  }

  async createInbox(displayName = 'Agent Factory') {
    const listRes = await fetch(`${this.baseUrl}/inboxes`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });
    if (listRes.ok) {
      const data = await listRes.json();
      if (data.count >= 3) {
        // Delete the oldest one (last in list usually)
        const oldest = data.inboxes[data.inboxes.length - 1];
        console.log('Deleting oldest inbox:', oldest.inbox_id);
        await fetch(`${this.baseUrl}/inboxes/${oldest.inbox_id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${this.apiKey}` }
        });
      }
    }

    const res = await fetch(`${this.baseUrl}/inboxes`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ display_name: displayName })
    });
    if (!res.ok) throw new Error(`AgentMail failed: ${res.statusText}`);
    return await res.json();
  }

  async waitForCode(inboxId, timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await fetch(`${this.baseUrl}/inboxes/${inboxId}/messages`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });
      if (res.ok) {
        const data = await res.json();
        // Look for verification codes
        for (const msg of data.messages) {
          const match = msg.subject.match(/(\d{6})/);
          if (match) return match[1];
          // Or search in body/preview if needed
          if (msg.preview) {
            const bodyMatch = msg.preview.match(/(\d{6})/);
            if (bodyMatch) return bodyMatch[1];
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return null;
  }
}
