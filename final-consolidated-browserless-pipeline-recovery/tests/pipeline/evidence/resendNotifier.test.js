import { describe, expect, jest, test } from '@jest/globals';

import {
  buildResendEmailPayload,
  redactResendApiKey,
  sendHandoffViaResend,
  sendResendEmail,
  shouldSendResendHandoff,
} from '../../../src/pipeline/evidence/resendNotifier.js';

describe('buildResendEmailPayload', () => {
  test('normalizes comma-separated recipients', () => {
    expect(
      buildResendEmailPayload({
        from: 'Pipeline <pipeline@example.com>',
        to: 'one@example.com, two@example.com',
        subject: 'Ready',
        text: 'handoff',
      }),
    ).toMatchObject({
      from: 'Pipeline <pipeline@example.com>',
      to: ['one@example.com', 'two@example.com'],
      subject: 'Ready',
      text: 'handoff',
    });
  });

  test('requires a recipient', () => {
    expect(() => buildResendEmailPayload({ text: 'handoff', to: '' })).toThrow(/recipient missing/i);
  });
});

describe('sendResendEmail', () => {
  test('posts to Resend with bearer auth and redacts the key in the result', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'email-123' }),
    }));

    const result = await sendResendEmail({
      apiKey: 're_1234567890abcdef',
      fetchImpl,
      from: 'Pipeline <pipeline@example.com>',
      to: ['ops@example.com'],
      subject: 'Handoff',
      text: 'body',
    });

    expect(fetchImpl).toHaveBeenCalledWith('https://api.resend.com/emails', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer re_1234567890abcdef',
        'Content-Type': 'application/json',
      }),
    }));

    const [, request] = fetchImpl.mock.calls[0];
    expect(JSON.parse(request.body)).toMatchObject({
      from: 'Pipeline <pipeline@example.com>',
      to: ['ops@example.com'],
      subject: 'Handoff',
      text: 'body',
    });
    expect(result).toMatchObject({
      status: 'sent',
      provider: 'resend',
      id: 'email-123',
      apiKey: 're_123...cdef',
    });
  });

  test('throws useful failures without leaking request credentials', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ message: 'Invalid from address' }),
    }));

    await expect(
      sendResendEmail({
        apiKey: 're_secret',
        fetchImpl,
        from: 'bad',
        to: 'ops@example.com',
        text: 'body',
      }),
    ).rejects.toThrow(/Invalid from address/);
  });
});

describe('sendHandoffViaResend', () => {
  test('sends markdown handoff as text and escaped html', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'email-456' }),
    }));

    await sendHandoffViaResend('# Handoff\n<script>', {
      apiKey: 're_1234567890abcdef',
      fetchImpl,
      from: 'pipeline@example.com',
      to: 'ops@example.com',
    });

    const [, request] = fetchImpl.mock.calls[0];
    const payload = JSON.parse(request.body);
    expect(payload.subject).toBe('Pipeline handoff ready');
    expect(payload.text).toContain('# Handoff');
    expect(payload.html).toContain('&lt;script&gt;');
  });
});

describe('redactResendApiKey', () => {
  test('redacts stable prefixes and suffixes', () => {
    expect(redactResendApiKey('re_1234567890abcdef')).toBe('re_123...cdef');
  });
});

describe('shouldSendResendHandoff', () => {
  test('auto-enables only when key and recipient are configured', () => {
    const oldEnv = { ...process.env };
    try {
      delete process.env.RESEND_API_KEY;
      delete process.env.RESEND_HANDOFF_TO;
      delete process.env.RESEND_TO_EMAIL;
      expect(shouldSendResendHandoff()).toBe(false);

      process.env.RESEND_API_KEY = 're_test';
      expect(shouldSendResendHandoff()).toBe(false);

      process.env.RESEND_HANDOFF_TO = 'ops@example.com';
      expect(shouldSendResendHandoff()).toBe(true);

      process.env.RESEND_HANDOFF_ENABLED = 'false';
      expect(shouldSendResendHandoff()).toBe(false);
    } finally {
      process.env = oldEnv;
    }
  });

  test('explicit handoff settings override auto detection', () => {
    expect(shouldSendResendHandoff({ enabled: true })).toBe(true);
    expect(shouldSendResendHandoff({ enabled: false })).toBe(false);
  });
});
