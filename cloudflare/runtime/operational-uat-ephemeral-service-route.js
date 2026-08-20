import { evaluateAccessIdentity } from '../../src/access.js';
import {
  executeOperationalUatCase,
  OPERATIONAL_UAT_CASES,
  OPERATIONAL_UAT_CONFIRMATION,
  OPERATIONAL_UAT_ROUTE,
} from './operational-uat-live-probe.js';

const CASE_SET = new Set(OPERATIONAL_UAT_CASES);
const MAX_BODY_BYTES = 4096;
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

export function authorizeOperationalUatEphemeralServiceAccess(access = {}) {
  if (access.configured !== true) {
    return Object.freeze({ ok: false, status: 503, error: 'operational_uat_access_not_configured' });
  }
  if (access.authenticated !== true) {
    return Object.freeze({ ok: false, status: 401, error: 'operational_uat_service_token_required' });
  }
  if (access.identity?.principalType !== 'service_token') {
    return Object.freeze({ ok: false, status: 403, error: 'operational_uat_service_principal_required' });
  }
  const sub = String(access.identity?.sub || '').trim();
  if (!sub || !sub.endsWith('.access')) {
    return Object.freeze({ ok: false, status: 403, error: 'operational_uat_service_subject_invalid' });
  }
  return Object.freeze({
    ok: true,
    status: 200,
    sub,
    authorizationMode: 'secondary_access_service_token',
  });
}

export async function handleOperationalUatEphemeralServiceRoute({ request, env = {}, url = new URL(request.url) }) {
  if (url.pathname !== OPERATIONAL_UAT_ROUTE) return null;
  try {
    return await handleMatchedRoute({ request, env });
  } catch (error) {
    console.error('operational_uat_ephemeral_service_route_error', {
      name: error?.name || null,
      code: error?.code || null,
    });
    return json(request, {
      error: 'operational_uat_internal_error',
      verified: false,
      amazonExecutionAttempted: false,
      crossStoreLeakageDetected: false,
      fabricatedZeroPerformance: false,
      businessFactPersistenceAttempted: false,
      failClosed: true,
    }, 500);
  }
}

async function handleMatchedRoute({ request, env }) {
  if (request.method.toUpperCase() !== 'POST') return json(request, { error: 'method_not_allowed' }, 405);
  if (String(env.APP_ENV || '').trim().toLowerCase() !== 'production') {
    return json(request, { error: 'operational_uat_production_only' }, 404);
  }
  if (String(env.ACCESS_MODE || '').trim().toLowerCase() !== 'enforce') {
    return json(request, { error: 'operational_uat_requires_access_enforce' }, 503);
  }
  if (!String(env.OPERATIONAL_UAT_ACCESS_AUD || '').trim()) {
    return json(request, { error: 'operational_uat_secondary_audience_not_configured' }, 503);
  }
  if (!env.CONTROL_DB) return json(request, { error: 'control_db_not_bound' }, 503);

  const access = await evaluateAccessIdentity(request, env);
  const authorization = authorizeOperationalUatEphemeralServiceAccess(access);
  if (!authorization.ok) return json(request, { error: authorization.error }, authorization.status);

  if (request.headers.get('x-operational-uat-confirm') !== OPERATIONAL_UAT_CONFIRMATION) {
    return json(request, { error: 'operational_uat_confirmation_required' }, 409);
  }

  const body = await readBody(request);
  if (body.error) return json(request, { error: body.error }, 400);
  const caseId = String(body.value?.caseId || '').trim();
  if (!CASE_SET.has(caseId)) return json(request, { error: 'operational_uat_case_unsupported' }, 400);

  const response = await executeOperationalUatCase(caseId, {
    request,
    env,
    actor: Object.freeze({
      principalType: 'service_token',
      sub: authorization.sub,
      authorizationMode: authorization.authorizationMode,
    }),
  });
  return withAuthorizationEvidence(response, authorization.authorizationMode);
}

async function readBody(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { error: 'request_body_too_large' };
  let text;
  try {
    text = await request.text();
  } catch {
    return { error: 'request_body_unreadable' };
  }
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return { error: 'request_body_too_large' };
  if (!text.trim()) return { error: 'request_body_required' };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: 'request_json_invalid' };
  }
}

async function withAuthorizationEvidence(response, authorizationMode) {
  const contentType = String(response.headers.get('content-type') || '');
  if (!/application\/json/i.test(contentType)) return response;
  let payload;
  try {
    payload = await response.json();
  } catch {
    return response;
  }
  return new Response(JSON.stringify({
    ...payload,
    authorizationMode,
    persistentActorBindingRequired: false,
  }), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function json(request, payload, status) {
  const headers = new Headers(JSON_HEADERS);
  const ray = request?.headers?.get?.('cf-ray');
  if (ray) headers.set('x-request-id', ray);
  return new Response(JSON.stringify(payload), { status, headers });
}
