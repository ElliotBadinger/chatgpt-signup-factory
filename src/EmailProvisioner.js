export class EmailProvisioner {
  constructor({ agentMailProvider, env = process.env }) {
    this.agentMailProvider = agentMailProvider;
    this.env = env;
    this.createdInboxId = null;
  }

  async provision() {
    try {
      const inbox = await this.agentMailProvider.createInbox('Agent Factory');
      this.createdInboxId = inbox.inbox_id;
      return { inboxId: inbox.inbox_id, address: inbox.inbox_id };
    } catch (err) {
      return await this.provisionFallback(err);
    }
  }

  async provisionFallback(originalError) {
    if (this.env.CLOUDFLARE_API_TOKEN || this.env.CLOUDFLARE_GLOBAL_API_KEY) {
      return await this.createCloudflareAlias();
    }
    if (this.env.ZOHO_CLIENT_ID && this.env.ZOHO_REFRESH_TOKEN) {
      return await this.createZohoAlias();
    }
    throw originalError;
  }

  async createCloudflareAlias() {
    const zoneId = this.env.CLOUDFLARE_ZONE_ID;
    const email = `alias-${Date.now()}@${this.env.CLOUDFLARE_DOMAIN}`;
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/addresses`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, verified: false })
    });
    if (!res.ok) throw new Error(`Cloudflare failed: ${res.statusText}`);
    return { address: email, inboxId: null };
  }

  async createZohoAlias() {
    const tokenRes = await fetch('https://accounts.zoho.com/oauth/v2/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: this.env.ZOHO_CLIENT_ID,
        client_secret: this.env.ZOHO_CLIENT_SECRET,
        refresh_token: this.env.ZOHO_REFRESH_TOKEN,
        grant_type: 'refresh_token'
      })
    });
    if (!tokenRes.ok) throw new Error(`Zoho token failed: ${tokenRes.statusText}`);
    const { access_token } = await tokenRes.json();
    
    const email = `alias-${Date.now()}@${this.env.ZOHO_DOMAIN}`;
    const res = await fetch(`https://mail.zoho.com/api/accounts/${this.env.ZOHO_USER_ID}/emailalias`, {
      method: 'POST',
      headers: {
        'Authorization': `Zoho-oauthtoken ${access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ aliasAddress: email })
    });
    if (!res.ok) throw new Error(`Zoho alias failed: ${res.statusText}`);
    return { address: email, inboxId: null };
  }

  async cleanup() {
    if (this.createdInboxId && this.agentMailProvider?.deleteInbox) {
      await this.agentMailProvider.deleteInbox(this.createdInboxId);
    }
  }
}
