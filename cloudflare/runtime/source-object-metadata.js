export function sourceR2ObjectHeadMetadataSha256Identity(sourceContent, headEvidence, observation) {
  if (!sourceContent?.valid || !headEvidence?.valid || !observation?.observed || !observation.object) {
    return { observed: false, sha256: null, valid: false };
  }

  const metadata = observation.object.customMetadata;
  if (!metadata || typeof metadata !== 'object') {
    return { observed: true, sha256: null, valid: false };
  }

  const metadataSha256 = canonicalSha256(metadata.sha256);
  const expectedSha256 = canonicalSha256(sourceContent.sha256);
  if (!metadataSha256 || !expectedSha256) {
    return { observed: true, sha256: null, valid: false };
  }

  return {
    observed: true,
    sha256: metadataSha256,
    valid: metadataSha256 === expectedSha256,
  };
}

function canonicalSha256(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{64}$/i.test(text)) return null;
  return text.toLowerCase();
}
