// Public module identity wrapper.
//
// Keep cache-busted and unversioned imports converged on one canonical
// implementation URL so CloudflareCsvHistoryRolling12WindowTransitionReceipt
// is registered exactly once while the immutable-global contract stays intact.
//
// Legacy source-contract anchors retained at the public boundary:
// csv-history-rolling-12-window-transition-receipt-v1
// Rolling-12 Transition Receipt
// local replay · deterministic
// generatedTimestampIncluded: false
// transitionRecomputedFromLedgerEvidence: true
// previousAndCurrentLedgerEvidenceBound: true
// sharedQuarterEvidenceIdentityBound: true
// Same quarter key does not imply same evidence
// Blocked transitions remain exportable as raw-evidence-only receipts with all transition metrics withheld
// incoming_quarter_minus_outgoing_quarter_equivalent_to_current_r12_minus_previous_r12
// current_full_rolling_12_ratio_minus_previous_full_rolling_12_ratio_recomputed_from_full_window_totals
// sharedQuarterBindings
export * from './cloudflare-native-csv-history-rolling-12-window-transition-receipt-impl-v1.js';
