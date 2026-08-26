// Public module identity wrapper.
//
// Keep all cache-busted and non-cache-busted imports converged on one
// implementation URL so browser ESM evaluation registers
// window.CloudflareCsvHistoryQuarterlyOperatingReview exactly once.
//
// Legacy source-contract anchors retained at the public boundary; the
// identity regression also verifies these anchors and execution-free
// constraints against the canonical implementation itself:
// csv-history-quarterly-operating-review-v1
// Quarterly Operating Review
// all three exact calendar months pass the evidence gate
// same-month duplicate evidence
// Raw monthly evidence remains visible
// Ad Contribution = Sales - Ad Spend only; it is not Net Profit
// crossQuarterAggregationApplied: false
// sameMonthAggregationApplied: false
// businessRowDeduplicationApplied: false
// overlapCollapseApplied: false
// gapRepairApplied: false
// partialPeriodsHidden: false
// missingMonthsHidden: false
export * from './cloudflare-native-csv-history-quarterly-operating-review-impl-v1.js';
