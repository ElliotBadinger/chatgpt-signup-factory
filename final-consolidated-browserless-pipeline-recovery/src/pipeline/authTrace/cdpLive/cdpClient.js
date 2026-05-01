import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFile = promisify(execFileCb);
const CDP_SCRIPT = path.resolve(process.cwd(), '.vendor/chrome-cdp-skill/skills/chrome-cdp/scripts/cdp.mjs');

export async function runCdpCommand({ args, cdpPort = null, cdpWsUrl = null }, deps = {}) {
  const run = deps.execFile ?? execFile;
  const env = {
    ...process.env,
    ...(cdpPort != null ? { CDP_PORT: String(cdpPort) } : {}),
    ...(cdpWsUrl ? { CDP_WS_URL: cdpWsUrl } : {}),
  };
  const result = await run('node', [CDP_SCRIPT, ...args], { cwd: process.cwd(), env });
  return result.stdout ?? '';
}

export function parseCdpList(stdout) {
  return String(stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\S+)\s{2,}(.*?)\s{2,}(https?:\/\/\S+)$/);
      if (!match) return null;
      return { targetIdPrefix: match[1], title: match[2].trim(), url: match[3] };
    })
    .filter(Boolean);
}

export function selectTargetFromPages(pages, explicitTarget = null) {
  if (explicitTarget) {
    const matches = pages.filter((p) => p.targetIdPrefix.toUpperCase().startsWith(explicitTarget.toUpperCase()));
    if (matches.length !== 1) throw new Error(`Target prefix \"${explicitTarget}\" is ambiguous or missing`);
    return matches[0];
  }

  const candidates = pages.filter((p) => /auth\.openai\.com|chatgpt\.com/.test(p.url));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) throw new Error('No auth/chatgpt page found in live Chrome tabs');
  throw new Error(`Ambiguous auth/chatgpt target selection (${candidates.length} candidates)`);
}
