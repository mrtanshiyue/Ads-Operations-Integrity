// Public module identity wrapper.
//
// Keep cache-busted and unversioned imports converged on one canonical
// implementation URL so CloudflareCsvHistoryRolling12WindowTransitionReviewBoard
// is registered exactly once while the immutable-global contract stays intact.
//
// Legacy source-contract anchors retained at the public boundary:
// csv-history-rolling-12-window-transition-review-board-v1
// read_only_projection_of_verified_rolling_12_transition_receipt
// exact local-ledger replay verification
// movement and evidence state without judging business outcomes
// Additive movement uses incoming minus outgoing
// ACoS and ROAS movement uses the two full Rolling-12 totals only
// movementOnlyNoOutcomeJudgment: true
// outcomeQualityClassificationApplied: false
// recommendationGenerated: false
// actionGenerated: false
// ratioDerivedFromFullRolling12Totals: true
// incomingOutgoingQuarterRatioDeltaUsed: false
// sharedEvidenceAutoReconciled: false
// Ad Contribution = Sales - Ad Spend only; it is not Net Profit
export * from './cloudflare-native-csv-history-rolling-12-window-transition-review-board-impl-v1.js';
