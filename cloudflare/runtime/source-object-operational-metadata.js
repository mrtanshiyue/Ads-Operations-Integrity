export function sourceR2ObjectOperationalMetadataIdentity(expected, observation) {
  if (!expected?.valid) return { observed: false, valid: false };
  if (!observation?.observed || !observation.object) return { observed: false, valid: false };

  const metadata = observation.object.customMetadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { observed: true, valid: false };
  }

  const expectedValues = {
    store_code: expected.storeCode,
    profile_id: expected.profileId,
    report_type: expected.reportType,
    ad_product: expected.adProduct,
    run_id: expected.runId,
  };

  const valid = Object.entries(expectedValues).every(([key, expectedValue]) => {
    const actual = metadataValue(metadata[key]);
    return actual !== null && actual === expectedValue;
  });

  return { observed: true, valid };
}

function metadataValue(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}
