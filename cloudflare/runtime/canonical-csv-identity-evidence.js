import { resolveCanonicalAdvertiserProfileBinding } from './amazon-advertiser-profile-binding.js';
import { validateCsvCanonicalMembership } from './csv-canonical-membership-validator.js';

export async function buildCanonicalCsvIdentityEvidence(input) {
  const binding = await resolveCanonicalAdvertiserProfileBinding(input);
  const memberships = validateCsvCanonicalMembership({
    profileId: binding.profileId,
    rows: input.csvRows,
    snapshot: input.entitySnapshot,
  });
  const counts = memberships.reduce((out, row) => {
    out[row.status] = (out[row.status] || 0) + 1;
    return out;
  }, {});
  return Object.freeze({
    contractVersion: 'CanonicalCsvIdentityEvidenceV1',
    advertiserAccountObserved: input.observedAdvertiserAccountId,
    canonicalAdvertiserAccountVerified: true,
    canonicalProfileId: binding.profileId,
    profileVerificationSource: Object.freeze({
      sourceContract: binding.sourceContract,
      sourceEndpoint: binding.sourceEndpoint,
      profileAuthority: binding.profileAuthority,
    }),
    bindingEvidenceFingerprint: binding.evidenceFingerprint,
    verificationTimestamp: binding.sourceObservedAt,
    memberships,
    membershipCounts: Object.freeze(counts),
    sideEffects: Object.freeze({
      amazonMutation: false,
      d1Write: false,
      r2Write: false,
      reportCreate: false,
      reportPoll: false,
      reportDownload: false,
      optimizationAction: false,
      executionPermit: false,
    }),
  });
}
