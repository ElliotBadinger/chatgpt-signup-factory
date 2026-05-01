import { describe, expect, test, jest } from '@jest/globals';

import { recoverBrowserlessIdentity } from '../../../src/pipeline/authTrace/recoverBrowserlessIdentity.js';

describe('recoverBrowserlessIdentity', () => {
  test.each([
    ['existing-login-otp', 'runExistingLogin', {
      existing: { verdict: 'authenticated', branch: 'existing-login-otp', finalSession: { userEmail: 'member@example.com' }, session: { accessToken: 'tok-1', expires: '2026-03-17T01:00:00.000Z', user: { email: 'member@example.com' }, account: { id: 'workspace-1' } } },
      password: { verdict: 'blocked', blockerReason: 'not-needed' },
      forgot: { verdict: 'blocked', blockerReason: 'not-needed' },
    }],
    ['password-login', 'runPasswordLogin', {
      existing: { verdict: 'unsupported-authorize-redirect', blockerReason: 'password-only-login' },
      password: { verdict: 'authenticated', branch: 'password-login', finalSession: { userEmail: 'member@example.com' }, session: { accessToken: 'tok-2', expires: '2026-03-17T01:00:00.000Z', user: { email: 'member@example.com' }, account: { id: 'workspace-2' } } },
      forgot: { verdict: 'blocked', blockerReason: 'not-needed' },
    }],
    ['forgot-password', 'runForgotPassword', {
      existing: { verdict: 'unsupported-authorize-redirect', blockerReason: 'password-only-login' },
      password: { verdict: 'blocked', blockerReason: 'password-unavailable' },
      forgot: { verdict: 'authenticated', branch: 'forgot-password', finalSession: { userEmail: 'member@example.com' }, session: { accessToken: 'tok-3', expires: '2026-03-17T01:00:00.000Z', user: { email: 'member@example.com' }, account: { id: 'workspace-3' } } },
    }],
  ])('%s returns recovered classification', async (_label, expectedRunner, replayResults) => {
    const replayResult = replayResults[expectedRunner === 'runExistingLogin' ? 'existing' : expectedRunner === 'runPasswordLogin' ? 'password' : 'forgot'];
    const runExistingLogin = jest.fn().mockResolvedValue(replayResults.existing);
    const runPasswordLogin = jest.fn().mockResolvedValue(replayResults.password);
    const runForgotPassword = jest.fn().mockResolvedValue(replayResults.forgot);
    const runPasswordInit = jest.fn().mockResolvedValue({ verdict: 'unsupported-password-init' });

    const result = await recoverBrowserlessIdentity({
      email: 'member@example.com',
      analysis: { sample: true },
      runExistingLogin,
      runPasswordLogin,
      runForgotPassword,
      runPasswordInit,
    });

    expect(result.status).toBe('recovered');
    expect(result.branch).toBe(replayResult.branch);
    expect(result.auth).toEqual({
      accessToken: replayResult.session.accessToken,
      expiresAt: Date.parse(replayResult.session.expires),
      accountId: replayResult.session.account.id,
      identityEmail: 'member@example.com',
    });
    expect({ runExistingLogin, runPasswordLogin, runForgotPassword }[expectedRunner]).toHaveBeenCalledWith(expect.objectContaining({
      email: 'member@example.com',
      analysis: { sample: true },
    }));
  });

  test('recovery exhausted returns recreate-needed classification', async () => {
    const result = await recoverBrowserlessIdentity({
      email: 'member@example.com',
      runExistingLogin: jest.fn().mockResolvedValue({ verdict: 'unsupported-authorize-redirect', blockerReason: 'password-only-login' }),
      runPasswordLogin: jest.fn().mockResolvedValue({ verdict: 'blocked', blockerReason: 'password-unavailable' }),
      runForgotPassword: jest.fn().mockResolvedValue({ verdict: 'recreate-needed', reason: 'reset-not-available' }),
      runPasswordInit: jest.fn().mockResolvedValue({ verdict: 'recreate-needed', reason: 'password-init-required' }),
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'recreate-needed',
      reason: 'password-init-required',
    }));
    expect(result.attempts.map((attempt) => attempt.branch)).toEqual([
      'existing-login-otp',
      'password-login',
      'forgot-password',
      'password-init',
    ]);
  });
});
