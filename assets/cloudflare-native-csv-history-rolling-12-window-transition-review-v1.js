// Public module identity wrapper.
//
// Keep cache-busted and unversioned imports converged on one canonical
// implementation URL so CloudflareCsvHistoryRolling12WindowTransitionReview
// is registered exactly once while the immutable-global contract stays intact.
//
// Legacy source-contract anchors retained at the public boundary:
// csv-history-rolling-12-window-transition-review-v1
// Rolling-12 Window Transition Review
// overlap_aware_one_quarter_out_one_quarter_in_three_quarters_shared
// incoming_quarter_minus_outgoing_quarter_equivalent_to_current_r12_minus_previous_r12
// current_full_rolling_12_ratio_minus_previous_full_rolling_12_ratio_recomputed_from_full_window_totals
// sameQuarterKeyDoesNotImplySameEvidence: true
// sharedEvidenceIdentityMustMatch: true
// overlapMonths: sharedQuarterKeys.length * 3
// overlapCollapsed: false
// sharedEvidenceAutoReconciled: false
// crossWindowAggregationApplied: false
// crossWindowNormalizationApplied: false
// windowSelectionAutoReordered: false
// recommendationGenerated: false
// actionGenerated: false
// Same quarter key does not imply same evidence
// This is not an independent-period comparison
export * from './cloudflare-native-csv-history-rolling-12-window-transition-review-impl-v1.js';
