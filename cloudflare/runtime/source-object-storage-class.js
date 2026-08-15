const SUPPORTED_STORAGE_CLASSES = new Set(['Standard', 'InfrequentAccess']);

export function sourceR2ObjectStorageClassEvidence({ eligible }, observation) {
  if (eligible !== true) {
    return {
      storageClass: null,
      observed: false,
      valid: false,
    };
  }

  if (!observation?.observed || !observation.object) {
    return {
      storageClass: null,
      observed: false,
      valid: false,
    };
  }

  const storageClass = observation.object.storageClass;
  if (typeof storageClass !== 'string' || !SUPPORTED_STORAGE_CLASSES.has(storageClass)) {
    return {
      storageClass: null,
      observed: false,
      valid: false,
    };
  }

  return {
    storageClass,
    observed: true,
    valid: true,
  };
}
