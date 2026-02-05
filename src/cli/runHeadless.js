import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from '../config/manager.js';
import { buildRunEnv } from './runConfig.js';
import { loadEnv } from '../config/envLoader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runHeadless({ configPath = 'config.yaml' } = {}) {
  loadEnv({ configPath });
  const config = loadConfig(configPath);
  const env = buildRunEnv({ config, baseEnv: process.env });
  const entrypoint = path.resolve(__dirname, '../index.js');

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint], { stdio: 'inherit', env });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`run failed: ${code}`))));
  });
}
