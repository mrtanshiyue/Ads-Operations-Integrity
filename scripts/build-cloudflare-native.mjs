// Canonical Cloudflare Native build entrypoint.
// The migration-era implementation still performs source validation, HTML rewrites,
// and compatibility transforms. The final deployment artifact is then constrained
// by an explicit file allowlist so repository assets cannot enter production by accident.

await import('./build-cloudflare-native-copy-all.mjs');
await import('./enforce-cloudflare-native-asset-allowlist.mjs');
