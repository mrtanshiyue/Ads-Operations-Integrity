export function sourceR2ObjectByteSizeIdentity({ eligible, sourceContentBytes }, observation) {
  if (eligible !== true) {
    return {
      sourceContentBytes: null,
      sourceR2ObjectSizeBytes: null,
      observed: false,
      valid: false,
    };
  }

  const expectedBytes = nonNegativeSafeInteger(sourceContentBytes);
  const observedBytes = observation?.observed && observation.object
    ? nonNegativeSafeInteger(observation.object.size)
    : null;
  const observed = observedBytes !== null;

  return {
    sourceContentBytes: expectedBytes,
    sourceR2ObjectSizeBytes: observedBytes,
    observed,
    valid: expectedBytes !== null && observed && observedBytes === expectedBytes,
  };
}

function nonNegativeSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
