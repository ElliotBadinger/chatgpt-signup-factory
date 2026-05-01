import { describe, expect, jest, test } from '@jest/globals';

import { attachCdpNetwork } from '../../../src/pipeline/authTrace/deepCapture/attachCdpNetwork.js';

describe('attachCdpNetwork', () => {
  test('enables network domain and writes events through writer', async () => {
    const handlers = new Map();
    const client = {
      send: jest.fn(async () => {}),
      on: jest.fn((event, handler) => handlers.set(event, handler)),
      detach: jest.fn(async () => {}),
    };
    const page = { target: () => ({ createCDPSession: async () => client }) };
    const writer = { write: jest.fn(async () => {}) };

    const session = await attachCdpNetwork({ page, writer });
    expect(client.send).toHaveBeenCalledWith('Network.enable');

    await handlers.get('Network.requestWillBeSent')({ requestId: '1', request: { url: 'https://chatgpt.com/' } });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({ type: 'cdp-network', event: 'Network.requestWillBeSent' }));

    await session.detach();
    expect(client.detach).toHaveBeenCalled();
  });
});
