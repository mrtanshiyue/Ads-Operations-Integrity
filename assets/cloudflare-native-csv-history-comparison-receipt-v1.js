// Public module identity wrapper.
//
// Keep all cache-busted and non-cache-busted imports converged on one
// implementation URL so browser ESM evaluation registers
// window.CloudflareCsvHistoryComparisonReceipt exactly once.
//
// Legacy source-contract anchors retained at the public boundary; the
// identity regression also verifies these anchors and execution-free
// constraints against the canonical implementation itself:
// Historical Comparison Receipt
// local replay · deterministic
// Blocked comparisons remain exportable as raw-evidence-only receipts with deltas withheld
// Ad Contribution = Sales - Ad Spend only; it is not Net Profit
// generatedTimestampIncluded: false
// comparisonRecomputedFromLedger: true
export * from './cloudflare-native-csv-history-comparison-receipt-impl-v1.js';
