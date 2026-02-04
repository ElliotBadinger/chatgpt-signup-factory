import { spawn } from 'node:child_process';
import { loadConfig } from '../config/manager.js';
import { buildRunEnv } from './runConfig.js';

export async function runHeadless({ configPath = 'config.yaml' } = {}) {
  const config = loadConfig(configPath);
  const env = buildRunEnv({ config, baseEnv: process.env });

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/index.js'], { stdio: 'inherit', env });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`run failed: ${code}`))));
  });
}
