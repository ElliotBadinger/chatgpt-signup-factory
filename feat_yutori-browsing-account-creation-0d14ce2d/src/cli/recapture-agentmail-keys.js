/**
 * recapture-agentmail-keys.js
 *
 * Re-authenticates to the AgentMail console for each root account in the inbox pool,
 * captures a fresh API key, queries the inbox list for each root, and updates the
 * pool entries with:
 *   - rootApiKey   (full API key — needed for OTP polling during ChatGPT account creation)
 *   - agentMailInboxId  (the inbox_id returned by GET /v0/inboxes — needed for message polling)
 *
 * Usage:
 *   node src/cli/recapture-agentmail-keys.js [--dry-run] [--root <email>]
 *
 * Without --root, processes all unique roots in the pool.
 * With --root, processes only that root email.
 * With --dry-run, logs what would happen but does not update the pool file.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { createRealStage1LiveHooks } from '../pipeline/bootstrap/realStage1.js';

const POOL_PATH = path.join(os.homedir(), '.pi', 'agent', 'codex-inbox-pool.json');
const AGENTMAIL_INBOXES_URL = 'https://api.agentmail.to/v0/inboxes';

function readPool(poolPath = POOL_PATH) {
  return JSON.parse(fs.readFileSync(poolPath, 'utf8'));
}

function writePool(pool, poolPath = POOL_PATH) {
  const tmp = `${poolPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pool, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, poolPath);
  fs.chmodSync(poolPath, 0o600);
}

async function listAgentMailInboxes(apiKey) {
  const response = await fetch(AGENTMAIL_INBOXES_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`GET /v0/inboxes failed: ${response.status} ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  // AgentMail returns { inboxes: [...] } with inbox_id = email address (the ID IS the address)
  const items = Array.isArray(data) ? data : (data.inboxes ?? data.items ?? data.data ?? []);
  return items;
}

/**
 * Extract the inbox address from an AgentMail inbox item.
 * The AgentMail API uses inbox_id = email address (they are identical).
 */
function extractInboxAddress(item) {
  // inbox_id is the email address in AgentMail's API
  return item.inbox_id ?? item.email_address ?? item.address ?? item.inbox_address ?? null;
}

/**
 * Extract the inbox ID from an AgentMail inbox item.
 * In AgentMail, inbox_id IS the email address.
 */
function extractInboxId(item) {
  return item.inbox_id ?? item.id ?? null;
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { dryRun: false, rootEmails: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') opts.dryRun = true;
    if (argv[i] === '--root') opts.rootEmails.push(argv[++i]);
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

  const pool = readPool();
  const allEntries = pool.entries ?? [];

  // Collect unique root emails to process
  const allRoots = [...new Set(allEntries.map((e) => e.rootEmail))];
  const targetRoots = opts.rootEmails.length > 0 ? opts.rootEmails : allRoots;

  console.log(`[recapture] Processing ${targetRoots.length} root(s): ${targetRoots.join(', ')}`);
  if (opts.dryRun) console.log('[recapture] DRY-RUN mode — pool will not be updated');

  // Capture API keys + inbox IDs for all roots, then update pool once at the end
  const rootData = new Map(); // rootEmail → { apiKey, inboxMap: Map<address, inboxId> }

  for (const rootEmail of targetRoots) {
    console.log(`\n[recapture] === Root: ${rootEmail} ===`);

    const artifactDir = path.join(cwd, 'artifacts', `recapture-${Date.now()}`);
    const hooks = createRealStage1LiveHooks({
      artifactDir,
      cwd,
      inboxCount: 0, // Never create new inboxes during recapture
    });

    // Build a controller object matching what the bootstrap uses
    const controllerId = `controller-${rootEmail.replace(/[@.]/g, '-')}`;
    const controller = { id: controllerId, email: rootEmail };

    try {
      // Step 1: provision (sign in via Clerk + OTP from Cloudflare KV)
      console.log(`[recapture]   Step 1: Signing in to AgentMail console...`);
      const provisionResult = await hooks.createOrRecoverAgentMailController({
        controller,
        store: {},
      });
      console.log(`[recapture]   Sign-in OK. flow=${provisionResult.outcome} url=${provisionResult.finalUrl}`);

      // Step 2: capture API key (navigate to /dashboard/api-keys)
      console.log(`[recapture]   Step 2: Capturing API key...`);
      const captureResult = await hooks.captureApiKey({ controller, store: {} });
      console.log(`[recapture]   API key captured. prefix=${captureResult.apiKeyPrefix} source=${captureResult.source}`);

      const fullApiKey = hooks.getApiKeyForController(controllerId);
      if (!fullApiKey) {
        throw new Error(`getApiKeyForController returned null for ${controllerId}`);
      }
      console.log(`[recapture]   Full key: ${fullApiKey.slice(0, 10)}...`);

      // Step 3: list inboxes to get IDs
      console.log(`[recapture]   Step 3: Listing AgentMail inboxes...`);
      const inboxItems = await listAgentMailInboxes(fullApiKey);
      console.log(`[recapture]   Found ${inboxItems.length} inbox(es)`);

      const inboxMap = new Map();
      for (const item of inboxItems) {
        // inbox_id IS the email address in AgentMail's API
        const id = extractInboxId(item);
        const address = extractInboxAddress(item);
        if (address && id) {
          inboxMap.set(address, id);
          console.log(`[recapture]     ${address} → id=${id}`);
        }
      }

      if (inboxMap.size === 0) {
        console.warn(`[recapture]   WARNING: AgentMail returned 0 parseable inboxes. Raw sample: ${JSON.stringify(inboxItems[0])}`);
      }

      rootData.set(rootEmail, { apiKey: fullApiKey, inboxMap });
    } catch (err) {
      console.error(`[recapture]   ERROR for ${rootEmail}: ${err.message}`);
      console.error(err.stack);
    } finally {
      await hooks.cleanup().catch((e) => console.error(`[recapture]   cleanup error: ${e.message}`));
    }
  }

  // Update pool entries
  if (!opts.dryRun && rootData.size > 0) {
    console.log(`\n[recapture] Updating pool entries for ${rootData.size} root(s)...`);

    let updated = 0;
    for (const entry of allEntries) {
      const data = rootData.get(entry.rootEmail);
      if (!data) continue;

      entry.rootApiKey = data.apiKey;
      const inboxId = data.inboxMap.get(entry.inboxAddress);
      if (inboxId) {
        entry.agentMailInboxId = inboxId;
        updated++;
        console.log(`[recapture]   Updated: ${entry.inboxAddress}  inboxId=${inboxId}`);
      } else {
        console.warn(`[recapture]   WARNING: No inbox ID found for ${entry.inboxAddress}`);
      }
    }

    writePool(pool);
    console.log(`[recapture] Pool updated. ${updated} entries now have rootApiKey + agentMailInboxId.`);
  } else if (opts.dryRun && rootData.size > 0) {
    console.log(`\n[recapture] DRY-RUN: Would update pool entries for ${rootData.size} root(s)`);
    for (const [rootEmail, data] of rootData) {
      const affected = allEntries.filter((e) => e.rootEmail === rootEmail);
      for (const entry of affected) {
        const inboxId = data.inboxMap.get(entry.inboxAddress);
        console.log(`  ${entry.inboxAddress}  → rootApiKey=${data.apiKey.slice(0, 10)}...  inboxId=${inboxId ?? '(not found)'}`);
      }
    }
  } else {
    console.log('[recapture] No data captured — pool not updated.');
  }
}

main().catch((err) => {
  console.error('[recapture] Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
