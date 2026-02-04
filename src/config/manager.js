import fs from 'node:fs';
import YAML from 'yaml';

import { AppConfigSchema } from './schema.js';

export function validateConfig(obj) {
  return AppConfigSchema.parse(obj ?? {});
}

export function loadConfig(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = YAML.parse(content) ?? {};
  return validateConfig(parsed);
}

export function saveConfig(filePath, config) {
  const validated = validateConfig(config);
  const content = YAML.stringify(validated);
  fs.writeFileSync(filePath, content, 'utf8');
}
