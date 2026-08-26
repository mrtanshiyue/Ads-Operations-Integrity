// Public module identity wrapper.
//
// Keep cache-busted and unversioned imports converged on one canonical
// implementation URL so CloudflareCsvHistoryYearOverYearYtdComparison
// is registered exactly once while the immutable-global contract stays intact.
//
// Legacy source-contract anchors retained at the public boundary:
// csv-history-year-over-year-ytd-comparison-v1
// Year-over-Year YTD Comparison
// Period B must be the next natural year and use the same YTD through-quarter
// ytd_period_b_minus_ytd_period_a
// operator_selected_forward_adjacent_years_same_ytd_quarter_no_auto_reorder
// forwardAdjacentYearsRequired: true
// sameThroughQuarterRequired: true
// blockedYtdPeriodCannotBeUpgraded: true
// crossYearAggregationApplied: false
// crossYearNormalizationApplied: false
// ytdPeriodReaggregationApplied: false
// periodSelectionAutoReordered: false
// sameMonthAggregationApplied: false
// businessRowDeduplicationApplied: false
// overlapCollapseApplied: false
// gapRepairApplied: false
// Sales - Ad Spend only, not Net Profit
export * from './cloudflare-native-csv-history-year-over-year-ytd-comparison-impl-v1.js';
