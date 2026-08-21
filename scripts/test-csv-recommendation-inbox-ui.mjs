import { readFileSync } from 'node:fs';

const ui = readFileSync(new URL('../assets/cloudflare-native-csv-recommendation-inbox-v1.js', import.meta.url), 'utf8');
const loader = readFileSync(new URL('../assets/generated/inline-script-10.js', import.meta.url), 'utf8');

const required = [
  "csv-recommendation-inbox-v1",
  'data-csv-recommendation-inbox-workspace',
  'data-cfri-filter="priority"',
  'data-cfri-filter="candidateType"',
  'data-cfri-filter="lifecycle"',
  'data-cfri-filter="root"',
  'data-cfri-filter="reviewState"',
  'data-cfri-filter="search"',
  'data-cfri-drawer',
  'sourceImportIds',
  'provenanceGate',
  'identityConfidence',
  'governancePersistenceAllowed',
  'executionAuthorized',
  'amazonMutationAuthorized',
  'optimization_actions',
  'optimization_action_events',
  'Session presentation state',
  'never written to D1',
  '/search-term-intelligence?',
];

for (const token of required) {
  if (!ui.includes(token)) throw new Error(`Recommendation Inbox UI missing required contract token: ${token}`);
}

const prohibitedUiControls = [
  '>Apply<',
  '>Execute<',
  '>Push to Amazon<',
  '>Change Bid<',
  '>Add Negative<',
  '>Pause Campaign<',
];
for (const token of prohibitedUiControls) {
  if (ui.includes(token)) throw new Error(`Recommendation Inbox UI exposes prohibited execution control: ${token}`);
}

const prohibitedWrites = [
  /method\s*:\s*['"]POST['"]/u,
  /method\s*:\s*['"]PUT['"]/u,
  /method\s*:\s*['"]PATCH['"]/u,
  /method\s*:\s*['"]DELETE['"]/u,
  /localStorage\s*\.\s*setItem/u,
  /sessionStorage\s*\.\s*setItem/u,
];
for (const pattern of prohibitedWrites) {
  if (pattern.test(ui)) throw new Error(`Recommendation Inbox UI violates read-only/session-only contract: ${pattern}`);
}

if (!loader.includes('assets/cloudflare-native-csv-recommendation-inbox-v1.js?v=1.0.0')) {
  throw new Error('Recommendation Inbox UI loader is not wired into the deployed native shell');
}
if (/https?:\/\//u.test(loader.split('csvRecommendationInboxUiV1')[1] || '')) {
  throw new Error('Recommendation Inbox UI loader must remain same-origin');
}

console.log('csv recommendation inbox operator UI contract: ok');
