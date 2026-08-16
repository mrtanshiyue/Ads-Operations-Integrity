export function sourceR2ObjectVersionEvidence({ eligible }, observation) {
  if (eligible !== true) {
    return {
      version: null,
      observed: false,
      valid: false,
    };
  }

  if (!observation?.observed || !observation.object) {
    return {
      version: null,
      observed: false,
      valid: false,
    };
  }

  const version = observation.object.version;
  if (typeof version !== 'string' || version.trim().length === 0) {
    return {
      version: null,
      observed: false,
      valid: false,
    };
  }

  return {
    version,
    observed: true,
    valid: true,
  };
}
