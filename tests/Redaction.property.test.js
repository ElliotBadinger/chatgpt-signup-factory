import fc from 'fast-check';
import { redactConfig } from '../src/config/redaction.js';

describe('redactConfig property tests', () => {
  const sensitiveKeys = ['password', 'cvc', 'cardNumber'];

  it('redacts all sensitive keys regardless of nesting', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
            fc.oneof(fc.string(), fc.constantFrom(...sensitiveKeys)),
            fc.oneof(fc.string(), fc.dictionary(fc.oneof(fc.string(), fc.constantFrom(...sensitiveKeys)), fc.string()))
        ),
        (config) => {
          const redacted = redactConfig(config);
          
          const checkRecursive = (obj) => {
            if (obj === null || typeof obj !== 'object') return true;
            for (const key in obj) {
              if (key === 'password' || key === 'cvc') {
                if (typeof obj[key] === 'string' && obj[key].length > 0 && obj[key] !== '[REDACTED]') {
                    return false;
                }
              } else if (key === 'cardNumber') {
                if (typeof obj[key] === 'string' && obj[key].length > 0 && !obj[key].startsWith('**** **** ****')) {
                    if (obj[key] !== '[REDACTED]') return false;
                }
              }
              if (!checkRecursive(obj[key])) return false;
            }
            return true;
          };
          return checkRecursive(redacted);
        }
      ),
      { seed: 42, numRuns: 1000 }
    );
  });

  it('is idempotent (redacting twice is same as once)', () => {
    fc.assert(
      fc.property(fc.object(), (config) => {
        const first = redactConfig(config);
        const second = redactConfig(first);
        expect(second).toEqual(first);
      })
    );
  });

  it('never throws on arbitrary objects', () => {
    fc.assert(
      fc.property(fc.anything(), (val) => {
        try {
          redactConfig(val);
          return true;
        } catch (e) {
          return false;
        }
      })
    );
  });
});
