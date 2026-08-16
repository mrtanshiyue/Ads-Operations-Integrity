const action = String(process.argv[2] || 'amazon-live-execution');

console.error([
  `Amazon live execution is paused during Architecture Convergence Phase 0 (${action}).`,
  'Do not provision Amazon credentials, run live LWA credential smoke, promote the sync deployment trigger, or deploy the sync Worker.',
  'Dormant Amazon helper modules remain under deterministic regression coverage only until the Amazon integration phase is explicitly resumed.',
].join('\n'));

process.exitCode = 1;
