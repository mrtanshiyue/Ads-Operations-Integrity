export async function loadSourceObjectHeads(env, contexts) {
  const keys = [...new Set((contexts || [])
    .filter((context) => context?.sourceContent?.valid === true && context?.sourceObject?.valid === true)
    .map((context) => context.sourceObject.r2ObjectKey)
    .filter(Boolean))];
  const bucket = env?.DATA_BUCKET;
  if (!keys.length || !bucket || typeof bucket.head !== 'function') return new Map();

  const entries = await Promise.all(keys.map(async (key) => {
    try {
      const object = await bucket.head(key);
      return [key, { observed: true, object: object || null }];
    } catch {
      return [key, { observed: false, object: null }];
    }
  }));
  return new Map(entries);
}

export function sourceR2ObjectHeadIdentity(sourceContent, sourceObject, observation) {
  if (!sourceContent?.valid || !sourceObject?.valid || !sourceObject.r2ObjectKey) {
    return { observed: false, exists: null, valid: false };
  }
  if (!observation?.observed) return { observed: false, exists: null, valid: false };
  if (!observation.object) return { observed: true, exists: false, valid: false };

  const headKey = nullableText(observation.object.key);
  const valid = headKey !== null && headKey === sourceObject.r2ObjectKey;
  return { observed: true, exists: true, valid };
}

function nullableText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}
