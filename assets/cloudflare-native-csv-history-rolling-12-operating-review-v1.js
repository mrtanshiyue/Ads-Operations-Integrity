// Public module identity wrapper.
//
// Keep cache-busted and non-cache-busted imports converged on one canonical
// implementation URL so CloudflareCsvHistoryRolling12OperatingReview is
// registered exactly once while the immutable-global contract stays intact.
//
// Legacy source-contract anchors retained at the public boundary:
// csv-history-rolling-12-operating-review-v1
// Rolling-12 Operating Review
// four_forward_adjacent_validated_natural_quarters
// rollingWindowCadence: 'quarter_aligned'
// windowLengthMonths: 12
// windowLengthQuarters: 4
// observed_natural_quarter_endpoints_no_auto_fill_or_reorder
// never reconstructs or repairs monthly evidence
// ACoS and ROAS are recomputed from Rolling-12 totals
// Ad Contribution = Sales - Ad Spend only; it is not Net Profit
// crossWindowAggregationApplied: false
// normalizationApplied: false
// sameMonthAggregationApplied: false
// businessRowDeduplicationApplied: false
// overlapCollapseApplied: false
// gapRepairApplied: false
// quarterSelectionAutoReordered: false
// recommendationGenerated: false
// actionGenerated: false
export * from './cloudflare-native-csv-history-rolling-12-operating-review-impl-v1.js';
