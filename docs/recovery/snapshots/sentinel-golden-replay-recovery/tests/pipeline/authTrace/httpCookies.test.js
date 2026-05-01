import { describe, expect, test } from '@jest/globals';

import {
  splitSetCookieHeader,
  parseSetCookie,
  createCookieJar,
  updateCookieJarFromHeader,
  renderCookieHeader,
} from '../../../src/pipeline/authTrace/httpCookies.js';

describe('splitSetCookieHeader', () => {
  test('splits comma-joined set-cookie headers without breaking expires attributes', () => {
    const header = [
      '__Secure-next-auth.state=state-123; Max-Age=900; Path=/; Expires=Mon, 16 Mar 2026 20:03:38 GMT; HttpOnly; Secure; SameSite=Lax',
      'login_session=session-123; path=/; Domain=auth.openai.com; Max-Age=2700; Expires=Mon, 16 Mar 2026 20:48:39 GMT; SameSite=Lax; Secure; HttpOnly',
      'hydra_redirect=redirect-123; path=/; Domain=auth.openai.com; Max-Age=2700; Expires=Mon, 16 Mar 2026 20:48:39 GMT; SameSite=Lax; Secure; HttpOnly',
    ].join(', ');

    expect(splitSetCookieHeader(header)).toEqual([
      '__Secure-next-auth.state=state-123; Max-Age=900; Path=/; Expires=Mon, 16 Mar 2026 20:03:38 GMT; HttpOnly; Secure; SameSite=Lax',
      'login_session=session-123; path=/; Domain=auth.openai.com; Max-Age=2700; Expires=Mon, 16 Mar 2026 20:48:39 GMT; SameSite=Lax; Secure; HttpOnly',
      'hydra_redirect=redirect-123; path=/; Domain=auth.openai.com; Max-Age=2700; Expires=Mon, 16 Mar 2026 20:48:39 GMT; SameSite=Lax; Secure; HttpOnly',
    ]);
  });
});

describe('parseSetCookie', () => {
  test('normalizes domain and cookie attributes', () => {
    const parsed = parseSetCookie('cf_clearance=clear-123; Domain=.chatgpt.com; Path=/; HttpOnly; Secure; SameSite=None');
    expect(parsed).toMatchObject({
      name: 'cf_clearance',
      value: 'clear-123',
      domain: 'chatgpt.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    });
  });
});

describe('cookie jar helpers', () => {
  test('updates jar from set-cookie header and renders applicable cookie header per url', () => {
    const jar = createCookieJar();
    updateCookieJarFromHeader(
      jar,
      [
        '__Host-next-auth.csrf-token=csrf-value%7Chash; Path=/; HttpOnly; Secure; SameSite=Lax',
        '__Secure-next-auth.state=state-123; Path=/; HttpOnly; Secure; SameSite=Lax',
        'login_session=session-123; Domain=auth.openai.com; Path=/; HttpOnly; Secure; SameSite=Lax',
      ].join(', '),
      'https://chatgpt.com/api/auth/signin/openai?prompt=login',
    );

    expect(renderCookieHeader(jar, 'https://chatgpt.com/api/auth/callback/openai?code=abc')).toContain('__Secure-next-auth.state=state-123');
    expect(renderCookieHeader(jar, 'https://chatgpt.com/api/auth/callback/openai?code=abc')).not.toContain('login_session=session-123');
    expect(renderCookieHeader(jar, 'https://auth.openai.com/email-verification')).toContain('login_session=session-123');
  });
});
