import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { collectFinalClosureEvidence } from './final-closure-control-plane.mjs';

async function main() {
  const outputDir = process.env.FINAL_CLOSURE_OUTPUT_DIR || 'artifacts/final-closure-evidence';
  await fs.mkdir(outputDir, { recursive: true });
  let result;
  try {
    result = await collectFinalClosureEvidence();
  } catch (error) {
    result = {
      schemaVersion: 'final-closure-evidence-orchestrator-v1',
      status: 'blocked',
      generatedAt: new Date().toISOString(),
      blockers: [`collector_error:${String(error?.message || error).replace(/[\r\n]+/gu, ' ').slice(0, 500)}`],
    };
  }

  await fs.writeFile(`${outputDir}/snapshot.json`, `${JSON.stringify(result, null, 2)}\n`);
  if (result.driftReceipt) {
    await fs.writeFile(`${outputDir}/production-drift-receipt.json`, `${JSON.stringify(result.driftReceipt, null, 2)}\n`);
  }
  if (result.productionBaseline) {
    await fs.writeFile(`${outputDir}/production-baseline-v1.json`, `${JSON.stringify(result.productionBaseline, null, 2)}\n`);
  }

  console.log(JSON.stringify({
    status: result.status,
    mainSha: result.mainSha || null,
    blockers: result.blockers,
    outputDir,
  }, null, 2));

  if (String(process.env.FINAL_CLOSURE_STRICT || '').toLowerCase() === 'true' && result.status !== 'ready') {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
