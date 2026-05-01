#!/usr/bin/env node

import { checkBrowserlessNetwork } from '../pipeline/net/browserlessNetworkPreflight.js';

const result = await checkBrowserlessNetwork();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.ok ? 0 : 1);
