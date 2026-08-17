// Canonical Cloudflare Native build entrypoint.
// The migration-era implementation still performs source validation, HTML rewrites,
// and compatibility transforms. The final deployment artifact is then constrained
// by an explicit file allowlist so repository assets cannot enter production by accident.

import { access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distIndexPath = path.join(repoRoot, 'dist-cloudflare-native', 'index.html');
const operatorAssetPath = path.join(repoRoot, 'dist-cloudflare-native', 'assets', 'cloudflare-native-operator-workspace-v1.js');
const contextAssetPath = path.join(repoRoot, 'dist-cloudflare-native', 'assets', 'cloudflare-native-operator-context-v1.js');
const decisionAssetPath = path.join(repoRoot, 'dist-cloudflare-native', 'assets', 'cloudflare-native-decision-intelligence-v1.js');
const operatorTag = '<script src="assets/cloudflare-native-operator-workspace-v1.js"></script>';
const contextTag = '<script src="assets/cloudflare-native-operator-context-v1.js"></script>';
const decisionTag = '<script src="assets/cloudflare-native-decision-intelligence-v1.js"></script>';

await import('./build-cloudflare-native-copy-all.mjs');
await access(operatorAssetPath, constants.R_OK);
await access(contextAssetPath, constants.R_OK);
await access(decisionAssetPath, constants.R_OK);

let nativeIndex = await readFile(distIndexPath, 'utf8');
nativeIndex = nativeIndex.replaceAll(operatorTag, '');
nativeIndex = nativeIndex.replaceAll(contextTag, '');
nativeIndex = nativeIndex.replaceAll(decisionTag, '');
if (!/<\/head>/i.test(nativeIndex)) {
  throw new Error('Native artifact is missing </head>; cannot inject Operator Workspace');
}
nativeIndex = nativeIndex.replace(/<\/head>/i, `  ${operatorTag}\n  ${contextTag}\n  ${decisionTag}\n</head>`);
if ((nativeIndex.split(operatorTag).length - 1) !== 1) {
  throw new Error('Operator Workspace must be injected exactly once');
}
if ((nativeIndex.split(contextTag).length - 1) !== 1) {
  throw new Error('Operator Context must be injected exactly once');
}
if ((nativeIndex.split(decisionTag).length - 1) !== 1) {
  throw new Error('Decision Intelligence must be injected exactly once');
}
if (nativeIndex.indexOf(operatorTag) > nativeIndex.indexOf(contextTag)) {
  throw new Error('Operator Context must load after Operator Workspace');
}
if (nativeIndex.indexOf(contextTag) > nativeIndex.indexOf(decisionTag)) {
  throw new Error('Decision Intelligence must load after Operator Context');
}
await writeFile(distIndexPath, nativeIndex, 'utf8');

await import('./enforce-cloudflare-native-asset-allowlist.mjs');
await import('./test-operator-workspace-contract.mjs');
await import('./test-operator-context-contract.mjs');
await import('./test-decision-intelligence-contract.mjs');
