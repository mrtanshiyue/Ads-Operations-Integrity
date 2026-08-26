// Public module identity wrapper.
//
// Keep cache-busted and non-cache-busted imports converged on one canonical
// implementation URL so CloudflareCsvHistoryYearToDateOperatingReview is
// registered exactly once while the immutable-global contract stays intact.
//
// Legacy source-contract anchors retained at the public boundary:
// csv-history-year-to-date-operating-review-v1
// Year-to-Date Operating Review
// Quarter-aligned YTD only
// validated_natural_quarters_q1_through_selected_quarter
// observed_natural_quarter_endpoints_no_auto_fill_or_reorder
// Partial or blocked quarters are never promoted into YTD metrics
// Ad Contribution = Sales - Ad Spend only; it is not Net Profit
// sameMonthAggregationApplied: false
// normalizationApplied: false
// businessRowDeduplicationApplied: false
// overlapCollapseApplied: false
// gapRepairApplied: false
// quarterSelectionAutoReordered: false
export * from './cloudflare-native-csv-history-year-to-date-operating-review-impl-v1.js';
