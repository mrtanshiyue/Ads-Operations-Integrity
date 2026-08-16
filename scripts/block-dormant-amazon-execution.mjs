const action = String(process.argv[2] || 'amazon-live-execution');

console.error([
  `Amazon live execution remains paused until controlled Store 01 activation is explicitly authorized (${action}).`,
  'Security Integrity and intermediate platform phases do not authorize Amazon credential provisioning, live LWA smoke, report transport, sync-trigger promotion, or sync Worker deployment.',
  'Dormant Amazon helper modules remain under deterministic regression coverage only until the Store 01 read-only activation phase is explicitly opened.',
].join('\n'));

process.exitCode = 1;
