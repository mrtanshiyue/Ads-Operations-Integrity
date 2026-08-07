import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../assets/generated/inline-script-04.js', import.meta.url), 'utf8');

assert.match(source, /targetingId:\s*\["投放方案编号","Targeting ID","TargetingID","Targeting Id","Target ID","TargetID"\]/);
assert.match(source, /currentBid:\s*\["Bid","Keyword Bid","Current Bid","目标竞价","竞价","关键词竞价","Ad Group Default Bid"\]/);
assert.match(source, /targetingId:\s*intern\(String\(map\.targetingId \? raw\[map\.targetingId\] : ""\)\.trim\(\)\)/);
assert.match(source, /currentBid:\s*map\.currentBid \? safeNum\(raw\[map\.currentBid\]\) : null/);
assert.match(source, /getBidGovernanceControlRowsForParity:\(\)=>getBidGovScopedRows\("searchTerm"\)\.map\(row=>\(\{/);
assert.match(source, /currentBid:Number\.isFinite\(row\.currentBid\)&&row\.currentBid>0\?row\.currentBid:null/);

const bridgeStart = source.indexOf('getBidGovernanceControlRowsForParity:');
assert.notEqual(bridgeStart, -1);
const bridgeEnd = source.indexOf('getProductCostDiagnostics:', bridgeStart);
assert.notEqual(bridgeEnd, -1);
const bridge = source.slice(bridgeStart, bridgeEnd);
for (const forbidden of ['suggestedBid', 'bulkReady', 'export', 'execute', 'assertActionAllowed', 'QueryNativeGovernanceGate']) {
  assert.equal(bridge.includes(forbidden), false, `Read-only Bid Control parity bridge must not contain ${forbidden}`);
}

console.log('Legacy Bid Control source parsing and read-only bridge contracts passed');
