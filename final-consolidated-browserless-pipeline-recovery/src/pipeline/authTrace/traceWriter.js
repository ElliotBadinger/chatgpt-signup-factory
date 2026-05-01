import { appendFile } from 'node:fs/promises';

import { redactObjectShallow } from './redaction.js';

export function createTraceWriter(filePath) {
  return {
    async write(event) {
      const line = `${JSON.stringify(redactObjectShallow(event))}\n`;
      await appendFile(filePath, line, 'utf8');
    },
  };
}
