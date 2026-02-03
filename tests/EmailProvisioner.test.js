import { EmailProvisioner } from '../src/EmailProvisioner.js';

class FakeAgentMail {
  constructor() { this.created = false; this.deleted = null; }
  async createInbox() { this.created = true; return { inbox_id: 'abc@agentmail.to' }; }
  async deleteInbox(id) { this.deleted = id; }
}

test('EmailProvisioner returns agentmail inbox + cleanup', async () => {
  const provider = new FakeAgentMail();
  const provisioner = new EmailProvisioner({ agentMailProvider: provider, env: {} });
  const result = await provisioner.provision();
  expect(result.address).toBe('abc@agentmail.to');
  expect(result.inboxId).toBe('abc@agentmail.to');
  await provisioner.cleanup();
  expect(provider.deleted).toBe('abc@agentmail.to');
});

test('EmailProvisioner falls back to Cloudflare if AgentMail fails', async () => {
  const provider = { createInbox: () => { throw new Error('AgentMail down'); } };
  const env = { 
    CLOUDFLARE_API_TOKEN: 'cf-token', 
    CLOUDFLARE_ZONE_ID: 'zone123', 
    CLOUDFLARE_DOMAIN: 'example.com' 
  };
  const provisioner = new EmailProvisioner({ agentMailProvider: provider, env });
  
  // Mock global fetch for Cloudflare
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    return { ok: true, status: 200, json: async () => ({}) };
  };

  try {
    const result = await provisioner.provision();
    expect(result.address).toContain('@example.com');
    expect(result.inboxId).toBeNull();
  } finally {
    global.fetch = originalFetch;
  }
});

test('EmailProvisioner falls back to Zoho if AgentMail fails', async () => {
  const provider = { createInbox: () => { throw new Error('AgentMail down'); } };
  const env = { 
    ZOHO_CLIENT_ID: 'zoho-id',
    ZOHO_CLIENT_SECRET: 'zoho-secret',
    ZOHO_REFRESH_TOKEN: 'zoho-refresh',
    ZOHO_USER_ID: 'user123',
    ZOHO_DOMAIN: 'zoho.com'
  };
  const provisioner = new EmailProvisioner({ agentMailProvider: provider, env });
  
  // Mock global fetch for Zoho
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (url.includes('accounts.zoho.com')) {
      return { ok: true, json: async () => ({ access_token: 'zoho-access' }) };
    }
    if (url.includes('mail.zoho.com')) {
      return { ok: true, json: async () => ({}) };
    }
    return { ok: false };
  };

  try {
    const result = await provisioner.provision();
    expect(result.address).toContain('@zoho.com');
    expect(result.inboxId).toBeNull();
  } finally {
    global.fetch = originalFetch;
  }
});
