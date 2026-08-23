import { readFileSync } from 'node:fs';

const ui = readFileSync(new URL('../assets/cloudflare-native-csv-recommendation-inbox-v1.js', import.meta.url), 'utf8');
const usability = readFileSync(new URL('../assets/cloudflare-native-csv-recommendation-inbox-usability-v1.js', import.meta.url), 'utf8');
const triage = readFileSync(new URL('../assets/cloudflare-native-csv-recommendation-operator-triage-v1.js', import.meta.url), 'utf8');
const loader = readFileSync(new URL('../assets/generated/inline-script-10.js', import.meta.url), 'utf8');
const allowlist = readFileSync(new URL('./enforce-cloudflare-native-asset-allowlist.mjs', import.meta.url), 'utf8');

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

if (!/const profileId = value\(panel, 'profileId'\);[\s\S]*const scopeKey = \[storeId, profileId, startDate, endDate, limit, sort\]\.join\('\|'\);/u.test(ui)) {
  throw new Error('Recommendation Inbox cache scope must include profileId so cross-profile results cannot reuse stale Inbox state');
}

const usabilityRequired = [
  'cfri:presentation:v1:',
  'PRESENTATION_FILTER_KEYS',
  "'priority'",
  "'candidateType'",
  "'lifecycle'",
  "'root'",
  "'reviewState'",
  "'search'",
  "'sort'",
  'pageSize',
  'data-cfri-page-size',
  'data-cfri-page-previous',
  'data-cfri-page-next',
  'data-cfri-scope-context',
  "scopeCell('Store'",
  "scopeCell('Date range'",
  "scopeCell('Marketplace'",
  "scopeCell('Currency'",
  "scopeCell('Universe'",
  "scopeCell('Candidate emission'",
  'No rows match current filters.',
  'All potential candidates are scope-suppressed.',
  'Recommendation emission is governance-blocked.',
  'No potential recommendation candidate.',
];
for (const token of usabilityRequired) {
  if (!usability.includes(token)) throw new Error(`Recommendation Inbox usability layer missing required token: ${token}`);
}

const triageRequired = [
  'CloudflareCsvRecommendationOperatorTriage',
  'needs_review > stale_review_evidence > unreviewed_critical_high > other_unreviewed > unavailable > acknowledged',
  'data-cfri-operator-triage',
  'data-cfot-order',
  'data-cfot-first-attention',
  'data-cfot-refresh-review',
  'cfhrDurableState',
  'stale prior evidence record',
  'Attention now',
  'Needs review',
  'Stale evidence',
  'High unreviewed',
  'Acknowledged',
  'Snapshot pending',
  'Triage priority',
  'Existing Inbox order',
  'Advisory only.',
  'does not approve, execute, persist Optimization Actions, or authorize any Amazon mutation',
];
for (const token of triageRequired) {
  if (!triage.includes(token)) throw new Error(`Recommendation Inbox operator triage layer missing required token: ${token}`);
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
  if (ui.includes(token) || usability.includes(token) || triage.includes(token)) {
    throw new Error(`Recommendation Inbox UI exposes prohibited execution control: ${token}`);
  }
}

const prohibitedNetworkWrites = [
  /method\s*:\s*['"]POST['"]/u,
  /method\s*:\s*['"]PUT['"]/u,
  /method\s*:\s*['"]PATCH['"]/u,
  /method\s*:\s*['"]DELETE['"]/u,
];
for (const pattern of prohibitedNetworkWrites) {
  if (pattern.test(ui) || pattern.test(usability) || pattern.test(triage)) {
    throw new Error(`Recommendation Inbox presentation layers violate read-only network contract: ${pattern}`);
  }
}

if (/\bfetch\s*\(/u.test(triage)) {
  throw new Error('Operator triage must consume already-rendered governed state and must not create a separate network path');
}
if (/localStorage\s*\??\.\s*setItem/u.test(ui)) {
  throw new Error('Base Recommendation Inbox must not persist state; presentation persistence belongs only to the namespaced usability layer');
}
if (/sessionStorage\s*\??\.\s*setItem/u.test(ui) || /sessionStorage\s*\??\.\s*setItem/u.test(usability) || /sessionStorage\s*\??\.\s*setItem/u.test(triage)) {
  throw new Error('Recommendation Inbox must not persist session review/viewed state to sessionStorage');
}

const persistStart = usability.indexOf('function persistPresentationState()');
const persistEnd = usability.indexOf('function ensurePagination', persistStart);
if (persistStart < 0 || persistEnd <= persistStart) throw new Error('Presentation persistence routine is missing');
const persistSource = usability.slice(persistStart, persistEnd);
if (!/localStorage\?\.setItem\(key, JSON\.stringify\(presentation\)\)/u.test(persistSource)) {
  throw new Error('Presentation persistence must use the store-namespaced presentation object only');
}
for (const prohibited of ['sourceImportIds', 'evidenceSummary', 'recommendationFingerprint', 'executionAuthorized', 'amazonMutationAuthorized', 'viewed']) {
  if (persistSource.includes(prohibited)) throw new Error(`Presentation persistence must not store governed/business state: ${prohibited}`);
}
if (!/const STORAGE_PREFIX = 'cfri:presentation:v1:'/u.test(usability)) {
  throw new Error('Recommendation Inbox presentation persistence must remain explicitly namespaced');
}

const baseAssetPath = 'cloudflare-native-csv-recommendation-inbox-v1.js';
const usabilityAssetPath = 'cloudflare-native-csv-recommendation-inbox-usability-v1.js';
const triageAssetPath = 'cloudflare-native-csv-recommendation-operator-triage-v1.js';
if (!loader.includes(`assets/${baseAssetPath}?v=1.0.0`)) {
  throw new Error('Recommendation Inbox UI loader is not wired into the deployed native shell');
}
if (!loader.includes(`assets/${usabilityAssetPath}?v=1.0.0`)) {
  throw new Error('Recommendation Inbox usability loader is not wired after the base Inbox asset');
}
if (!loader.includes(`assets/${triageAssetPath}?v=1.0.0`)) {
  throw new Error('Recommendation Inbox operator triage loader is not wired after the usability layer');
}
if (!loader.includes("script.addEventListener('load',loadUsability")) {
  throw new Error('Recommendation Inbox usability layer must load only after the base Inbox asset');
}
if (!loader.includes("usability.addEventListener('load',loadTriage")) {
  throw new Error('Operator triage must load only after Recommendation Inbox usability');
}
if (!loader.includes("triage.addEventListener('load',loadRootLifecycle")) {
  throw new Error('Root/Lifecycle usability must remain chained after operator triage');
}
if (/https?:\/\//u.test(loader.split('csvRecommendationInboxUiV1')[1] || '')) {
  throw new Error('Recommendation Inbox UI loaders must remain same-origin');
}
if (!allowlist.includes(`'${baseAssetPath}'`) || !allowlist.includes(`'${usabilityAssetPath}'`) || !allowlist.includes(`'${triageAssetPath}'`)) {
  throw new Error('Recommendation Inbox assets are missing from the explicit Cloudflare Native deployment allowlist');
}

console.log('csv recommendation inbox operator UI usability + triage contract: ok');
