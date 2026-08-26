// Public module identity wrapper.
//
// Keep cache-busted and unversioned imports converged on one canonical
// implementation URL so CloudflareCsvHistoryQuarterOverQuarterComparisonReceipt
// is registered exactly once while the immutable-global contract stays intact.
//
// Legacy source-contract anchors retained at the public boundary:
// csv-history-quarter-over-quarter-comparison-receipt-v1
// QoQ Comparison Receipt
// local replay · deterministic
// Blocked QoQ selections remain exportable as raw-evidence-only receipts with every delta withheld
// Ad Contribution = Sales - Ad Spend only; it is not Net Profit
// generatedTimestampIncluded: false
// comparisonRecomputedFromLedger: true
// quarter_b_minus_quarter_a
// operator_selected_forward_adjacent_calendar_quarters_no_auto_reorder
export * from './cloudflare-native-csv-history-quarter-over-quarter-comparison-receipt-impl-v1.js';
