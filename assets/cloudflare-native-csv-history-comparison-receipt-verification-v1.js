// Public module identity wrapper.
//
// Keep cache-busted and non-cache-busted imports converged on one canonical
// implementation URL so CloudflareCsvHistoryComparisonReceiptVerification is
// registered exactly once while the immutable-global contract stays intact.
//
// Legacy source-contract anchors retained at the public boundary:
// Comparison Receipt Verification
// exact fingerprint and serialization match
// receipt drift, ledger drift, evidence-key drift, or authority escalation fails closed
// generatedTimestampIncluded: false
// replayedFromExplicitLocalLedger: true
// csv-history-audit-package-v1
// csv-history-audit-package-verification-v1
// csv-history-audit-package-index-v1
// Download audit package
// Verify downloaded audit package
// Download deterministic package index
// packageFingerprintBasis: 'canonical_manifest_without_package_fingerprint'
// indexFingerprintBasis: 'canonical_index_without_index_fingerprint'
// portable_immutable_local_historical_audit_material
// deterministic_catalog_of_independently_verified_historical_audit_packages
// CSV_HISTORY_AUDIT_PACKAGE_ZIP_CANONICAL_BYTES_MISMATCH
// sameMonthAggregationApplied: false
// sourceFileNameIncluded: false
export * from './cloudflare-native-csv-history-comparison-receipt-verification-impl-v1.js';
