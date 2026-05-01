import { describe, expect, jest, test } from '@jest/globals';

import {
  extractOtpFromResendEmail,
  fetchLatestResendReceivedEmail,
  isResendReceivingAddress,
  pollResendReceivedOtp,
} from '../../../src/pipeline/authTrace/resendReceiving.js';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

describe('Resend receiving helpers', () => {
  test('detects custom-domain receiving addresses', () => {
    expect(isResendReceivingAddress('openai_1@epistemophile.store')).toBe(true);
    expect(isResendReceivingAddress('user@agentmail.to')).toBe(false);
  });

  test('extracts OpenAI OTP from received email content', () => {
    expect(extractOtpFromResendEmail({
      subject: 'Your temporary ChatGPT verification code',
      text: 'Your code is 123456.',
    })).toBe('123456');
  });

  test('lists, retrieves, and filters received emails by exact recipient', async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (String(url).endsWith('/emails/receiving?limit=50')) {
        return response(200, {
          data: [
            {
              id: 'msg-old',
              to: ['openai_1@epistemophile.store'],
              subject: 'Your temporary ChatGPT verification code',
              created_at: '2026-04-24 01:00:00.123456+00',
            },
            {
              id: 'msg-new',
              to: ['openai_1@epistemophile.store'],
              subject: 'Your temporary ChatGPT verification code',
              created_at: '2026-04-24 01:01:00.123456+00',
            },
          ],
        });
      }
      return response(200, {
        id: 'msg-new',
        to: ['openai_1@epistemophile.store'],
        subject: 'Your temporary ChatGPT verification code',
        text: 'Use 654321 to continue.',
        created_at: '2026-04-24 01:01:00.123456+00',
      });
    });

    const email = await fetchLatestResendReceivedEmail({
      email: 'openai_1@epistemophile.store',
      apiKey: 're_test',
      fetchImpl,
    });

    expect(email.id).toBe('msg-new');
  });

  test('retries transient Resend receiving list failures', async () => {
    const fetchImpl = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }))
      .mockResolvedValueOnce(response(200, {
        data: [{
          id: 'msg-new',
          to: ['openai_1@epistemophile.store'],
          subject: 'Your temporary ChatGPT verification code',
          created_at: '2026-04-24 01:01:00.123456+00',
        }],
      }))
      .mockResolvedValueOnce(response(200, {
        id: 'msg-new',
        subject: 'Your temporary ChatGPT verification code',
        text: 'Use 654321 to continue.',
        created_at: '2026-04-24 01:01:00.123456+00',
      }));

    const email = await fetchLatestResendReceivedEmail({
      email: 'openai_1@epistemophile.store',
      apiKey: 're_test',
      fetchImpl,
    });

    expect(email.id).toBe('msg-new');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test('polls received emails and returns OTP metadata', async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (String(url).endsWith('/emails/receiving?limit=100')) {
        return response(200, {
          data: [{
            id: 'msg-otp',
            to: ['openai_1@epistemophile.store'],
            subject: 'Your temporary ChatGPT verification code',
            created_at: '2026-04-24 01:01:00.123456+00',
          }],
        });
      }
      return response(200, {
        id: 'msg-otp',
        subject: 'Your temporary ChatGPT verification code',
        text: '654321',
        created_at: '2026-04-24 01:01:00.123456+00',
      });
    });

    const result = await pollResendReceivedOtp({
      email: 'openai_1@epistemophile.store',
      apiKey: 're_test',
      fetchImpl,
      timeoutMs: 5,
    });

    expect(result).toMatchObject({
      otp: '654321',
      messageId: 'msg-otp',
      subject: 'Your temporary ChatGPT verification code',
    });
  });
});
