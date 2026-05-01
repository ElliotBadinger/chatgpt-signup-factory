#!/usr/bin/env node
import { analyzeOpenAiAuthTelemetry } from '../pipeline/authTrace/openaiAuthTelemetryAnalysis.js';

export function parseOpenAiReportArgs(argv = process.argv.slice(2)) {
  let traceDir = null;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--trace-dir' && argv[index + 1]) {
      traceDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (argv[index] === '--dry-run') dryRun = true;
  }
  return { traceDir, dryRun };
}

async function main() {
  const args = parseOpenAiReportArgs();
  if (!args.traceDir) {
    console.error('Usage: pipeline-auth-openai-report --trace-dir <path> [--dry-run]');
    process.exit(1);
  }

  const result = await analyzeOpenAiAuthTelemetry(args.traceDir, { dryRun: args.dryRun });
  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
}

if (process.argv[1]?.endsWith('pipeline-auth-openai-report.js')) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
