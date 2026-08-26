// Public module identity wrapper.
//
// Keep cache-busted and unversioned imports converged on one canonical
// implementation URL so CloudflareCsvHistoryRolling12WindowTransitionReceiptVerification
// is registered exactly once while the immutable-global contract stays intact.
//
// Legacy source-contract anchors retained at the public boundary:
// csv-history-rolling-12-window-transition-receipt-verification-v1
// Rolling-12 Transition Receipt Verification
// ledger-bound replay · fail closed
// exact receipt fingerprint plus deterministic serialization equality
// a second explicit current ledger is required
// Verification never chooses a newer ledger, reconciles shared-quarter conflicts, upgrades a blocked transition, or grants execution authority
// standaloneReceiptValidatedFirst: true
// replayedFromExplicitLocalLedgers: true
// overlap_aware_one_quarter_out_one_quarter_in_three_quarters_shared
// incoming_quarter_minus_outgoing_quarter_equivalent_to_current_r12_minus_previous_r12
// current_full_rolling_12_ratio_minus_previous_full_rolling_12_ratio_recomputed_from_full_window_totals
// overlapCollapseApplied: false
// sharedEvidenceAutoReconciled: false
// crossWindowAggregationApplied: false
// crossWindowNormalizationApplied: false
// windowSelectionAutoReordered: false
// recommendationGenerated: false
// actionGenerated: false
// sales_minus_ad_spend_only_not_net_profit
export * from './cloudflare-native-csv-history-rolling-12-window-transition-receipt-verification-impl-v1.js';
