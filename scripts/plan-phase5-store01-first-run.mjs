import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveReportContract } from '../cloudflare/runtime/amazon-report-contract.js';
import {
  normalizeClientIdempotencyKey,
  normalizeWorkflowIntent,
} from '../cloudflare/runtime/sync-intent-contract.js';

const DAY_MS = 86_400_000;
const STORE_ID = 'store-dev-01';
const DATASET = 'search_term_daily';

export class Phase5FirstRunPlanError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'Phase5FirstRunPlanError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Build the smallest business-valid first real Store 01 run.
 *
 * `asOfDate` is deliberately explicit: it must be the latest fully closed reporting date in the
 * canonical Amazon profile's marketplace context. The planner then steps back the account-type
 * attribution window so conversion metrics for the selected click date are mature enough for the
 * first reconciliation. It never reads wall-clock time or guesses a marketplace timezone.
 */
export function buildPhase5Store01FirstRunPlan({ accountType, asOfDate } = {}) {
  let contract;
  try {
    contract = resolveReportContract(DATASET, accountType);
  } catch (error) {
    throw new Phase5FirstRunPlanError(`PHASE5_FIRST_RUN_ACCOUNT_TYPE_INVALID:${String(accountType ?? '')}`, error);
  }

  const closedDateMs = parseIsoDate(asOfDate, 'PHASE5_FIRST_RUN_AS_OF_DATE_INVALID');
  const windowDays = Number(contract?.attribution?.windowDays);
  if (!Number.isSafeInteger(windowDays) || windowDays < 1) {
    throw new Phase5FirstRunPlanError('PHASE5_FIRST_RUN_ATTRIBUTION_WINDOW_INVALID');
  }
  if (!Number.isSafeInteger(contract.retentionDays) || contract.retentionDays < windowDays) {
    throw new Phase5FirstRunPlanError('PHASE5_FIRST_RUN_LOOKBACK_CONTRACT_INVALID');
  }

  const reportDate = isoDate(closedDateMs - windowDays * DAY_MS);
  const canonicalAccountType = String(accountType).trim().toLowerCase();
  const requestBody = Object.freeze({
    startDate:reportDate,
    endDate:reportDate,
    datasets:Object.freeze([DATASET]),
  });
  const idempotencyKey = normalizeClientIdempotencyKey(
    `phase5.store01.search-term.${reportDate}.${canonicalAccountType}.v1`,
  );

  // Reuse the same public sync-intent parser used by the API so this operator plan cannot silently
  // drift into caller profile/report authority or an unsupported body shape.
  const normalizedIntent = normalizeWorkflowIntent({
    storeId:STORE_ID,
    ...requestBody,
    triggerType:'manual',
  });

  if (
    normalizedIntent.datasets.length !== 1
    || normalizedIntent.datasets[0] !== DATASET
    || normalizedIntent.startDate !== normalizedIntent.endDate
  ) {
    throw new Phase5FirstRunPlanError('PHASE5_FIRST_RUN_INTENT_NOT_SINGLE_DAY_SEARCH_TERM');
  }

  return Object.freeze({
    schemaVersion:'phase5-store01-first-run-plan-v1',
    storeId:STORE_ID,
    storeCode:'DEV01',
    accountType:canonicalAccountType,
    asOfDate:String(asOfDate),
    reportDate,
    attributionWindowDays:windowDays,
    reportLookbackDays:contract.retentionDays,
    dataset:DATASET,
    idempotencyKey,
    requestBody,
    preconditions:Object.freeze({
      activationState:'single_run_open',
      amazonAdsEnabled:true,
      syncTriggerEnabled:true,
      canonicalProfileResolved:true,
      asOfDateSemantics:'latest_fully_closed_marketplace_reporting_date',
    }),
  });
}

function parseIsoDate(value, code) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Phase5FirstRunPlanError(code);
  const ms = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== text) {
    throw new Phase5FirstRunPlanError(code);
  }
  return ms;
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseCli(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Phase5FirstRunPlanError(`PHASE5_FIRST_RUN_CLI_ARG_INVALID:${token}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Phase5FirstRunPlanError(`PHASE5_FIRST_RUN_CLI_VALUE_REQUIRED:${token}`);
    values.set(token, value);
    i += 1;
  }
  const allowed = new Set(['--account-type', '--as-of-date']);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Phase5FirstRunPlanError(`PHASE5_FIRST_RUN_CLI_ARG_INVALID:${key}`);
  }
  return {
    accountType:values.get('--account-type'),
    asOfDate:values.get('--as-of-date'),
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const result = buildPhase5Store01FirstRunPlan(parseCli(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}
