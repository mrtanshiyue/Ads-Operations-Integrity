// Public module identity wrapper.
//
// Keep cache-busted and non-cache-busted imports converged on one canonical
// implementation URL so CloudflareCsvHistoryQuarterOverQuarterComparison is
// registered exactly once while the immutable-global contract stays intact.
//
// Legacy source-contract anchors retained at the public boundary:
// csv-history-quarter-over-quarter-comparison-v1
// Quarter-over-Quarter Comparison
// Period B must be the immediately following quarter
// Delta direction is B − A
// No selection is silently reordered
// quarter_b_minus_quarter_a
// operator_selected_forward_adjacent_calendar_quarters_no_auto_reorder
// blockedQuarterCannotBeUpgraded: true
// crossQuarterAggregationApplied: false
// crossQuarterNormalizationApplied: false
// quarterSelectionAutoReordered: false
// sameMonthAggregationApplied: false
// businessRowDeduplicationApplied: false
// overlapCollapseApplied: false
// gapRepairApplied: false
// sales_minus_ad_spend_only_not_net_profit
export * from './cloudflare-native-csv-history-quarter-over-quarter-comparison-impl-v1.js';
