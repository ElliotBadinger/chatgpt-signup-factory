#!/usr/bin/env node
/**
 * server.js — HTTP server for Ink cloud deployment.
 *
 * Exposes:
 *   GET  /health            → { ok: true, uptime, browserBackend }
 *   POST /create-account    → { success, auth?, error? }
 *
 * Environment variables:
 *   PORT                    (default 3000)
 *   BROWSER_WS_ENDPOINT     ws:// or wss:// URL (lightpanda cloud or remote Chrome)
 *                           e.g. wss://cloud.lightpanda.io/ws?token=TOKEN
 *   LIGHTPANDA_WS_URL       Alias for BROWSER_WS_ENDPOINT
 *   LIGHTPANDA_AUTO         If 'true', download + launch lightpanda binary locally.
 *                           Auto-detected when no BROWSER_WS_ENDPOINT is set.
 *   LIGHTPANDA_VERSION      Binary version to download (default: v0.2.6)
 *
 * Browser backend priority:
 *   1. BROWSER_WS_ENDPOINT set → connect to remote browser
 *   2. LIGHTPANDA_AUTO=true    → download lightpanda binary + start CDP server
 *   3. Fallback                → try bundled puppeteer Chromium (requires puppeteer pkg)
 *
 * Concurrency: one in-flight browser session at a time (mutex queue).
 * Each session is opened and closed per request — no state leakage between accounts.
 *
 * Deployment to Ink free tier (256Mi/0.25vCPU):
 *   Uses lightpanda instead of Chrome — 10x lighter, ~50MB runtime memory.
 *   ink deploy codex-account-creator --repo codex-account-creator --port 3000
 */

import express from 'express';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, chmodSync, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';

import { createChatGptAccount } from './pipeline/rotation/chatGptAccountCreator.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const LIGHTPANDA_VERSION = process.env.LIGHTPANDA_VERSION ?? 'v0.2.6';
const LIGHTPANDA_BIN = join(tmpdir(), `lightpanda-${LIGHTPANDA_VERSION}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Effective WS endpoint (may be set later after lightpanda starts)
let effectiveBrowserWs = process.env.BROWSER_WS_ENDPOINT
  ?? process.env.LIGHTPANDA_WS_URL
  ?? null;

// ── Lightpanda auto-launch ────────────────────────────────────────────────────────
let lightpandaProc = null;

async function ensureLightpanda() {
  if (effectiveBrowserWs) return; // already configured

  console.log('[server] No BROWSER_WS_ENDPOINT set. Auto-launching lightpanda...');

  // Download binary if not present (streaming to avoid loading 106MB into memory at once)
  if (!existsSync(LIGHTPANDA_BIN)) {
    const url = `https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/lightpanda-x86_64-linux`;
    console.log(`[server] Downloading lightpanda ${LIGHTPANDA_VERSION} (streaming)...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download lightpanda: ${res.status} ${url}`);
    // Stream to disk — avoids Buffer.from(entire 106MB) OOM in constrained containers
    const fileStream = createWriteStream(LIGHTPANDA_BIN);
    await pipeline(res.body, fileStream);
    chmodSync(LIGHTPANDA_BIN, 0o755);
    console.log(`[server] lightpanda downloaded to ${LIGHTPANDA_BIN}`);
  } else {
    console.log(`[server] lightpanda binary at ${LIGHTPANDA_BIN}`);
  }

  // Start CDP server
  const LP_PORT = 9222;
  lightpandaProc = spawn(LIGHTPANDA_BIN, ['serve', '--host', '127.0.0.1', '--port', String(LP_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  lightpandaProc.stdout.on('data', (d) => process.stdout.write(`[lightpanda] ${d}`));
  lightpandaProc.stderr.on('data', (d) => process.stderr.write(`[lightpanda] ${d}`));
  lightpandaProc.on('exit', (code) => {
    console.log(`[lightpanda] exited with code ${code}`);
    lightpandaProc = null;
  });

  // Wait for CDP server to be ready (poll ws connection)
  const wsUrl = `ws://127.0.0.1:${LP_PORT}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const b = await puppeteer.connect({ browserWSEndpoint: wsUrl });
      await b.disconnect();
      break;
    } catch {
      await sleep(500);
    }
  }

  effectiveBrowserWs = wsUrl;
  console.log(`[server] lightpanda CDP ready at ${wsUrl}`);
}

process.on('exit', () => { if (lightpandaProc) lightpandaProc.kill(); });
process.on('SIGTERM', () => { if (lightpandaProc) lightpandaProc.kill(); process.exit(0); });

// ── Browser session factory ───────────────────────────────────────────────────────

async function openBrowserPage() {
  if (!effectiveBrowserWs) {
    throw new Error(
      'No browser endpoint available. Set BROWSER_WS_ENDPOINT, LIGHTPANDA_WS_URL, ' +
      'or ensure lightpanda auto-launch completed successfully.',
    );
  }

  // Connect to remote browser via CDP WebSocket.
  // Lightpanda v0.2.x: each connection gets its own full browser with 1 context/1 page.
  // We MUST use createBrowserContext() + newPage() per lightpanda's API contract.
  // The TID-STARTUP / FID-STARTUP frames appear when browser.pages() is called before
  // any real page is created — avoid browser.pages() entirely.
  console.log(`[server] Connecting: ${effectiveBrowserWs.slice(0, 80)}...`);
  const browser = await puppeteer.connect({ browserWSEndpoint: effectiveBrowserWs });

  // Create a fresh page in a new context
  // (lightpanda docs: https://lightpanda.io/docs/getting-started/usage#connect-with-puppeteer)
  let page;
  try {
    const ctx = await browser.createBrowserContext();
    page = await ctx.newPage();
  } catch (ctxErr) {
    // createBrowserContext not available in this lightpanda version — fall back to newPage()
    console.warn(`[server] createBrowserContext failed (${ctxErr.message}), falling back to newPage()`);
    page = await browser.newPage();
  }
  await applyStealthPatches(page);

  const cleanup = async () => {
    try { await page.close(); } catch {}
    try { await browser.disconnect(); } catch {}
  };
  return { page, cleanup };
}

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

async function applyStealthPatches(page) {
  try { await page.setUserAgent(USER_AGENT); } catch {}
  try { await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en' }); } catch {}
  try { await page.emulateTimezone('America/Los_Angeles'); } catch {}
  try {
    await page.evaluateOnNewDocument(() => {
      try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
      try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); } catch {}
      try { Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' }); } catch {}
      try { window.chrome = window.chrome || { runtime: {} }; } catch {}
      try {
        const origQuery = window.navigator.permissions?.query;
        if (origQuery) {
          window.navigator.permissions.query = (p) =>
            p.name === 'notifications'
              ? Promise.resolve({ state: Notification.permission })
              : origQuery(p);
        }
      } catch {}
    });
  } catch {}
}

// ── Request mutex (one browser session at a time) ────────────────────────────────

let busy = false;
const queue = [];

function withMutex(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    if (!busy) drainQueue();
  });
}

async function drainQueue() {
  if (queue.length === 0) { busy = false; return; }
  busy = true;
  const { fn, resolve, reject } = queue.shift();
  try {
    resolve(await fn());
  } catch (e) {
    reject(e);
  } finally {
    drainQueue();
  }
}

// ── Express app ──────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    browserBackend: effectiveBrowserWs ?? 'not-ready',
    lightpandaRunning: lightpandaProc !== null,
  });
});

/**
 * POST /create-account
 * Body: {
 *   email:           string  — AgentMail inbox address
 *   apiKey:          string  — AgentMail root API key
 *   inboxId?:        string  — defaults to email
 *   timeoutMs?:      number  — default 300000
 *   pollIntervalMs?: number  — default 5000
 * }
 * Response: { success, auth?, error? }
 */
app.post('/create-account', async (req, res) => {
  const { email, apiKey, inboxId, timeoutMs = 300_000, pollIntervalMs = 5_000 } = req.body ?? {};

  if (!email || !apiKey) {
    return res.status(400).json({ success: false, error: 'email and apiKey are required' });
  }

  console.log(`[server] /create-account → ${email}`);

  try {
    const result = await withMutex(async () => {
      const { page, cleanup } = await openBrowserPage();
      try {
        return await createChatGptAccount(page, {
          email,
          agentMailApiKey: apiKey,
          agentMailInboxId: inboxId ?? email,
          agentMailTimeoutMs:     timeoutMs,
          agentMailPollIntervalMs: pollIntervalMs,
          navigationDelayMs:      3_000,
          pageStateCheckRetries:  6,
          pageStateCheckIntervalMs: 2_000,
          // No teamInviteCallback — caller handles team invite separately
        });
      } finally {
        await cleanup();
      }
    });
    console.log(`[server] /create-account → ${email} → ${result.success ? 'OK' : result.error}`);
    res.json(result);
  } catch (e) {
    console.error(`[server] /create-account → ${email} → ERROR: ${e.message}`);
    res.status(500).json({ success: false, error: String(e.message ?? e) });
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────────
const httpServer = createServer(app);
httpServer.listen(PORT, async () => {
  console.log(`[server] Listening on :${PORT}`);
  try {
    await ensureLightpanda();
    console.log(`[server] Browser backend ready: ${effectiveBrowserWs ?? 'none'}`);
  } catch (e) {
    console.error(`[server] Browser startup error: ${e.message}`);
    console.error('[server] WARNING: /create-account will fail until browser is available');
  }
});
