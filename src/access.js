const JWKS_TTL_MS = 60 * 60 * 1000;
const ACCESS_MODES = new Set(['off', 'observe', 'enforce']);
const jwksCache = new Map();

export function normalizeAccessMode(env = {}) {
  const mode = String(env.ACCESS_MODE || 'off').trim().toLowerCase();
  return ACCESS_MODES.has(mode) ? mode : 'off';
}

export function accessRuntimeConfig(env = {}) {
  const mode = normalizeAccessMode(env);
  const rawDomain = String(env.TEAM_DOMAIN || '').trim();
  const audience = String(env.ACCESS_AUD || env.POLICY_AUD || '').trim();
  let teamDomain = '';
  try {
    teamDomain = rawDomain ? normalizeTeamDomain(rawDomain) : '';
  } catch {
    teamDomain = '';
  }
  return {
    mode,
    configured: Boolean(teamDomain && audience),
    teamDomain,
    audience,
  };
}

export async function evaluateAccessIdentity(request, env = {}) {
  const config = accessRuntimeConfig(env);
  if (config.mode === 'off') {
    return {
      mode: 'off',
      configured: config.configured,
      authenticated: false,
      identity: null,
      error: null,
    };
  }

  if (!config.configured) {
    return {
      mode: config.mode,
      configured: false,
      authenticated: false,
      identity: null,
      error: 'not_configured',
    };
  }

  const token = String(request.headers.get('cf-access-jwt-assertion') || '').trim();
  if (!token) {
    return {
      mode: config.mode,
      configured: true,
      authenticated: false,
      identity: null,
      error: 'missing_token',
    };
  }

  try {
    const identity = await verifyAccessIdentity(request, env);
    return {
      mode: config.mode,
      configured: true,
      authenticated: true,
      identity,
      error: null,
    };
  } catch {
    return {
      mode: config.mode,
      configured: true,
      authenticated: false,
      identity: null,
      error: 'invalid_token',
    };
  }
}

export async function verifyAccessIdentity(request, env = {}) {
  const token = String(request.headers.get('cf-access-jwt-assertion') || '').trim();
  if (!token) throw new Error('Missing Cf-Access-Jwt-Assertion');

  const segments = token.split('.');
  if (segments.length !== 3) throw new Error('Malformed Access JWT');

  const header = decodeJsonSegment(segments[0]);
  const payload = decodeJsonSegment(segments[1]);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Unsupported Access JWT algorithm');

  const teamDomain = normalizeTeamDomain(env.TEAM_DOMAIN);
  const expectedAudience = String(env.ACCESS_AUD || env.POLICY_AUD || '').trim();
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

  return normalizeVerifiedAccessIdentity(payload);
}

export function normalizeVerifiedAccessIdentity(payload = {}) {
  const userSub = String(payload.sub || '').trim();
  const serviceTokenId = String(payload.common_name || '').trim();
  if (!userSub && (!serviceTokenId || !serviceTokenId.endsWith('.access'))) {
    throw new Error('Access JWT subject missing');
  }

  const email = String(payload.email || '').trim().toLowerCase();
  return {
    sub: userSub || serviceTokenId,
    email,
    exp: Number(payload.exp),
    principalType: userSub ? 'user' : 'service_token',
  };
}

async function findJwk(teamDomain, kid) {
  let cached = jwksCache.get(teamDomain);
  if (!cached || cached.expiresAt <= Date.now()) {
    cached = await refreshJwks(teamDomain);
  }

  let jwk = cached.keys.find((key) => key && key.kid === kid);
  if (!jwk) {
    cached = await refreshJwks(teamDomain);
    jwk = cached.keys.find((key) => key && key.kid === kid);
  }
  if (!jwk) throw new Error('Access signing key not found');
  return jwk;
}

async function refreshJwks(teamDomain) {
  const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Access JWKS request failed: ${response.status}`);

  const payload = await response.json();
  if (!Array.isArray(payload.keys) || payload.keys.length === 0) {
    throw new Error('Access JWKS payload is invalid');
  }

  const cached = {
    expiresAt: Date.now() + JWKS_TTL_MS,
    keys: payload.keys,
  };
  jwksCache.set(teamDomain, cached);
  return cached;
}

function normalizeTeamDomain(value) {
  const raw = String(value || '').trim().replace(/\/$/, '');
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('TEAM_DOMAIN must be https');
  if (!url.hostname.endsWith('.cloudflareaccess.com')) {
    throw new Error('TEAM_DOMAIN must be a cloudflareaccess.com team domain');
  }
  return url.origin;
}

function audienceContains(audience, expected) {
  if (typeof audience === 'string') return audience === expected;
  return Array.isArray(audience) && audience.includes(expected);
}

function decodeJsonSegment(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
}

function base64UrlToBytes(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
  return output;
}
