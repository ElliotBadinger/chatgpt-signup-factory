import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from '@jest/globals';

import {
  buildBillingBoundaryHandoff,
  probeBillingBoundary,
  writeBillingBoundaryProbeArtifact,
} from '../../../src/pipeline/rotation/billingBoundaryProbe.js';

function response({ status = 200, headers = {}, body = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => body,
  };
}

describe('probeBillingBoundary', () => {
  test('classifies the authenticated team-trial to billing chain as billing-boundary-reached', async () => {
    const fetchImpl = async (url) => {
      if (url === 'https://chatgpt.com/api/auth/session') {
        return response({
          body: JSON.stringify({
            accessToken: 'tok_live',
            account: { id: 'workspace-123', planType: 'team', structure: 'workspace' },
            user: { email: 'member@example.com' },
          }),
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).startsWith('https://chatgpt.com/team-sign-up')) {
        return response({
          status: 302,
          headers: { location: '/?promo_campaign=team-1-month-free#team-pricing' },
        });
      }
      if (url === 'https://chatgpt.com/?promo_campaign=team-1-month-free#team-pricing') {
        return response({
          body: '<html><head><title>ChatGPT</title></head><body>{"authStatus":"logged_in","enabled_custom_checkout_for_team":true}<script src="https://js.stripe.com/v3/"></script></body></html>',
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url === 'https://chatgpt.com/admin/billing') {
        return response({
          body: '<html><body>{"authStatus":"logged_in","is_checkout_redesign":true,"is_save_stripe_payment_info_enabled":true}</body></html>',
          headers: { 'content-type': 'text/html' },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await probeBillingBoundary({
      runtimeCookies: [{ name: '__Secure-next-auth.session-token', value: 'cookie', domain: 'chatgpt.com', path: '/' }],
      fetchImpl,
      expectedEmail: 'member@example.com',
      expectedWorkspaceId: 'workspace-123',
      freshIdentity: { required: true, acquired: true, persisted: false },
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'billing-boundary-reached',
      reason: 'openai-billing-shell-reached',
      candidateBillingUrl: 'https://chatgpt.com/admin/billing',
      freshIdentity: { required: true, acquired: true, persisted: false },
      session: expect.objectContaining({
        accountId: 'workspace-123',
        planType: 'team',
        structure: 'workspace',
        email: 'member@example.com',
      }),
    }));
    expect(result.redirectChain).toEqual([
      expect.objectContaining({
        url: expect.stringContaining('/team-sign-up'),
        status: 302,
        location: '/?promo_campaign=team-1-month-free#team-pricing',
      }),
      expect.objectContaining({
        url: 'https://chatgpt.com/?promo_campaign=team-1-month-free#team-pricing',
        status: 200,
        authStatus: 'logged_in',
      }),
      expect.objectContaining({
        url: 'https://chatgpt.com/admin/billing',
        status: 200,
        authStatus: 'logged_in',
      }),
    ]);
    expect(result.checkoutFlags).toEqual(expect.arrayContaining([
      'enabled_custom_checkout_for_team',
      'is_checkout_redesign',
      'is_save_stripe_payment_info_enabled',
    ]));
    expect(result.candidateStripeUrls).toEqual(['https://js.stripe.com/v3/']);
  });

  test('classifies Cloudflare challenge at billing as a blocked boundary', async () => {
    const fetchImpl = async (url) => {
      if (url === 'https://chatgpt.com/api/auth/session') {
        return response({
          body: JSON.stringify({
            accessToken: 'tok_live',
            account: { id: 'workspace-123', planType: 'team', structure: 'workspace' },
            user: { email: 'member@example.com' },
          }),
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).startsWith('https://chatgpt.com/team-sign-up')) {
        return response({
          status: 302,
          headers: { location: '/?promo_campaign=team-1-month-free#team-pricing' },
        });
      }
      if (url === 'https://chatgpt.com/?promo_campaign=team-1-month-free#team-pricing') {
        return response({
          body: '<html><body>{"authStatus":"logged_in"}</body></html>',
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url === 'https://chatgpt.com/admin/billing') {
        return response({
          status: 403,
          headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' },
          body: '<html><body>challenge-platform</body></html>',
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await probeBillingBoundary({
      runtimeCookies: [{ name: 'session', value: 'cookie', domain: 'chatgpt.com', path: '/' }],
      fetchImpl,
      expectedEmail: 'member@example.com',
      expectedWorkspaceId: 'workspace-123',
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'blocked',
      blockerReason: 'cloudflare-challenge-boundary',
      reason: 'billing-surface-challenged',
    }));
  });
});

describe('billing boundary artifacts', () => {
  test('writes a probe artifact and builds a handoff with structured billing details', async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'billing-boundary-probe-'));
    const probeResult = {
      status: 'billing-boundary-reached',
      entryUrl: 'https://chatgpt.com/team-sign-up?...',
      candidateBillingUrl: 'https://chatgpt.com/admin/billing',
      candidateStripeUrls: ['https://js.stripe.com/v3/'],
      redirectChain: [{ url: 'https://chatgpt.com/admin/billing', status: 200 }],
      session: { email: 'member@example.com', accountId: 'workspace-123', planType: 'team' },
      freshIdentity: { required: true, acquired: true, persisted: false },
      candidatePromotionSignals: [{ source: '/api/auth/session', planType: 'team' }],
    };

    const probePath = await writeBillingBoundaryProbeArtifact(artifactDir, probeResult);
    const raw = await readFile(probePath, 'utf8');
    const handoff = buildBillingBoundaryHandoff({
      probeResult,
      proofPaths: [probePath],
      resumeCommand: 'node resume-billing.js',
      statusCommand: 'node status-billing.js',
      target: 'member@example.com',
      inviter: 'workspace-owner-a',
    });

    expect(JSON.parse(raw)).toEqual(expect.objectContaining({
      status: 'billing-boundary-reached',
      candidateBillingUrl: 'https://chatgpt.com/admin/billing',
    }));
    expect(handoff).toEqual(expect.objectContaining({
      target: 'member@example.com',
      inviter: 'workspace-owner-a',
      inviteLink: 'https://chatgpt.com/admin/billing',
      proofPaths: [probePath],
      status: 'billing-boundary-reached',
      details: expect.objectContaining({
        billingUrl: 'https://chatgpt.com/admin/billing',
        stripeUrls: ['https://js.stripe.com/v3/'],
        freshIdentity: { required: true, acquired: true, persisted: false },
      }),
    }));
  });
});