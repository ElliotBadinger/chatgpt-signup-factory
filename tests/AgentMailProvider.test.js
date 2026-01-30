import { AgentMailProvider } from '../src/AgentMailProvider.js';

const API_KEY = 'REDACTED';

describe('AgentMailProvider', () => {
  let provider;

  beforeAll(() => {
    provider = new AgentMailProvider(API_KEY);
  });

  test('should create a new inbox', async () => {
    const inbox = await provider.createInbox();
    console.log('Created inbox:', inbox.inbox_id);
    expect(inbox.inbox_id).toContain('@agentmail.to');
  });

  test('should poll for code (timeout scenario)', async () => {
    const inbox = await provider.createInbox();
    const code = await provider.waitForCode(inbox.inbox_id, 1000); // 1s timeout for test
    expect(code).toBeNull();
  }, 15000);
});
