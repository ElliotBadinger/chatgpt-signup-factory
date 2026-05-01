import { describe, expect, test } from '@jest/globals';

import { extractJsonSchemaShape } from '../../../src/pipeline/authTrace/schemaExtraction.js';

describe('extractJsonSchemaShape', () => {
  test('extracts shallow schema from json response', () => {
    expect(extractJsonSchemaShape({ accessToken: 'abc', user: { id: 'u1' }, items: [1, 2] })).toEqual({
      type: 'object',
      keys: {
        accessToken: 'string',
        user: 'object',
        items: 'array',
      },
    });
  });
});
