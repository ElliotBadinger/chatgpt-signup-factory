#!/usr/bin/env node
import { analyzeAgentBrowserTelemetry } from '../pipeline/authTrace/agentBrowserTelemetryAnalysis.js';

export function parseAgentBrowserReportArgs(argv = process.argv.slice(2)) {
  let runDir = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--run-dir' && argv[i + 1]) {
      runDir = argv[i + 1];
      i++;
      continue;
    }
    if (argv[i] === '--dry-run') dryRun = true;
  }
  return { runDir, dryRun };
}

async function main() {
  const args = parseAgentBrowserReportArgs();
  if (!args.runDir) {
    console.error('Usage: pipeline-auth-agent-browser-report --run-dir <path> [--dry-run]');
    process.exit(1);
  }
  const result = await analyzeAgentBrowserTelemetry(args.runDir, { dryRun: args.dryRun });
  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
}

if (process.argv[1]?.endsWith('pipeline-auth-agent-browser-report.js')) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
