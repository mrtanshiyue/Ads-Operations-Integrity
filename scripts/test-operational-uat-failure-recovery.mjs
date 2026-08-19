import assert from 'node:assert/strict';
import {
  REQUIRED_UAT_CASES,
  evaluateOperationalUat,
} from './operational-uat-failure-recovery.mjs';

const passingEvidence = {
  productionAmazonHardOff: true,
  failClosed: true,
  cases: REQUIRED_UAT_CASES.map((caseId) => ({
    caseId,
    verified: true,
    amazonExecutionAttempted: false,
    crossStoreLeakageDetected: false,
    fabricatedZeroPerformance: false,
  })),
};

const passed = evaluateOperationalUat(passingEvidence);
assert.equal(passed.status, 'passed');
assert.equal(passed.verifiedCaseCount, REQUIRED_UAT_CASES.length);
assert.deepEqual(passed.failures, []);

const missing = structuredClone(passingEvidence);
missing.cases = missing.cases.filter((item) => item.caseId !== 'failure.missing-binding');
const missingResult = evaluateOperationalUat(missing);
assert.equal(missingResult.status, 'failed');
assert.ok(missingResult.failures.includes('failure.missing-binding:missing'));

const unsafe = structuredClone(passingEvidence);
const d1Failure = unsafe.cases.find((item) => item.caseId === 'failure.d1-query');
d1Failure.fabricatedZeroPerformance = true;
const unsafeResult = evaluateOperationalUat(unsafe);
assert.equal(unsafeResult.status, 'failed');
assert.ok(unsafeResult.failures.includes('failure.d1-query:fabricated_zero_performance_not_proven_absent'));

const executionLeak = structuredClone(passingEvidence);
executionLeak.cases.find((item) => item.caseId === 'csv.malformed').amazonExecutionAttempted = true;
const executionLeakResult = evaluateOperationalUat(executionLeak);
assert.equal(executionLeakResult.status, 'failed');
assert.ok(executionLeakResult.failures.includes('csv.malformed:amazon_execution_not_proven_absent'));

console.log(JSON.stringify({
  ok: true,
  contract: 'operational-uat-failure-recovery',
  requiredCases: REQUIRED_UAT_CASES.length,
  failClosed: true,
  noAmazonExecution: true,
  noCrossStoreLeakage: true,
  noFabricatedZeroPerformance: true,
}));
