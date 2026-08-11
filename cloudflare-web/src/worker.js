const JWKS_TTL_MS = 60 * 60 * 1000;
let jwksCache = { teamDomain: '', expiresAt: 0, keys: [] };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return withSecurityHeaders(await env.ASSETS.fetch(request), false);
    }

    let identity;
    try {
      identity = await verifyAccessIdentity(request, env);
    } catch (error) {
      console.warn('Access identity rejected', safeError(error));
      return json({ error: 'Unauthorized' }, 401);
    }

    if (url.pathname === '/api/session' && request.method === 'GET') {
      return json({
        authenticated: true,
        user: {
          sub: identity.sub,
          email: identity.email || null,
        },
      });
    }

    const requestId = request.headers.get('cf-ray') || crypto.randomUUID();
    const headers = sanitizedUpstreamHeaders(request.headers);
    headers.set('x-ops-user-sub', identity.sub);
    if (identity.email) headers.set('x-ops-user-email', identity.email);
    headers.set('x-ops-request-id', requestId);
    headers.set('x-ops-auth-source', 'cloudflare-access');

    const upstreamUrl = new URL(url.pathname + url.search, 'https://amazon-ops-api.internal');
    const init = {
      method: request.method,
      headers,
      redirect: 'manual',
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;

    const response = await env.WAREHOUSE.fetch(new Request(upstreamUrl, init));
    return withSecurityHeaders(response, true);
  },
};

async function verifyAccessIdentity(request, env) {
  const token = String(request.headers.get('cf-access-jwt-assertion') || '').trim();
  if (!token) throw new Error('Missing Cf-Access-Jwt-Assertion');

  const segments = token.split('.');
  if (segments.length !== 3) throw new Error('Malformed Access JWT');

  const header = decodeJsonSegment(segments[0]);
  const payload = decodeJsonSegment(segments[1]);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Unsupported Access JWT algorithm');

  const teamDomain = normalizeTeamDomain(env.TEAM_DOMAIN);
  const expectedAudience = String(env.ACCESS_AUD || '').trim();
  if (!expectedAudience) throw new Error('ACCESS_AUD is not configured');

  const jwk = await findJwk(teamDomain, header.kid);
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    base64UrlToBytes(segments[2]),
    new TextEncoder().encode(`${segments[0]}.${segments[1]}`),
  );
  if (!verified) throw new Error('Invalid Access JWT signature');

  const now = Math.floor(Date.now() / 1000);
  const issuer = String(payload.iss || '').replace(/\/$/, '');
  if (issuer !== teamDomain) throw new Error('Invalid Access JWT issuer');
  if (!audienceContains(payload.aud, expectedAudience)) throw new Error('Invalid Access JWT audience');
  if (!Number.isFinite(payload.exp) || payload.exp <= now) throw new Error('Expired Access JWT');
  if (Number.isFinite(payload.nbf) && payload.nbf > now + 30) throw new Error('Access JWT not active');

  const sub = String(payload.sub || '').trim();
  if (!sub) throw new Error('Access JWT subject missing');
  const email = String(payload.email || '').trim().toLowerCase();
  return { sub, email };
}

async function findJwk(teamDomain, kid) {
  if (jwksCache.teamDomain !== teamDomain || jwksCache.expiresAt <= Date.now()) {
    const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Access JWKS request failed: ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.keys)) throw new Error('Access JWKS payload is invalid');
    jwksCache = {
      teamDomain,
      expiresAt: Date.now() + JWKS_TTL_MS,
      keys: payload.keys,
    };
  }
  const jwk = jwksCache.keys.find((key) => key && key.kid === kid);
  if (!jwk) {
    jwksCache.expiresAt = 0;
    throw new Error('Access signing key not found');
  }
  return jwk;
}

function sanitizedUpstreamHeaders(input) {
  const headers = new Headers(input);
  for (const name of [
    'authorization',
    'cookie',
    'cf-access-jwt-assertion',
    'cf-access-authenticated-user-email',
    'x-ops-user-sub',
    'x-ops-user-email',
    'x-ops-request-id',
    'x-ops-auth-source',
  ]) headers.delete(name);
  headers.delete('host');
  return headers;
}

function withSecurityHeaders(response, apiResponse) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  if (apiResponse) headers.set('Cache-Control', 'private, no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(payload, status = 200) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
  });
  return withSecurityHeaders(new Response(JSON.stringify(payload), { status, headers }), true);
}

function normalizeTeamDomain(value) {
  const raw = String(value || '').trim().replace(/\/$/, '');
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('TEAM_DOMAIN must be https');
  return url.origin;
}

function audienceContains(audience, expected) {
  if (typeof audience === 'string') return audience === expected;
  return Array.isArray(audience) && audience.includes(expected);
}

function decodeJsonSegment(value) {
  const bytes = base64UrlToBytes(value);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function base64UrlToBytes(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
  return output;
}

function safeError(error) {
  return {
    name: String(error?.name || 'Error'),
    message: String(error?.message || error || 'Unknown error').slice(0, 300),
  };
}
