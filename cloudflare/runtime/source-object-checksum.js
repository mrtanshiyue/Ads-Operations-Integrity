export function sourceR2ObjectNativeSha256Identity(sourceContent, metadataEvidence, observation) {
  if (!sourceContent?.valid || !metadataEvidence?.valid || !observation?.observed || !observation.object) {
    return { observed: false, sha256: null, valid: false };
  }

  const checksums = observation.object.checksums;
  if (!checksums || typeof checksums !== 'object') {
    return { observed: false, sha256: null, valid: false };
  }

  const nativeSha256 = checksumSha256Hex(checksums.sha256);
  const expectedSha256 = canonicalSha256(sourceContent.sha256);
  if (!nativeSha256 || !expectedSha256) {
    return { observed: true, sha256: null, valid: false };
  }

  return {
    observed: true,
    sha256: nativeSha256,
    valid: nativeSha256 === expectedSha256,
  };
}

function checksumSha256Hex(value) {
  let bytes;
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    return null;
  }
  if (bytes.byteLength !== 32) return null;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalSha256(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{64}$/i.test(text)) return null;
  return text.toLowerCase();
}
