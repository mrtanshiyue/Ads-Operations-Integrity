import { buildAmazonMutationRequest, classifyMutationTransportOutcome } from './amazon-action-execution-safety.js';
import { canonicalJson } from './decision-intelligence.js';

export const NEGATIVE_KEYWORD_DORMANT_ADAPTER_VERSION = 'amazon-negative-keyword-dormant-adapter-v1';

export async function buildDormantNegativeKeywordMutationEnvelope(plan) {
  const request = buildAmazonMutationRequest(plan);
  if (!request.ready) {
    return freeze({
      schemaVersion: NEGATIVE_KEYWORD_DORMANT_ADAPTER_VERSION,
      ready: false,
      errors: request.errors || ['mutation_request_not_ready'],
      networkDispatchAuthorized: false,
    });
  }

  const requestBodyJson = canonicalJson(request.body);
  const requestBodySha256 = await sha256Text(requestBodyJson);
  return freeze({
    schemaVersion: NEGATIVE_KEYWORD_DORMANT_ADAPTER_VERSION,
    ready: true,
    errors: [],
    contractVersion: request.contractVersion,
    source: request.source,
    method: request.method,
    endpointPath: request.endpointPath,
    requiredHeaderNames: request.requiredHeaderNames,
    contentType: request.contentType,
    body: request.body,
    requestBodyJson,
    requestBodySha256,
    expectedResponse: request.expectedResponse,
    dispatchGuard: {
      phase: 11,
      mode: 'dormant',
      amazonAdsEnabledRequired: true,
      singleUseConsumedPermitRequired: true,
      networkDispatchAuthorized: false,
      reason: 'phase11_network_dispatch_dormant',
    },
    networkDispatchAuthorized: false,
  });
}

export function evaluateDormantDispatchGuard({ env = {}, permitConsumption = null, envelope = null } = {}) {
  const amazonAdsEnabled = text(env.AMAZON_ADS_ENABLED).toLowerCase() === 'true';
  const permitConsumed = permitConsumption?.consumed === true && permitConsumption?.permit?.state === 'consumed';
  const requestReady = envelope?.ready === true;
  const errors = [];
  if (!requestReady) errors.push('mutation_request_not_ready');
  if (!permitConsumed) errors.push('consumed_single_use_permit_required');
  if (!amazonAdsEnabled) errors.push('amazon_ads_disabled');
  errors.push('phase11_network_dispatch_dormant');
  return freeze({
    allowed: false,
    errors: unique(errors),
    amazonAdsEnabled,
    permitConsumed,
    requestReady,
    networkDispatchAuthorized: false,
  });
}

export async function buildDormantTransportReceiptEvidence({
  dispatched = false,
  httpStatus = null,
  amazonRequestId = null,
  networkError = null,
  responseBody = null,
} = {}) {
  const normalizedRequestId = normalizeAmazonRequestId(amazonRequestId);
  const classification = classifyMutationTransportOutcome({
    dispatched,
    httpStatus,
    amazonRequestId: normalizedRequestId,
    networkError,
    responseBody,
  });
  const responseText = responseBody === null || responseBody === undefined
    ? null
    : (typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody));
  const status = Number(httpStatus);
  return freeze({
    schemaVersion: 'amazon-mutation-transport-evidence-v1',
    dispatched: Boolean(dispatched),
    httpStatus: Number.isInteger(status) ? status : null,
    amazonRequestId: normalizedRequestId,
    networkError: networkError ? String(networkError) : null,
    ...classification,
    responseBodySha256: responseText === null ? null : await sha256Text(responseText),
    networkDispatchAuthorized: false,
  });
}

export function normalizeAmazonRequestId(value) {
  const requestId = text(value);
  return requestId || null;
}

async function sha256Text(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('');
}
function text(value) { return String(value ?? '').trim(); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function freeze(value) { return Object.freeze(value); }
