import { spawn as defaultSpawn } from 'node:child_process';

export async function launchMitmproxy(opts = {}, deps = {}) {
  const {
    port = 8899,
    addonPath,
    flowsPath,
    binary = 'mitmdump',
  } = opts;
  const spawn = deps.spawn ?? defaultSpawn;

  const child = spawn(
    binary,
    ['-p', String(port), '-s', addonPath, '--set', `pi_flows_path=${flowsPath}`],
    { stdio: 'pipe' },
  );

  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });

  return {
    port,
    process: child,
    async cleanup() {
      child.kill('SIGTERM');
    },
  };
}
