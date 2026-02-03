import { jest } from '@jest/globals';

jest.unstable_mockModule('node-fetch', () => ({
  default: jest.fn(),
}));

const { EmailProvisioner } = await import('../src/EmailProvisioner.js');
const { default: fetch } = await import('node-fetch');

class FakeAgentMail {
  constructor() { this.created = false; this.deleted = null; }
  async createInbox() { this.created = true; return { inbox_id: 'abc@agentmail.to' }; }
  async deleteInbox(id) { this.deleted = id; }
}

describe('EmailProvisioner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('EmailProvisioner returns agentmail inbox + cleanup', async () => {
    const provider = new FakeAgentMail();
    const provisioner = new EmailProvisioner({ agentMailProvider: provider, env: {} });
    const result = await provisioner.provision();
    expect(result.address).toBe('abc@agentmail.to');
    expect(result.inboxId).toBe('abc@agentmail.to');
    await provisioner.cleanup();
    expect(provider.deleted).toBe('abc@agentmail.to');
  });

  test('EmailProvisioner falls back to Cloudflare (API Token) if AgentMail fails', async () => {
    const provider = { createInbox: () => { throw new Error('AgentMail down'); } };
    const env = { 
      CLOUDFLARE_API_TOKEN: 'cf-token', 
      CLOUDFLARE_ZONE_ID: 'zone123', 
      CLOUDFLARE_DOMAIN: 'example.com' 
    };
    const provisioner = new EmailProvisioner({ agentMailProvider: provider, env });
    
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

    const result = await provisioner.provision();
    expect(result.address).toContain('@example.com');
    expect(result.inboxId).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('cloudflare.com'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer cf-token'
        })
      })
    );
  });

  test('EmailProvisioner falls back to Cloudflare (Global Key) and derives domain', async () => {
    const provider = { createInbox: () => { throw new Error('AgentMail down'); } };
    const env = { 
      CLOUDFLARE_GLOBAL_API_KEY: 'cf-global-key',
      CLOUDFLARE_EMAIL: 'admin@my-domain.com',
      CLOUDFLARE_ZONE_ID: 'zone123'
    };
    const provisioner = new EmailProvisioner({ agentMailProvider: provider, env });
    
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

    const result = await provisioner.provision();
    expect(result.address).toContain('@my-domain.com');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('cloudflare.com'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Auth-Email': 'admin@my-domain.com',
          'X-Auth-Key': 'cf-global-key'
        })
      })
    );
  });

  test('EmailProvisioner falls back to Zoho and derives domain', async () => {
    const provider = { createInbox: () => { throw new Error('AgentMail down'); } };
    const env = { 
      ZOHO_CLIENT_ID: 'zoho-id',
      ZOHO_CLIENT_SECRET: 'zoho-secret',
      ZOHO_REFRESH_TOKEN: 'zoho-refresh',
      ZOHO_USER_ID: 'user123',
      ZOHO_PRIMARY_EMAIL: 'staff@zoho-corp.com'
    };
    const provisioner = new EmailProvisioner({ agentMailProvider: provider, env });
    
    fetch.mockImplementation(async (url) => {
      if (url.includes('accounts.zoho.com')) {
        return { ok: true, json: async () => ({ access_token: 'zoho-access' }) };
      }
      if (url.includes('mail.zoho.com')) {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: false };
    });

    const result = await provisioner.provision();
    expect(result.address).toContain('@zoho-corp.com');
    expect(result.inboxId).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('mail.zoho.com'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Zoho-oauthtoken zoho-access'
        })
      })
    );
  });
});
