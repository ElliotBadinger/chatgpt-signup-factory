import { describe, expect, test } from '@jest/globals';

import { createAgentMailInbox } from '../../../src/pipeline/authTrace/agentMailInboxProvisioning.js';

describe('createAgentMailInbox', () => {
  test('creates a new agentmail inbox and returns a normalized record', async () => {
    const requests = [];
    const result = await createAgentMailInbox({
      apiKey: 'am_us_testkey123',
      displayName: 'OpenAI Signup Replay',
      fetchImpl: async (url, options = {}) => {
        requests.push({ url, options });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            inbox_id: 'brandnew123@agentmail.to',
            display_name: 'OpenAI Signup Replay',
          }),
        };
      },
      now: () => new Date('2026-03-16T21:30:00.000Z'),
    });

    expect(requests).toEqual([
      {
        url: 'https://api.agentmail.to/v0/inboxes',
        options: {
          method: 'POST',
          headers: {
            Authorization: 'Bearer am_us_testkey123',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ display_name: 'OpenAI Signup Replay' }),
        },
      },
    ]);
    expect(result).toEqual({
      inboxId: 'brandnew123@agentmail.to',
      email: 'brandnew123@agentmail.to',
      displayName: 'OpenAI Signup Replay',
      createdAt: '2026-03-16T21:30:00.000Z',
      raw: {
        inbox_id: 'brandnew123@agentmail.to',
        display_name: 'OpenAI Signup Replay',
      },
    });
  });

  test('throws when the agentmail inbox creation request fails', async () => {
    await expect(createAgentMailInbox({
      apiKey: 'am_us_testkey123',
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        text: async () => 'forbidden',
      }),
    })).rejects.toThrow('AgentMail inbox creation failed with status 403');
  });
});
