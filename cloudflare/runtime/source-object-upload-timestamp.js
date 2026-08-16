export function sourceR2ObjectUploadTimestampEvidence({ eligible }, observation) {
  if (eligible !== true) {
    return {
      uploadedAt: null,
      observed: false,
      valid: false,
    };
  }

  if (!observation?.observed || !observation.object) {
    return {
      uploadedAt: null,
      observed: false,
      valid: false,
    };
  }

  const uploaded = observation.object.uploaded;
  if (!(uploaded instanceof Date) || Number.isNaN(uploaded.getTime())) {
    return {
      uploadedAt: null,
      observed: false,
      valid: false,
    };
  }

  return {
    uploadedAt: uploaded.toISOString(),
    observed: true,
    valid: true,
  };
}
