import { canonicalJson } from './csv-analysis-engine/canonical-json.js';
import {
  serializeCsvHistoryLedger,
  validateCsvHistoryLedger,
} from './csv-analysis-engine/csv-history-ledger.js';
import {
  buildHistoricalComparisonReceipt,
  parseHistoricalComparisonReceipt,
  serializeHistoricalComparisonReceipt,
  validateHistoricalComparisonReceipt,
} from './cloudflare-native-csv-history-comparison-receipt-v1.js';

export const CSV_HISTORY_COMPARISON_RECEIPT_VERIFICATION_SCHEMA_VERSION = 'csv-history-comparison-receipt-verification-v1';
export const CSV_HISTORY_COMPARISON_RECEIPT_VERIFICATION_UI_VERSION = '1.0.0';
export const CSV_HISTORY_AUDIT_PACKAGE_SCHEMA_VERSION = 'csv-history-audit-package-v1';
export const CSV_HISTORY_AUDIT_PACKAGE_VERIFICATION_SCHEMA_VERSION = 'csv-history-audit-package-verification-v1';
export const CSV_HISTORY_AUDIT_PACKAGE_INDEX_SCHEMA_VERSION = 'csv-history-audit-package-index-v1';

const REQUIRED_AUDIT_PATHS = Object.freeze([
  'history-ledger.json',
  'historical-comparison-receipt.json',
  'comparison-verification.json',
]);
const REQUIRED_ARCHIVE_PATHS = Object.freeze(['manifest.json', ...REQUIRED_AUDIT_PATHS]);
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORE_METHOD = 0;
const ZIP_DOS_TIME = 0;
const ZIP_DOS_DATE = 0x0021;

const state = {
  mounted: false,
  busy: false,
  ledger: null,
  receipt: null,
  verification: null,
  auditZipBytes: null,
  auditIndexZipInputs: [],
  ledgerFileName: null,
  receiptFileName: null,
};

export async function verifyHistoricalComparisonReceiptAgainstLedger(ledger, receipt) {
  const validatedLedger = await validateCsvHistoryLedger(ledger);
  const validatedReceipt = await validateHistoricalComparisonReceipt(receipt);
  if (validatedLedger.ledgerFingerprint !== validatedReceipt.source.ledgerFingerprint) {
    throw verificationError('CSV_HISTORY_COMPARISON_RECEIPT_LEDGER_FINGERPRINT_MISMATCH');
  }

  const recomputed = await buildHistoricalComparisonReceipt(
    validatedLedger,
    validatedReceipt.source.periodAEvidenceKey,
    validatedReceipt.source.periodBEvidenceKey,
  );
  if (recomputed.receiptFingerprint !== validatedReceipt.receiptFingerprint) {
    throw verificationError('CSV_HISTORY_COMPARISON_RECEIPT_REPLAY_FINGERPRINT_MISMATCH');
  }
  const originalSerialized = serializeHistoricalComparisonReceipt(validatedReceipt);
  const recomputedSerialized = serializeHistoricalComparisonReceipt(recomputed);
  if (originalSerialized !== recomputedSerialized) {
    throw verificationError('CSV_HISTORY_COMPARISON_RECEIPT_REPLAY_SERIALIZATION_MISMATCH');
  }

  return deepFreeze({
    schemaVersion: CSV_HISTORY_COMPARISON_RECEIPT_VERIFICATION_SCHEMA_VERSION,
    verificationState: 'verified_against_local_ledger',
    receiptFingerprint: validatedReceipt.receiptFingerprint,
    recomputedReceiptFingerprint: recomputed.receiptFingerprint,
    ledgerFingerprint: validatedLedger.ledgerFingerprint,
    periodAEvidenceKey: validatedReceipt.source.periodAEvidenceKey,
    periodBEvidenceKey: validatedReceipt.source.periodBEvidenceKey,
    comparisonAllowed: validatedReceipt.comparison.comparisonAllowed,
    rawEvidenceOnly: validatedReceipt.comparison.rawEvidenceOnly,
    receiptSerializationMatch: true,
    receiptFingerprintMatch: true,
    generatedTimestampIncluded: false,
    replayedFromExplicitLocalLedger: true,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    crossSnapshotAggregationApplied: false,
    normalizationApplied: false,
    authority: noAuthority(),
  });
}

export async function buildHistoricalAuditPackage(ledger, receipt) {
  const validatedLedger = await validateCsvHistoryLedger(ledger);
  const validatedReceipt = await validateHistoricalComparisonReceipt(receipt);
  const verification = await verifyHistoricalComparisonReceiptAgainstLedger(validatedLedger, validatedReceipt);

  const files = Object.freeze([
    await auditFile('history-ledger.json', validatedLedger.schemaVersion, serializeCsvHistoryLedger(validatedLedger)),
    await auditFile('historical-comparison-receipt.json', validatedReceipt.schemaVersion, serializeHistoricalComparisonReceipt(validatedReceipt)),
    await auditFile('comparison-verification.json', verification.schemaVersion, serializeVerificationEvidence(verification)),
  ]);

  const manifestPayload = {
    schemaVersion: CSV_HISTORY_AUDIT_PACKAGE_SCHEMA_VERSION,
    packageSchema: CSV_HISTORY_AUDIT_PACKAGE_SCHEMA_VERSION,
    packagePurpose: 'portable_immutable_local_historical_audit_material',
    ledgerSchema: validatedLedger.schemaVersion,
    ledgerFingerprint: validatedLedger.ledgerFingerprint,
    comparisonReceiptSchema: validatedReceipt.schemaVersion,
    comparisonReceiptFingerprint: validatedReceipt.receiptFingerprint,
    verificationSchema: verification.schemaVersion,
    verificationStatus: verification.verificationState,
    periodAEvidenceKey: verification.periodAEvidenceKey,
    periodBEvidenceKey: verification.periodBEvidenceKey,
    comparisonAllowed: verification.comparisonAllowed,
    rawEvidenceOnly: verification.rawEvidenceOnly,
    entries: files.map(({ path, schema, contentSha256 }) => ({ path, schema, contentSha256 })),
    deterministic: {
      generatedTimestampIncluded: false,
      entryOrder: [...REQUIRED_AUDIT_PATHS],
      packageFingerprintBasis: 'canonical_manifest_without_package_fingerprint',
      archiveFormat: 'zip_store_utf8',
    },
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    authority: noAuthority(),
  };
  const packageFingerprint = await sha256Hex(canonicalJson(manifestPayload));
  const manifest = deepFreeze({ ...manifestPayload, packageFingerprint });
  const artifact = deepFreeze({
    schemaVersion: CSV_HISTORY_AUDIT_PACKAGE_SCHEMA_VERSION,
    packageFingerprint,
    manifest,
    manifestText: serializeAuditManifest(manifest),
    files,
  });
  await validateHistoricalAuditPackageArtifact(artifact);
  return artifact;
}

export async function validateHistoricalAuditPackageArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INVALID');
  if (artifact.schemaVersion !== CSV_HISTORY_AUDIT_PACKAGE_SCHEMA_VERSION) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_SCHEMA_UNSUPPORTED');
  const manifest = artifact.manifest;
  if (!manifest || manifest.schemaVersion !== CSV_HISTORY_AUDIT_PACKAGE_SCHEMA_VERSION || manifest.packageSchema !== CSV_HISTORY_AUDIT_PACKAGE_SCHEMA_VERSION) {
    throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_MANIFEST_SCHEMA_UNSUPPORTED');
  }
  assertAuditBoundary(manifest);
  assertSha256(manifest.packageFingerprint, 'CSV_HISTORY_AUDIT_PACKAGE_FINGERPRINT_INVALID');
  if (artifact.packageFingerprint !== manifest.packageFingerprint) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_FINGERPRINT_BINDING_MISMATCH');
  if (artifact.manifestText !== serializeAuditManifest(manifest)) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_MANIFEST_SERIALIZATION_MISMATCH');

  const files = Array.isArray(artifact.files) ? artifact.files : [];
  if (files.length !== REQUIRED_AUDIT_PATHS.length) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_REQUIRED_ENTRY_MISSING');
  const fileMap = new Map();
  for (const file of files) {
    const path = String(file?.path || '');
    if (!REQUIRED_AUDIT_PATHS.includes(path)) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ENTRY_PATH_UNSUPPORTED');
    if (fileMap.has(path)) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_DUPLICATE_ENTRY_PATH');
    assertSha256(file?.contentSha256, 'CSV_HISTORY_AUDIT_PACKAGE_ENTRY_SHA256_INVALID');
    if (await sha256Hex(String(file?.text ?? '')) !== String(file.contentSha256).toLowerCase()) {
      throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ENTRY_HASH_MISMATCH');
    }
    fileMap.set(path, file);
  }
  for (const path of REQUIRED_AUDIT_PATHS) if (!fileMap.has(path)) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_REQUIRED_ENTRY_MISSING');

  const manifestEntries = Array.isArray(manifest.entries) ? manifest.entries : [];
  if (manifestEntries.length !== REQUIRED_AUDIT_PATHS.length) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_MANIFEST_ENTRY_SET_INVALID');
  const manifestMap = new Map();
  for (const entry of manifestEntries) {
    const path = String(entry?.path || '');
    if (!REQUIRED_AUDIT_PATHS.includes(path) || manifestMap.has(path)) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_MANIFEST_ENTRY_SET_INVALID');
    assertSha256(entry?.contentSha256, 'CSV_HISTORY_AUDIT_PACKAGE_ENTRY_SHA256_INVALID');
    manifestMap.set(path, entry);
  }
  for (const path of REQUIRED_AUDIT_PATHS) {
    const file = fileMap.get(path);
    const entry = manifestMap.get(path);
    if (!entry || entry.schema !== file.schema || entry.contentSha256 !== file.contentSha256) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ENTRY_BINDING_MISMATCH');
  }

  let ledgerRaw;
  try { ledgerRaw = JSON.parse(fileMap.get('history-ledger.json').text); }
  catch { throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_LEDGER_JSON_INVALID'); }
  const validatedLedger = await validateCsvHistoryLedger(ledgerRaw);
  const validatedReceipt = await parseHistoricalComparisonReceipt(fileMap.get('historical-comparison-receipt.json').text);
  const replayedVerification = await verifyHistoricalComparisonReceiptAgainstLedger(validatedLedger, validatedReceipt);
  const replayedVerificationText = serializeVerificationEvidence(replayedVerification);
  if (replayedVerificationText !== fileMap.get('comparison-verification.json').text) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_VERIFICATION_REPLAY_MISMATCH');

  if (fileMap.get('history-ledger.json').schema !== validatedLedger.schemaVersion || manifest.ledgerSchema !== validatedLedger.schemaVersion) {
    throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_LEDGER_SCHEMA_BINDING_MISMATCH');
  }
  if (fileMap.get('historical-comparison-receipt.json').schema !== validatedReceipt.schemaVersion || manifest.comparisonReceiptSchema !== validatedReceipt.schemaVersion) {
    throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_RECEIPT_SCHEMA_BINDING_MISMATCH');
  }
  if (fileMap.get('comparison-verification.json').schema !== replayedVerification.schemaVersion || manifest.verificationSchema !== replayedVerification.schemaVersion) {
    throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_VERIFICATION_SCHEMA_BINDING_MISMATCH');
  }
  if (manifest.ledgerFingerprint !== validatedLedger.ledgerFingerprint) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_LEDGER_FINGERPRINT_MISMATCH');
  if (manifest.comparisonReceiptFingerprint !== validatedReceipt.receiptFingerprint) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_RECEIPT_FINGERPRINT_MISMATCH');
  if (manifest.verificationStatus !== replayedVerification.verificationState) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_VERIFICATION_STATUS_MISMATCH');
  if (!sameJson(manifest.periodAEvidenceKey, replayedVerification.periodAEvidenceKey)) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_PERIOD_A_BINDING_MISMATCH');
  if (!sameJson(manifest.periodBEvidenceKey, replayedVerification.periodBEvidenceKey)) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_PERIOD_B_BINDING_MISMATCH');
  if (manifest.comparisonAllowed !== replayedVerification.comparisonAllowed || manifest.rawEvidenceOnly !== replayedVerification.rawEvidenceOnly) {
    throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_COMPARISON_STATE_MISMATCH');
  }
  if (manifest.profitabilityBasis !== 'sales_minus_ad_spend_only_not_net_profit') throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_PROFITABILITY_BASIS_INVALID');
  if (manifest.deterministic?.generatedTimestampIncluded !== false) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_TIMESTAMP_POLICY_INVALID');
  if (!sameJson(manifest.deterministic?.entryOrder, REQUIRED_AUDIT_PATHS)) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ENTRY_ORDER_INVALID');

  const { packageFingerprint: _ignored, ...fingerprintPayload } = manifest;
  const expectedFingerprint = await sha256Hex(canonicalJson(fingerprintPayload));
  if (expectedFingerprint !== manifest.packageFingerprint) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_FINGERPRINT_MISMATCH');

  return deepFreeze({
    schemaVersion: CSV_HISTORY_AUDIT_PACKAGE_SCHEMA_VERSION,
    verificationState: 'audit_package_verified_locally',
    packageFingerprint: manifest.packageFingerprint,
    ledgerFingerprint: validatedLedger.ledgerFingerprint,
    comparisonReceiptFingerprint: validatedReceipt.receiptFingerprint,
    periodAEvidenceKey: replayedVerification.periodAEvidenceKey,
    periodBEvidenceKey: replayedVerification.periodBEvidenceKey,
    comparisonAllowed: replayedVerification.comparisonAllowed,
    rawEvidenceOnly: replayedVerification.rawEvidenceOnly,
    authority: noAuthority(),
  });
}

export async function buildHistoricalAuditPackageZipFiles(artifact) {
  await validateHistoricalAuditPackageArtifact(artifact);
  return Object.freeze([
    Object.freeze({ name: 'manifest.json', text: artifact.manifestText }),
    ...REQUIRED_AUDIT_PATHS.map((path) => Object.freeze({ name: path, text: artifact.files.find((file) => file.path === path).text })),
  ]);
}

export async function verifyHistoricalAuditPackageZip(zipInput, zipBuilder) {
  if (typeof zipBuilder !== 'function') throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ZIP_BUILDER_UNAVAILABLE');
  const bytes = normalizeZipBytes(zipInput);
  const entries = parseDeterministicStoredZipEntries(bytes);
  const names = entries.map((entry) => entry.name);
  if (entries.length !== REQUIRED_ARCHIVE_PATHS.length) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ZIP_REQUIRED_ENTRY_MISSING');
  if (!sameJson(names, REQUIRED_ARCHIVE_PATHS)) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ZIP_ENTRY_ORDER_INVALID');

  const rebuilt = zipBuilder(entries.map(({ name, text }) => ({ name, text })));
  if (!sameBytes(bytes, rebuilt)) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ZIP_CANONICAL_BYTES_MISMATCH');

  let manifest;
  try { manifest = JSON.parse(entries[0].text); }
  catch { throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ZIP_MANIFEST_JSON_INVALID'); }
  const manifestEntries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  const metadataByPath = new Map(manifestEntries.map((entry) => [entry?.path, entry]));
  const artifact = {
    schemaVersion: manifest?.schemaVersion,
    packageFingerprint: manifest?.packageFingerprint,
    manifest,
    manifestText: entries[0].text,
    files: entries.slice(1).map((entry) => ({
      path: entry.name,
      text: entry.text,
      schema: metadataByPath.get(entry.name)?.schema,
      contentSha256: metadataByPath.get(entry.name)?.contentSha256,
    })),
  };
  const validation = await validateHistoricalAuditPackageArtifact(artifact);
  return deepFreeze({
    schemaVersion: CSV_HISTORY_AUDIT_PACKAGE_VERIFICATION_SCHEMA_VERSION,
    verificationState: 'audit_package_zip_verified_locally',
    packageFingerprint: validation.packageFingerprint,
    ledgerFingerprint: validation.ledgerFingerprint,
    comparisonReceiptFingerprint: validation.comparisonReceiptFingerprint,
    periodAEvidenceKey: validation.periodAEvidenceKey,
    periodBEvidenceKey: validation.periodBEvidenceKey,
    comparisonAllowed: validation.comparisonAllowed,
    rawEvidenceOnly: validation.rawEvidenceOnly,
    archiveFormat: 'zip_store_utf8',
    archiveEntryCount: entries.length,
    canonicalZipBytesMatch: true,
    generatedTimestampIncluded: false,
    replayedFromPackageContents: true,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    authority: noAuthority(),
  });
}

export async function buildHistoricalAuditPackageIndex(zipInputs, zipBuilder) {
  if (!Array.isArray(zipInputs) || zipInputs.length === 0) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_INPUTS_REQUIRED');
  if (typeof zipBuilder !== 'function') throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ZIP_BUILDER_UNAVAILABLE');
  const packages = [];
  for (const zipInput of zipInputs) {
    const bytes = normalizeZipBytes(zipInput);
    const verified = await verifyHistoricalAuditPackageZip(bytes, zipBuilder);
    packages.push({
      packageFingerprint: verified.packageFingerprint,
      archiveSha256: await sha256Bytes(bytes),
      ledgerFingerprint: verified.ledgerFingerprint,
      comparisonReceiptFingerprint: verified.comparisonReceiptFingerprint,
      periodAEvidenceKey: verified.periodAEvidenceKey,
      periodBEvidenceKey: verified.periodBEvidenceKey,
      comparisonAllowed: verified.comparisonAllowed,
      rawEvidenceOnly: verified.rawEvidenceOnly,
      verificationSchema: verified.schemaVersion,
      verificationState: verified.verificationState,
      archiveFormat: verified.archiveFormat,
      archiveEntryCount: verified.archiveEntryCount,
      canonicalZipBytesMatch: verified.canonicalZipBytesMatch,
      replayedFromPackageContents: verified.replayedFromPackageContents,
    });
  }
  packages.sort((a, b) => a.packageFingerprint.localeCompare(b.packageFingerprint));
  for (let index = 1; index < packages.length; index += 1) {
    if (packages[index - 1].packageFingerprint === packages[index].packageFingerprint) {
      throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_DUPLICATE_PACKAGE_FINGERPRINT');
    }
  }
  const payload = {
    schemaVersion: CSV_HISTORY_AUDIT_PACKAGE_INDEX_SCHEMA_VERSION,
    indexPurpose: 'deterministic_catalog_of_independently_verified_historical_audit_packages',
    packageCount: packages.length,
    packages,
    deterministic: {
      generatedTimestampIncluded: false,
      sourceFileNameIncluded: false,
      selectionOrderAffectsFingerprint: false,
      packageOrder: 'package_fingerprint_ascending',
      indexFingerprintBasis: 'canonical_index_without_index_fingerprint',
    },
    crossPackageAggregationApplied: false,
    normalizationApplied: false,
    deduplicationApplied: false,
    sameMonthAggregationApplied: false,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    authority: noAuthority(),
  };
  const indexFingerprint = await sha256Hex(canonicalJson(payload));
  const index = deepFreeze({ ...payload, indexFingerprint });
  await validateHistoricalAuditPackageIndex(index);
  return index;
}

export async function validateHistoricalAuditPackageIndex(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_INVALID');
  if (index.schemaVersion !== CSV_HISTORY_AUDIT_PACKAGE_INDEX_SCHEMA_VERSION) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_SCHEMA_UNSUPPORTED');
  if (index.indexPurpose !== 'deterministic_catalog_of_independently_verified_historical_audit_packages') throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_PURPOSE_INVALID');
  assertNoAuthority(index.authority, 'CSV_HISTORY_AUDIT_PACKAGE_INDEX_AUTHORITY_ESCALATION_BLOCKED');
  assertSha256(index.indexFingerprint, 'CSV_HISTORY_AUDIT_PACKAGE_INDEX_FINGERPRINT_INVALID');
  if (index.profitabilityBasis !== 'sales_minus_ad_spend_only_not_net_profit') throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_PROFITABILITY_BASIS_INVALID');
  if (index.crossPackageAggregationApplied !== false || index.normalizationApplied !== false || index.deduplicationApplied !== false || index.sameMonthAggregationApplied !== false) {
    throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_TRANSFORMATION_POLICY_INVALID');
  }
  const deterministic = index.deterministic;
  if (!deterministic || deterministic.generatedTimestampIncluded !== false || deterministic.sourceFileNameIncluded !== false || deterministic.selectionOrderAffectsFingerprint !== false || deterministic.packageOrder !== 'package_fingerprint_ascending' || deterministic.indexFingerprintBasis !== 'canonical_index_without_index_fingerprint') {
    throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_DETERMINISM_POLICY_INVALID');
  }
  const packages = Array.isArray(index.packages) ? index.packages : [];
  if (!packages.length || index.packageCount !== packages.length) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_PACKAGE_COUNT_INVALID');
  let previousFingerprint = null;
  const seen = new Set();
  for (const item of packages) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_ENTRY_INVALID');
    assertSha256(item.packageFingerprint, 'CSV_HISTORY_AUDIT_PACKAGE_INDEX_PACKAGE_FINGERPRINT_INVALID');
    assertSha256(item.archiveSha256, 'CSV_HISTORY_AUDIT_PACKAGE_INDEX_ARCHIVE_SHA256_INVALID');
    assertSha256(item.ledgerFingerprint, 'CSV_HISTORY_AUDIT_PACKAGE_INDEX_LEDGER_FINGERPRINT_INVALID');
    assertSha256(item.comparisonReceiptFingerprint, 'CSV_HISTORY_AUDIT_PACKAGE_INDEX_RECEIPT_FINGERPRINT_INVALID');
    if (seen.has(item.packageFingerprint)) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_DUPLICATE_PACKAGE_FINGERPRINT');
    seen.add(item.packageFingerprint);
    if (previousFingerprint && previousFingerprint.localeCompare(item.packageFingerprint) >= 0) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_ORDER_INVALID');
    previousFingerprint = item.packageFingerprint;
    assertAuditEvidenceKey(item.periodAEvidenceKey, item.ledgerFingerprint, 'CSV_HISTORY_AUDIT_PACKAGE_INDEX_PERIOD_A_BINDING_INVALID');
    assertAuditEvidenceKey(item.periodBEvidenceKey, item.ledgerFingerprint, 'CSV_HISTORY_AUDIT_PACKAGE_INDEX_PERIOD_B_BINDING_INVALID');
    if (typeof item.comparisonAllowed !== 'boolean' || typeof item.rawEvidenceOnly !== 'boolean' || item.rawEvidenceOnly === item.comparisonAllowed) {
      throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_COMPARISON_STATE_INVALID');
    }
    if (item.verificationSchema !== CSV_HISTORY_AUDIT_PACKAGE_VERIFICATION_SCHEMA_VERSION || item.verificationState !== 'audit_package_zip_verified_locally') {
      throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_VERIFICATION_STATE_INVALID');
    }
    if (item.archiveFormat !== 'zip_store_utf8' || item.archiveEntryCount !== REQUIRED_ARCHIVE_PATHS.length || item.canonicalZipBytesMatch !== true || item.replayedFromPackageContents !== true) {
      throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_ARCHIVE_STATE_INVALID');
    }
  }
  const { indexFingerprint: _ignored, ...fingerprintPayload } = index;
  const expectedFingerprint = await sha256Hex(canonicalJson(fingerprintPayload));
  if (expectedFingerprint !== index.indexFingerprint) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_FINGERPRINT_MISMATCH');
  return deepFreeze(index);
}

export function serializeHistoricalAuditPackageIndex(index) {
  return `${JSON.stringify(sortKeysDeep(index), null, 2)}\n`;
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvHistoryComparisonReceiptVerification', {
    value: Object.freeze({
      version: CSV_HISTORY_COMPARISON_RECEIPT_VERIFICATION_UI_VERSION,
      schemaVersion: CSV_HISTORY_COMPARISON_RECEIPT_VERIFICATION_SCHEMA_VERSION,
      auditPackageSchemaVersion: CSV_HISTORY_AUDIT_PACKAGE_SCHEMA_VERSION,
      auditPackageVerificationSchemaVersion: CSV_HISTORY_AUDIT_PACKAGE_VERIFICATION_SCHEMA_VERSION,
      auditPackageIndexSchemaVersion: CSV_HISTORY_AUDIT_PACKAGE_INDEX_SCHEMA_VERSION,
      authority: 'local_historical_comparison_receipt_verification_only',
      verifyHistoricalComparisonReceiptAgainstLedger,
      buildHistoricalAuditPackage,
      validateHistoricalAuditPackageArtifact,
      buildHistoricalAuditPackageZipFiles,
      verifyHistoricalAuditPackageZip,
      buildHistoricalAuditPackageIndex,
      validateHistoricalAuditPackageIndex,
      serializeHistoricalAuditPackageIndex,
    }),
    writable: false,
    configurable: false,
    enumerable: true,
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}

function mount() {
  if (state.mounted) return;
  const joint = document.querySelector('[data-csv-joint-analysis]');
  if (!joint) {
    new MutationObserver((_, observer) => {
      if (!document.querySelector('[data-csv-joint-analysis]')) return;
      observer.disconnect();
      mount();
    }).observe(document.documentElement, { childList: true, subtree: true });
    return;
  }
  if (joint.querySelector('[data-csv-history-comparison-receipt-verification]')) return void (state.mounted = true);

  installStyles();
  const root = document.createElement('section');
  root.className = 'cfhcv';
  root.dataset.csvHistoryComparisonReceiptVerification = CSV_HISTORY_COMPARISON_RECEIPT_VERIFICATION_UI_VERSION;
  root.innerHTML = `
    <div class="cfhcv-head">
      <div><b>Comparison Receipt Verification</b><small>Supply the original local history ledger and a downloaded comparison receipt. Verification replays Period A/B through the current comparability engine and requires an exact fingerprint and serialization match.</small></div>
      <span>ledger-bound replay</span>
    </div>
    <div class="cfhcv-guard">Standalone receipt integrity is checked first, then the receipt is rebuilt from the explicit local ledger. Any receipt drift, ledger drift, evidence-key drift, or authority escalation fails closed.</div>
    <div class="cfhcv-controls">
      <label>History ledger <input type="file" accept="application/json,.json" data-cfhcv-ledger></label>
      <label>Comparison receipt <input type="file" accept="application/json,.json" data-cfhcv-receipt></label>
      <button type="button" data-cfhcv-verify disabled>Verify against ledger</button>
      <button type="button" data-cfhcv-package disabled>Download audit package</button>
    </div>
    <div class="cfhcv-controls">
      <label>Audit package ZIP <input type="file" accept="application/zip,.zip" data-cfhcv-package-file></label>
      <button type="button" data-cfhcv-package-verify disabled>Verify downloaded audit package</button>
    </div>
    <div class="cfhcv-controls">
      <label>Audit package ZIPs for index <input type="file" accept="application/zip,.zip" multiple data-cfhcv-index-files></label>
      <button type="button" data-cfhcv-index-build disabled>Download deterministic package index</button>
    </div>
    <div class="cfhcv-status" data-cfhcv-status>Select local evidence, a downloaded audit ZIP, or multiple audit ZIPs for a deterministic catalog. No file contents are persisted remotely or in hidden browser storage.</div>
    <div class="cfhcv-result" data-cfhcv-result hidden></div>`;

  const receiptWorkspace = joint.querySelector('[data-csv-history-comparison-receipt]');
  const provenance = joint.querySelector('[data-csv-provenance-audit]');
  if (receiptWorkspace) receiptWorkspace.insertAdjacentElement('afterend', root);
  else if (provenance) provenance.insertAdjacentElement('beforebegin', root);
  else joint.appendChild(root);

  root.querySelector('[data-cfhcv-ledger]').addEventListener('change', (event) => void loadLedger(root, event.currentTarget));
  root.querySelector('[data-cfhcv-receipt]').addEventListener('change', (event) => void loadReceipt(root, event.currentTarget));
  root.querySelector('[data-cfhcv-verify]').addEventListener('click', () => void verifyFromUi(root));
  root.querySelector('[data-cfhcv-package]').addEventListener('click', () => void downloadAuditPackage(root));
  root.querySelector('[data-cfhcv-package-file]').addEventListener('change', (event) => void loadAuditZip(root, event.currentTarget));
  root.querySelector('[data-cfhcv-package-verify]').addEventListener('click', () => void verifyAuditZipFromUi(root));
  root.querySelector('[data-cfhcv-index-files]').addEventListener('change', (event) => void loadAuditIndexFiles(root, event.currentTarget));
  root.querySelector('[data-cfhcv-index-build]').addEventListener('click', () => void buildAuditIndexFromUi(root));
  state.mounted = true;
}

async function loadLedger(root, input) {
  const file = input.files?.[0];
  state.ledger = null;
  state.ledgerFileName = null;
  state.verification = null;
  clearResult(root);
  if (!file) return syncControls(root);
  state.busy = true;
  syncControls(root);
  setStatus(root, 'Validating local history ledger…', 'loading');
  try {
    const parsed = JSON.parse(await file.text());
    state.ledger = await validateCsvHistoryLedger(parsed);
    state.ledgerFileName = file.name;
    setStatus(root, `Ledger validated: ${state.ledger.ledgerFingerprint.slice(0, 12)}. Select or retain a receipt, then verify.`, 'ok');
  } catch (error) {
    setStatus(root, `Ledger blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

async function loadReceipt(root, input) {
  const file = input.files?.[0];
  state.receipt = null;
  state.receiptFileName = null;
  state.verification = null;
  clearResult(root);
  if (!file) return syncControls(root);
  state.busy = true;
  syncControls(root);
  setStatus(root, 'Validating standalone comparison receipt integrity…', 'loading');
  try {
    state.receipt = await parseHistoricalComparisonReceipt(await file.text());
    state.receiptFileName = file.name;
    setStatus(root, `Receipt integrity validated: ${state.receipt.receiptFingerprint.slice(0, 12)}. Select or retain its source ledger, then verify.`, 'ok');
  } catch (error) {
    setStatus(root, `Receipt blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

async function loadAuditZip(root, input) {
  const file = input.files?.[0];
  state.auditZipBytes = null;
  clearResult(root);
  if (!file) return syncControls(root);
  state.busy = true;
  syncControls(root);
  setStatus(root, 'Reading downloaded audit package locally…', 'loading');
  try {
    state.auditZipBytes = new Uint8Array(await file.arrayBuffer());
    setStatus(root, `Audit package loaded: ${file.name}. Verify to replay all packaged evidence and canonical ZIP bytes.`, 'ok');
  } catch (error) {
    setStatus(root, `Audit package read blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

async function loadAuditIndexFiles(root, input) {
  const files = [...(input.files || [])];
  state.auditIndexZipInputs = [];
  clearResult(root);
  if (!files.length) return syncControls(root);
  state.busy = true;
  syncControls(root);
  setStatus(root, `Reading ${files.length} audit package ZIP${files.length === 1 ? '' : 's'} locally for index creation…`, 'loading');
  try {
    state.auditIndexZipInputs = await Promise.all(files.map(async (file) => new Uint8Array(await file.arrayBuffer())));
    setStatus(root, `${files.length} local audit package ZIP${files.length === 1 ? '' : 's'} loaded. Each package will be independently replay-verified before index creation.`, 'ok');
  } catch (error) {
    state.auditIndexZipInputs = [];
    setStatus(root, `Audit package index input blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

async function verifyFromUi(root) {
  if (!state.ledger || !state.receipt || state.busy) return;
  state.busy = true;
  state.verification = null;
  clearResult(root);
  syncControls(root);
  setStatus(root, 'Replaying receipt against explicit local ledger…', 'loading');
  try {
    state.verification = await verifyHistoricalComparisonReceiptAgainstLedger(state.ledger, state.receipt);
    renderVerification(root, state.verification);
    setStatus(root, `Verified against local ledger. Receipt ${state.verification.receiptFingerprint.slice(0, 12)} exactly matches recomputation.`, 'ok');
  } catch (error) {
    setStatus(root, `Verification blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

async function downloadAuditPackage(root) {
  if (!state.ledger || !state.receipt || !state.verification || state.busy) return;
  state.busy = true;
  syncControls(root);
  setStatus(root, 'Building deterministic historical audit package locally…', 'loading');
  try {
    const artifact = await buildHistoricalAuditPackage(state.ledger, state.receipt);
    const zipFiles = await buildHistoricalAuditPackageZipFiles(artifact);
    const zipBuilder = window.CloudflareCsvAnalysisExport?.buildStoredZip;
    if (typeof zipBuilder !== 'function') throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ZIP_BUILDER_UNAVAILABLE');
    const zipBytes = zipBuilder(zipFiles);
    downloadBytes(`csv-history-audit-package-v1-${artifact.packageFingerprint.slice(0, 12)}.zip`, zipBytes);
    setStatus(root, `Historical audit package ${artifact.packageFingerprint.slice(0, 12)} downloaded locally. Verification authority remains non-executing.`, 'ok');
  } catch (error) {
    setStatus(root, `Audit package blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

async function verifyAuditZipFromUi(root) {
  if (!state.auditZipBytes || state.busy) return;
  state.busy = true;
  clearResult(root);
  syncControls(root);
  setStatus(root, 'Verifying canonical ZIP bytes, entry hashes, manifest bindings, and packaged replay evidence…', 'loading');
  try {
    const zipBuilder = window.CloudflareCsvAnalysisExport?.buildStoredZip;
    const verification = await verifyHistoricalAuditPackageZip(state.auditZipBytes, zipBuilder);
    renderAuditZipVerification(root, verification);
    setStatus(root, `Audit package ${verification.packageFingerprint.slice(0, 12)} independently verified from downloaded ZIP contents.`, 'ok');
  } catch (error) {
    setStatus(root, `Audit ZIP verification blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

async function buildAuditIndexFromUi(root) {
  if (!state.auditIndexZipInputs.length || state.busy) return;
  state.busy = true;
  clearResult(root);
  syncControls(root);
  setStatus(root, 'Independently verifying selected audit ZIPs and building deterministic local package index…', 'loading');
  try {
    const zipBuilder = window.CloudflareCsvAnalysisExport?.buildStoredZip;
    const index = await buildHistoricalAuditPackageIndex(state.auditIndexZipInputs, zipBuilder);
    downloadText(`csv-history-audit-package-index-v1-${index.indexFingerprint.slice(0, 12)}.json`, serializeHistoricalAuditPackageIndex(index));
    renderAuditIndex(root, index);
    setStatus(root, `Deterministic package index ${index.indexFingerprint.slice(0, 12)} downloaded locally for ${index.packageCount} independently verified package${index.packageCount === 1 ? '' : 's'}.`, 'ok');
  } catch (error) {
    setStatus(root, `Audit package index blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

function renderVerification(root, verification) {
  const result = root.querySelector('[data-cfhcv-result]');
  result.innerHTML = `
    <div class="cfhcv-grid">
      ${card('Verification', '<b>verified against local ledger</b>')}
      ${card('Receipt fingerprint', `<code>${esc(verification.receiptFingerprint)}</code>`)}
      ${card('Ledger fingerprint', `<code>${esc(verification.ledgerFingerprint)}</code>`)}
      ${card('Comparison state', verification.comparisonAllowed ? '<b>allowed</b><br>interpretable review receipt' : '<b>blocked</b><br>raw evidence only')}
    </div>
    <div class="cfhcv-guard">Fingerprint match: true · serialization match: true · generated timestamp: none · normalization: none · cross-snapshot aggregation: none. Audit-package export preserves the same authority boundary.</div>
    <details><summary>Period A evidence key</summary><pre>${esc(JSON.stringify(verification.periodAEvidenceKey, null, 2))}</pre></details>
    <details><summary>Period B evidence key</summary><pre>${esc(JSON.stringify(verification.periodBEvidenceKey, null, 2))}</pre></details>
    <details><summary>Verification authority boundary</summary><pre>${esc(JSON.stringify(verification.authority, null, 2))}</pre></details>`;
  result.hidden = false;
}

function renderAuditZipVerification(root, verification) {
  const result = root.querySelector('[data-cfhcv-result]');
  result.innerHTML = `
    <div class="cfhcv-grid">
      ${card('Audit ZIP verification', '<b>verified locally</b>')}
      ${card('Package fingerprint', `<code>${esc(verification.packageFingerprint)}</code>`)}
      ${card('Ledger fingerprint', `<code>${esc(verification.ledgerFingerprint)}</code>`)}
      ${card('Comparison state', verification.comparisonAllowed ? '<b>allowed</b><br>original comparison retained' : '<b>blocked</b><br>raw evidence only retained')}
    </div>
    <div class="cfhcv-guard">Canonical ZIP bytes: exact match · archive entries: ${esc(verification.archiveEntryCount)} · packaged receipt replay: exact · generated timestamp: none.</div>
    <details><summary>Audit ZIP authority boundary</summary><pre>${esc(JSON.stringify(verification.authority, null, 2))}</pre></details>`;
  result.hidden = false;
}

function renderAuditIndex(root, index) {
  const result = root.querySelector('[data-cfhcv-result]');
  const allowedCount = index.packages.filter((item) => item.comparisonAllowed).length;
  const blockedCount = index.packageCount - allowedCount;
  result.innerHTML = `
    <div class="cfhcv-grid">
      ${card('Package index', '<b>deterministic local catalog</b>')}
      ${card('Index fingerprint', `<code>${esc(index.indexFingerprint)}</code>`)}
      ${card('Verified packages', `<b>${esc(index.packageCount)}</b>`)}
      ${card('Comparison states', `<b>${esc(allowedCount)} allowed</b><br>${esc(blockedCount)} blocked/raw-only`)}
    </div>
    <div class="cfhcv-guard">Package order: fingerprint ascending · source filenames excluded · selection order ignored · cross-package aggregation: none · same-month aggregation: none.</div>
    <details><summary>Index authority boundary</summary><pre>${esc(JSON.stringify(index.authority, null, 2))}</pre></details>`;
  result.hidden = false;
}

function syncControls(root) {
  root.querySelector('[data-cfhcv-ledger]').disabled = state.busy;
  root.querySelector('[data-cfhcv-receipt]').disabled = state.busy;
  root.querySelector('[data-cfhcv-package-file]').disabled = state.busy;
  root.querySelector('[data-cfhcv-index-files]').disabled = state.busy;
  root.querySelector('[data-cfhcv-verify]').disabled = state.busy || !state.ledger || !state.receipt;
  root.querySelector('[data-cfhcv-package]').disabled = state.busy || !state.verification;
  root.querySelector('[data-cfhcv-package-verify]').disabled = state.busy || !state.auditZipBytes;
  root.querySelector('[data-cfhcv-index-build]').disabled = state.busy || !state.auditIndexZipInputs.length;
}

function clearResult(root) {
  const result = root.querySelector('[data-cfhcv-result]');
  result.hidden = true;
  result.innerHTML = '';
}

function setStatus(root, text, kind = '') {
  const node = root.querySelector('[data-cfhcv-status]');
  node.textContent = text;
  node.dataset.kind = kind;
}

async function auditFile(path, schema, text) {
  return Object.freeze({ path, schema, text, contentSha256: await sha256Hex(text) });
}

function serializeVerificationEvidence(verification) {
  return `${JSON.stringify(sortKeysDeep(verification), null, 2)}\n`;
}

function serializeAuditManifest(manifest) {
  return `${JSON.stringify(sortKeysDeep(manifest), null, 2)}\n`;
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
  return out;
}

function normalizeZipBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ZIP_BYTES_REQUIRED');
}

function parseDeterministicStoredZipEntries(bytes) {
  if (bytes.length < 30) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ZIP_TRUNCATED');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries = [];
  const seen = new Set();
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const signature = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
    if (signature === ZIP_CENTRAL_DIRECTORY_SIGNATURE) break;
    if (signature !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ZIP_LOCAL_HEADER_INVALID');
    if (offset + 30 > bytes.length) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ZIP_TRUNCATED');
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 30);
    const versionNeeded = view.getUint16(4, true);
    const flags = view.getUint16(6, true);
    const method = view.getUint16(8, true);
    const dosTime = view.getUint16(10, true);
    const dosDate = view.getUint16(12, true);
    const compressedSize = view.getUint32(18, true);
    const uncompressedSize = view.getUint32(22, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    if (versionNeeded !== 20 || flags !== ZIP_UTF8_FLAG || method !== ZIP_STORE_METHOD || dosTime !== ZIP_DOS_TIME || dosDate !== ZIP_DOS_DATE || extraLength !== 0) {
      throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ZIP_METADATA_INVALID');
    }
    if (compressedSize !== uncompressedSize) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ZIP_STORE_SIZE_MISMATCH');
    if (!nameLength) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ZIP_ENTRY_NAME_INVALID');
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart > bytes.length || dataEnd > bytes.length) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ZIP_TRUNCATED');
    let name;
    let text;
    try {
      name = decoder.decode(bytes.subarray(nameStart, dataStart));
      text = decoder.decode(bytes.subarray(dataStart, dataEnd));
    } catch {
      throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ZIP_UTF8_INVALID');
    }
    if (seen.has(name)) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ZIP_DUPLICATE_ENTRY_PATH');
    seen.add(name);
    entries.push(Object.freeze({ name, text }));
    if (entries.length > REQUIRED_ARCHIVE_PATHS.length) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ZIP_ENTRY_SET_INVALID');
    offset = dataEnd;
  }
  if (offset + 4 > bytes.length || new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
    throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_ZIP_CENTRAL_DIRECTORY_MISSING');
  }
  return entries;
}

async function sha256Bytes(bytesInput) {
  if (!globalThis.crypto?.subtle) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_CRYPTO_UNAVAILABLE');
  const bytes = normalizeZipBytes(bytesInput);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sameBytes(leftInput, rightInput) {
  const left = normalizeZipBytes(leftInput);
  const right = normalizeZipBytes(rightInput);
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

async function sha256Hex(text) {
  if (!globalThis.crypto?.subtle) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_CRYPTO_UNAVAILABLE');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertSha256(value, code) {
  if (!/^[a-f0-9]{64}$/.test(String(value || '').toLowerCase())) throw verificationError(code);
}

function assertAuditEvidenceKey(key, ledgerFingerprint, code) {
  if (!key || typeof key !== 'object' || Array.isArray(key)) throw verificationError(code);
  assertSha256(key.ledgerFingerprint, code);
  assertSha256(key.sourceInputSetFingerprint, code);
  if (key.ledgerFingerprint !== ledgerFingerprint || !/^\d{4}-\d{2}$/.test(String(key.month || ''))) throw verificationError(code);
}

function sameJson(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

function assertNoAuthority(authority, code) {
  const flags = [authority?.authoritative, authority?.canonicalAmazonIdentityResolved, authority?.governancePersistenceAllowed, authority?.executionAuthorized, authority?.amazonMutationAuthorized];
  if (flags.some((value) => value !== false)) throw verificationError(code);
}

function assertAuditBoundary(manifest) {
  assertNoAuthority(manifest?.authority, 'CSV_HISTORY_AUDIT_PACKAGE_AUTHORITY_ESCALATION_BLOCKED');
  if (manifest?.packagePurpose !== 'portable_immutable_local_historical_audit_material') throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_PURPOSE_INVALID');
}

function noAuthority() {
  return {
    authoritative: false,
    canonicalAmazonIdentityResolved: false,
    governancePersistenceAllowed: false,
    executionAuthorized: false,
    amazonMutationAuthorized: false,
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function verificationError(code) {
  const error = new Error(code);
  error.name = 'CsvHistoryComparisonReceiptVerificationError';
  error.code = code;
  return error;
}

function downloadBytes(name, bytes) {
  const blob = new Blob([bytes], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function downloadText(name, text) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function card(label, value) {
  return `<div class="cfhcv-card"><small>${esc(label)}</small><div>${value}</div></div>`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function installStyles() {
  if (document.getElementById('cfhcv-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfhcv-style-v1';
  style.textContent = '.cfhcv{margin-top:12px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#fff}.cfhcv-head{display:flex;justify-content:space-between;gap:12px}.cfhcv-head small{display:block;color:#64748b;max-width:780px}.cfhcv-head>span{font-size:11px;font-weight:800}.cfhcv-guard,.cfhcv-status{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc;color:#475569}.cfhcv-status[data-kind="bad"]{color:#b91c1c}.cfhcv-status[data-kind="ok"]{color:#047857}.cfhcv-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-top:9px}.cfhcv-controls label{display:grid;gap:4px;font-size:12px;font-weight:700}.cfhcv-controls input,.cfhcv-controls button{border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;background:#fff;font:inherit}.cfhcv-controls button{font-weight:700;cursor:pointer}.cfhcv-controls button:disabled{opacity:.45;cursor:not-allowed}.cfhcv-result{margin-top:10px}.cfhcv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}.cfhcv-card{padding:9px;border:1px solid #e2e8f0;border-radius:8px;overflow-wrap:anywhere}.cfhcv-card small{display:block;color:#64748b}.cfhcv code{font-size:11px;word-break:break-all}.cfhcv details{margin-top:8px;border:1px solid #e2e8f0;border-radius:8px;padding:8px}.cfhcv summary{cursor:pointer;font-weight:700}.cfhcv pre{white-space:pre-wrap;word-break:break-word;background:#f8fafc;padding:8px;border-radius:6px}';
  document.head.appendChild(style);
}
