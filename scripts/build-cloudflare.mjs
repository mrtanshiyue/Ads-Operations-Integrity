// Architecture Convergence compatibility shim.
// The repository-level `npm run build` still points at this historical filename,
// but the only canonical build is now the Cloudflare Native artifact builder.
// The previous Warehouse/Pages builder is preserved under docs/archive/legacy-github-pages/.

console.log('Canonical build: scripts/build-cloudflare-native.mjs');
await import('./build-cloudflare-native.mjs');
