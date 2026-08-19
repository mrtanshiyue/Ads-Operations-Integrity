# Legacy June CSV Exact-Source Reconciliation V1

Date: 2026-08-19

Status: **reconciliation evidence complete; authority intentionally unchanged**

This receipt records the offline recovery and deterministic reconciliation of the June 2026 business CSV behind the canonical Dev import. It is documentation-only. It does not authorize any D1/R2 mutation, Amazon transport, recommendation, review, or execution behavior.

## 1. Canonical import under review

- Store scope: Dev Store 01
- Import ID: `csv-d9ab3b06-f772-4257-add4-75eb35109f2d`
- Source file name: `202606 (1).csv`
- Report type: `spSearchTerm`
- Marketplace: `US`
- Currency: `USD`
- Report period: `2026-06-01` through `2026-06-30`
- Schema version: `csv-import-v1`
- Batch row count: `8,753`
- Accepted rows: `8,753`
- Rejected rows: `0`
- Batch SHA-256: `13e21aa9fd9967aeffb9def160a61fbe6973512a03628180f66111a3e30b44c2`
- Batch content bytes: `3,202,492`
- Batch uploaded/published at: `2026-08-18T03:50:02.204Z`
- Current data class: `business`
- Current provenance class: `legacy_batch_only`
- Current source-object receipts for this import: `0`

The current authority remains analytics-eligible but recommendation/review-ineligible.

## 2. Recovered source bytes

The recovered Library file is named exactly `202606 (1).csv`.

Exact recovered raw bytes:

- Raw byte count: `3,202,495`
- Raw SHA-256: `a5e0d3a5ca62e4d60d09be04d7693ec81aaef13052d32560100405be2ec35435`
- Raw prefix: UTF-8 BOM `EF BB BF`
- Parsed columns: `45`
- Data rows: `8,753`

After removing only the UTF-8 BOM / decoding through the legacy text path:

- Parser-input byte count: `3,202,492`
- Parser-input SHA-256: `13e21aa9fd9967aeffb9def160a61fbe6973512a03628180f66111a3e30b44c2`

The normalized parser-input SHA-256 and byte count therefore match the legacy import batch receipt exactly.

## 3. Deterministic row reconciliation

The recovered CSV was normalized using the existing `csv-import-v1` search-term ingestion semantics and compared against the canonical Dev D1 rows for the import.

The following independent checks matched exactly:

- Parsed fact rows: `8,753`
- Canonical 28-field projection SHA-256: `f4e81cca78e3eb67646261382e4916f24e562bb1f86f8686baae6455cafcfdf4`
- Row-key sequence SHA-256: `7622a83b9665f328ac8daca8403f92169ef82f79e215c0149a4699f77f15e529`
- Minimum report date: `2026-06-01`
- Maximum report date: `2026-06-30`
- Impressions: `1,390,748`
- Clicks: `14,268`
- Spend: `13,571,980,000` micros
- Purchases/orders: `1,562`
- Units sold: `1,577`
- Sales: `30,544,840,000` micros
- Distinct observed campaign IDs: `63`
- Distinct observed ad-group IDs: `63`
- Distinct observed targeting IDs: `125`
- Targeting identity states: `8,750 resolved_id`, `3 unresolved`

This establishes deterministic equivalence between the recovered source content as consumed by the legacy parser and the canonical imported facts.

## 4. Why provenance must remain `legacy_batch_only`

The recovered raw file is not byte-identical to the legacy batch receipt because the raw file contains a 3-byte UTF-8 BOM while the legacy batch receipt represents the BOM-stripped/text-normalized parser input.

That distinction matters because the current exact-source contract is deliberately raw-byte authoritative:

- `0021_store_csv_import_source_objects.sql` defines immutable source-object receipts for the exact uploaded source object.
- `csv-import-source-object.js` hashes and counts the exact raw source bytes.
- `0022_store_csv_import_authority.sql` requires a compatible source-object receipt before a legacy import can transition to `reconciled_exact_source`.

A legitimate exact source-object receipt for the recovered file would therefore carry:

- SHA-256 `a5e0d3a5ca62e4d60d09be04d7693ec81aaef13052d32560100405be2ec35435`
- byte count `3,202,495`

Those values cannot satisfy the legacy batch receipt values:

- SHA-256 `13e21aa9fd9967aeffb9def160a61fbe6973512a03628180f66111a3e30b44c2`
- byte count `3,202,492`

Creating a fake source-object receipt from BOM-stripped bytes, changing the legacy batch receipt, or bypassing the migration trigger would incorrectly convert parser-normalized evidence into raw-source authority.

## 5. Decision

**Keep the canonical June import at `business + legacy_batch_only`.**

The recovered source is sufficiently reconciled for analytics confidence and historical explanation, but it does not satisfy the current raw-byte exact-source authority transition contract.

Consequences:

- `analyticsEligible=true` remains valid.
- `recommendationEligible=false` remains required.
- advisory/review authority remains blocked.
- observed Amazon-looking IDs remain non-canonical and `identityResolved=false`.
- no Amazon mutation or transport authority is created.

## 6. Explicit non-actions

This reconciliation did **not**:

- insert a `csv_import_source_objects` row;
- upload or rewrite a Dev R2 source object;
- update `csv_import_batches`;
- update `csv_import_authority`;
- create a migration;
- change recommendation/review eligibility;
- create or modify Amazon credentials/secrets;
- call any Amazon endpoint.

Future provenance promotion is allowed only if the repository intentionally introduces a separately reviewed reconciliation contract that can prove the raw-byte/BOM normalization relationship without weakening exact-source semantics. Until then, fail closed at `legacy_batch_only`.
