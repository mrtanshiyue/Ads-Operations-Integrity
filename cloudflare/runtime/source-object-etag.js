export function sourceR2ObjectEtagEvidence({ eligible }, observation) {
  if (eligible !== true) {
    return {
      etag: null,
      observed: false,
      valid: false,
    };
  }

  if (!observation?.observed || !observation.object) {
    return {
      etag: null,
      observed: false,
      valid: false,
    };
  }

  const etag = observation.object.etag;
  if (typeof etag !== 'string' || etag.trim().length === 0) {
    return {
      etag: null,
      observed: false,
      valid: false,
    };
  }

  return {
    etag,
    observed: true,
    valid: true,
  };
}
