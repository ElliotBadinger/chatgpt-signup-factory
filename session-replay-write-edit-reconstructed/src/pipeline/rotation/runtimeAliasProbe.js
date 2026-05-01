import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { createBrowserlessWorkspaceClient } from './browserlessWorkspaceClient.js';

function defaultAuthLoader(authJsonPath) {
  return () => {
    try {
      return JSON.parse(fs.readFileSync(authJsonPath, 'utf8'));
    } catch {
      return {};
    }
  };
}

function defaultAccountRouterExtensionPath() {
  return path.join(os.homedir(), '.pi', 'agent', 'extensions', 'account-router', 'index.ts');
}

function parseProbeEvents(events = []) {
  for (const event of events) {
    if (event && event.type === 'error') {
      return {
        ok: false,
        errorText: typeof event.error?.errorMessage === 'string' ? event.error.errorMessage : 'error',
        providerError: event.error?.providerError ?? undefined,
      };
    }
  }

  for (const event of events) {
    if (event && event.type === 'message_end' && event.message?.role === 'assistant') {
      const stopReason = event.message?.stopReason;
      if ((stopReason === 'error' || stopReason === 'aborted') && typeof event.message?.errorMessage === 'string') {
        return {
          ok: false,
          errorText: event.message.errorMessage,
        };
      }
    }
  }

  return { ok: true };
}

async function runPiProbe({
  aliasId,
  modelId = 'gpt-5.4',
  timeoutMs = 45_000,
  piBin = process.env.PI_ACCOUNT_ROUTER_PI_BIN || process.env.PI_SUBAGENT_CHILD_PI_BIN || 'pi',
  accountRouterExtensionPath = defaultAccountRouterExtensionPath(),
  codingAgentDir = path.join(os.homedir(), '.pi', 'agent'),
  routerPath = null,
  healthPath = null,
} = {}) {
  if (!aliasId) {
    throw new Error('runPiProbe requires aliasId');
  }

  const args = [
    '--mode', 'json',
    '-p',
    '--no-session',
    '--no-tools',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--provider', aliasId,
    '--model', modelId,
    '--thinking', 'off',
    '--system-prompt', 'Reply with a single token: OK. Do not use tools.',
    '-e', accountRouterExtensionPath,
    'probe',
  ];

  const env = {
    ...process.env,
    PI_ACCOUNT_ROUTER_PROBE_CHILD: '1',
    PI_ACCOUNT_ROUTER_PROBE_TOKEN: 'account-router',
    PI_CODING_AGENT_DIR: codingAgentDir,
    ...(routerPath ? { PI_ACCOUNT_ROUTER_CONFIG_PATH: routerPath } : {}),
    ...(healthPath ? { PI_ACCOUNT_ROUTER_HEALTH_PATH: healthPath } : {}),
  };

  return await new Promise((resolve, reject) => {
    const child = spawn(piBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    const events = [];
    let stdoutBuffer = '';
    let stderr = '';
    let settled = false;

    const finish = (result, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };

    child.on('error', (error) => finish(null, error));

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += String(chunk ?? '');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          // ignore malformed non-json probe output
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk ?? '');
    });

    child.on('close', (code, signal) => {
      const trailing = stdoutBuffer.trim();
      if (trailing) {
        try {
          events.push(JSON.parse(trailing));
        } catch {
          // ignore malformed trailing output
        }
      }
      const parsed = parseProbeEvents(events);
      finish({
        ok: parsed.ok === true,
        errorText: parsed.ok === true ? null : parsed.errorText,
        providerError: parsed.providerError ?? null,
        exitCode: code,
        signal,
        stderr: stderr.trim() || null,
        eventCount: events.length,
      });
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish({
        ok: false,
        errorText: `pi probe timed out after ${timeoutMs}ms`,
        providerError: null,
        exitCode: null,
        signal: 'SIGKILL',
        stderr: stderr.trim() || null,
        eventCount: events.length,
      });
    }, timeoutMs);
    timer.unref?.();
  });
}

export function createRuntimeVerifiedAliasProbe({
  authJsonPath = null,
  healthPath = null,
  routerPath = null,
  authLoader = authJsonPath ? defaultAuthLoader(authJsonPath) : () => ({}),
  workspaceClientFactory = createBrowserlessWorkspaceClient,
  probeRunner = runPiProbe,
  probeModelId = 'gpt-5.4',
  probeTimeoutMs = 45_000,
  piBin,
  accountRouterExtensionPath,
} = {}) {
  return async function probeVerifiedAlias({ aliasId, auth = null } = {}) {
    const authData = authLoader() ?? {};
    const resolvedAuth = auth ?? authData?.[aliasId] ?? null;
    if (!resolvedAuth?.access) {
      return {
        ok: false,
        blockerReason: 'verification-probe-not-configured',
        reason: `No runtime auth available for ${aliasId ?? 'unknown-alias'}`,
        source: 'browserless-runtime-probe',
      };
    }

    try {
      const client = workspaceClientFactory({
        accessToken: resolvedAuth.access,
        accountId: resolvedAuth.accountId ?? null,
      });
      const [me, accounts, consent, probe] = await Promise.all([
        client.getMe({ accountIdOverride: resolvedAuth.accountId ?? null }),
        client.getAccounts({ accountIdOverride: resolvedAuth.accountId ?? null }),
        client.getUserGranularConsent({ accountIdOverride: resolvedAuth.accountId ?? null }).catch(() => null),
        probeRunner({
          aliasId,
          modelId: probeModelId,
          timeoutMs: probeTimeoutMs,
          piBin,
          accountRouterExtensionPath,
          codingAgentDir: authJsonPath ? path.dirname(authJsonPath) : path.join(os.homedir(), '.pi', 'agent'),
          routerPath,
          healthPath,
        }),
      ]);

      const codexUsabilityVerified = probe?.ok === true;
      return {
        ok: Boolean(me?.email) && Array.isArray(accounts?.items) && codexUsabilityVerified,
        source: 'browserless-runtime-probe',
        meEmail: me?.email ?? null,
        accountCount: Array.isArray(accounts?.items) ? accounts.items.length : 0,
        granularConsentObserved: consent != null,
        codexUsabilityVerified,
        quotaSource: codexUsabilityVerified ? 'live-pi-probe' : 'live-pi-probe-failed',
        liveProbe: probe,
        blockerReason: codexUsabilityVerified ? null : 'live-codex-probe-failed',
        reason: codexUsabilityVerified ? 'verified' : (probe?.errorText ?? 'live pi probe failed'),
      };
    } catch (error) {
      return {
        ok: false,
        blockerReason: 'live-browserless-probe-failed',
        reason: String(error?.message ?? error),
        source: 'browserless-runtime-probe',
      };
    }
  };
}

export { runPiProbe };
