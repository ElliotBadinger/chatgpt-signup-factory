import fc from 'fast-check';
import { redactConfig } from '../src/config/redaction.js';

describe('redactConfig property tests', () => {
  const sensitiveKeys = ['password', 'cvc', 'cardNumber', 'email'];

  const leaf = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null));
  const arbKey = fc.oneof(fc.string(), fc.constantFrom(...sensitiveKeys));
  
  const level1 = fc.dictionary(arbKey, leaf);
  const level2 = fc.dictionary(arbKey, fc.oneof(leaf, level1));
  const arbConfig = fc.dictionary(arbKey, fc.oneof(leaf, level1, level2));

  it('redacts all sensitive keys regardless of nesting', () => {
    fc.assert(
      fc.property(
        arbConfig,
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
                if (typeof obj[key] === 'string' && obj[key].length > 0) {
                    if (obj[key] === '[REDACTED]') {
                        // skip
                    } else if (obj[key].startsWith('**** **** ****')) {
                        const digits = obj[key].replace(/\D+/g, '');
                        if (digits.length >= 4 && obj.cardLast4 !== digits.slice(-4)) return false;
                    } else {
                        return false;
                    }
                }
              }
 else if (key === 'email' && typeof obj[key] === 'string' && obj[key].includes('@')) {
                  const atIndex = obj[key].indexOf('@');
                  if (atIndex > 0 && !obj[key].includes('***@')) return false;
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
