import { AgentMailProvider } from '../src/AgentMailProvider.js';

const API_KEY = 'am_a0c98e7c5c2a1bf80fbac1685eae5e5afa76851342bc36607d1a3c664318f2c4';

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
