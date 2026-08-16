const target = String(process.argv[2] || 'unknown');

console.error([
  `Direct Cloudflare deployment is disabled during Architecture Convergence Phase 0 (${target}).`,
  'Do not run wrangler deploy from repository npm scripts.',
  'Deployment must remain CI-gated and exact-commit controlled through the approved Cloudflare deployment path.',
].join('\n'));

process.exitCode = 1;
