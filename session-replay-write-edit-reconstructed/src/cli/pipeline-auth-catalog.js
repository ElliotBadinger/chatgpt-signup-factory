import { runCatalogAnalysis } from '../pipeline/authTrace/runCatalogAnalysis.js';

export function parseArgs(argv = process.argv.slice(2)) {
  let traceDir = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--trace-dir' && argv[i + 1]) {
      traceDir = argv[i + 1];
      i++;
      continue;
    }
    if (argv[i] === '--dry-run') dryRun = true;
  }
  return { traceDir, dryRun };
}

export function buildCliConfig(parsed) {
  return { traceDir: parsed.traceDir, dryRun: parsed.dryRun ?? false };
}

async function main() {
  const args = parseArgs();
  const cfg = buildCliConfig(args);

  if (!cfg.traceDir) {
    console.error('Usage: pipeline-auth-catalog --trace-dir <path> [--dry-run]');
    process.exit(1);
  }

  console.log(`Analyzing trace dir: ${cfg.traceDir}`);
  const result = await runCatalogAnalysis(cfg.traceDir, { dryRun: cfg.dryRun });

  const totalEndpoints = result.endpointCatalog.length;
  const byClass = {};
  for (const c of result.replayCandidates) {
    byClass[c.replayClassification] = (byClass[c.replayClassification] ?? 0) + 1;
  }

  console.log('\n=== Auth Catalog Summary ===');
  console.log(`Total endpoints cataloged: ${totalEndpoints}`);
  for (const [cls, count] of Object.entries(byClass)) {
    console.log(`  ${cls}: ${count}`);
  }
  console.log(`\nFirst auth-side request: ${result.analysis.firstAuthSideSessionRequest?.url ?? 'none'}`);
  console.log(`First access-token response: ${result.analysis.firstAccessTokenRequest?.url ?? 'none'}`);
  console.log(`Browser-bound endpoints: ${result.analysis.browserBoundEndpoints.length}`);
  console.log(`Direct replay candidates: ${result.analysis.likelyReplayCandidates.length}`);

  if (!cfg.dryRun) {
    console.log(`\nArtifacts written to: ${cfg.traceDir}`);
    console.log('  endpoint-catalog.json');
    console.log('  flow-sequence.json');
    console.log('  cookie-evolution.json');
    console.log('  replay-candidates.json');
    console.log('  analysis.json');
  }
}

if (process.argv[1]?.endsWith('pipeline-auth-catalog.js')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
