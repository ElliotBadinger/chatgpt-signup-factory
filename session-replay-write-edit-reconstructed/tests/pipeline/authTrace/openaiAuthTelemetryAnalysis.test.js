import { describe, expect, test } from '@jest/globals';
import path from 'node:path';

import { analyzeOpenAiAuthTelemetry } from '../../../src/pipeline/authTrace/openaiAuthTelemetryAnalysis.js';

const FIXTURE_DIR = path.resolve('artifacts/auth-traces/2026-03-15T20-01-44-099Z-deep-golden-signup-v2');

describe('analyzeOpenAiAuthTelemetry', () => {
  test('derives deterministic signup and existing-login OTP replay plans from trace evidence', async () => {
    const result = await analyzeOpenAiAuthTelemetry(FIXTURE_DIR, { dryRun: true });

    expect(result.report.actualScenario).toBe('signup-new');
    expect(result.report.signup.authorize.redirectLocation).toBe('https://auth.openai.com/create-account/password');
    expect(result.report.signup.register.bodyKeys).toEqual(['password', 'username']);
    expect(result.report.signup.emailOtpValidate.bodyKeys).toEqual(['code']);
    expect(result.report.signup.createAccount.bodyKeys).toEqual(['birthdate', 'name']);
    expect(result.report.sentinel.flows.map((flow) => flow.flow)).toEqual(expect.arrayContaining([
      'username_password_create',
      'oauth_create_account',
    ]));
    expect(result.report.sentinel.requiredHeaders).toEqual(expect.arrayContaining([
      'openai-sentinel-token',
      'openai-sentinel-so-token',
    ]));
    expect(result.report.sentinel.requestTemplates.username_password_create).toMatchObject({
      method: 'POST',
      url: 'https://sentinel.openai.com/backend-api/sentinel/req',
      body: {
        flow: 'username_password_create',
      },
    });
    expect(result.report.sentinel.requestTemplates.oauth_create_account).toMatchObject({
      method: 'POST',
      url: 'https://sentinel.openai.com/backend-api/sentinel/req',
      body: {
        flow: 'oauth_create_account',
      },
    });
    expect(result.report.sentinel.headerTemplates['/api/accounts/user/register']['openai-sentinel-token']).toMatchObject({
      flow: 'username_password_create',
      id: '037bf0ab-6988-4f13-b7f4-802e2f3e0143',
    });
    expect(result.report.sentinel.headerTemplates['/api/accounts/create_account']['openai-sentinel-token']).toMatchObject({
      flow: 'oauth_create_account',
      id: '037bf0ab-6988-4f13-b7f4-802e2f3e0143',
    });
    expect(result.report.sentinel.headerTemplates['/api/accounts/create_account']['openai-sentinel-so-token']).toMatchObject({
      flow: 'oauth_create_account',
      id: '037bf0ab-6988-4f13-b7f4-802e2f3e0143',
    });

    expect(result.plan.existingLoginOtp.sequence.map((step) => step.name)).toEqual([
      'bootstrap_login_with',
      'bootstrap_providers',
      'bootstrap_csrf',
      'bootstrap_signin_openai',
      'authorize_with_login_hint',
      'load_email_verification',
      'email_otp_validate',
      'chatgpt_callback',
      'chatgpt_session',
    ]);

    expect(result.plan.signup.sequence.map((step) => step.name)).toEqual(expect.arrayContaining([
      'authorize_with_login_hint',
      'load_create_account_password',
      'sentinel_req_username_password_create',
      'user_register',
      'email_otp_send',
      'email_otp_validate',
      'load_about_you',
      'sentinel_req_oauth_create_account',
      'create_account',
      'chatgpt_callback',
      'chatgpt_session',
    ]));
  });
});
