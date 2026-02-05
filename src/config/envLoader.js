import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

export function loadEnv({ configPath, cwd = process.cwd(), fsImpl = fs, dotenvImpl = dotenv } = {}) {
  if (configPath) {
    const absoluteConfigPath = path.isAbsolute(configPath)
      ? configPath
      : path.resolve(cwd, configPath);
    const configEnvPath = path.join(path.dirname(absoluteConfigPath), '.env');
    if (fsImpl.existsSync(configEnvPath)) {
      dotenvImpl.config({ path: configEnvPath, override: false });
      return configEnvPath;
    }
  }

  const cwdEnvPath = path.join(cwd, '.env');
  if (fsImpl.existsSync(cwdEnvPath)) {
    dotenvImpl.config({ path: cwdEnvPath, override: false });
    return cwdEnvPath;
  }

  return null;
}
