import { describe, expect, test } from '@jest/globals';

import { redactHeaders, redactValue } from '../../../src/pipeline/authTrace/redaction.js';

describe('redactValue', () => {
  test('redacts bearer and cookie-like token values', () => {
    expect(redactValue('Bearer abcdefghijklmnop')).toBe('[REDACTED]');
    expect(redactValue('eyJhbGciOiJSUzI1NiIsImtpZCI6Ij...')).toBe('[REDACTED]');
  });

  test('preserves non-sensitive short strings', () => {
    expect(redactValue('content-type')).toBe('content-type');
  });
});

describe('redactHeaders', () => {
  test('redacts authorization and cookie headers while preserving names', () => {
    expect(redactHeaders({ Authorization: 'Bearer secret', Cookie: 'a=b', Accept: 'application/json' })).toEqual({
      Authorization: '[REDACTED]',
      Cookie: '[REDACTED]',
      Accept: 'application/json',
    });
  });
});
