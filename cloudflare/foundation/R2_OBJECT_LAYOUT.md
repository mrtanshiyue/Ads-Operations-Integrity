# R2 Object Layout V1

Planned production bucket: `ads-ops-data-prod`

Planned development bucket: `ads-ops-data-dev`

The bucket is private. Browser users do not receive broad bucket credentials. Upload/download flows go through authenticated Workers or short-lived signed mechanisms where appropriate.

## Prefixes

```text
raw/amazon-ads/{store_code}/{profile_id}/{ad_product}/{report_type}/dt={YYYY-MM-DD}/{amazon_report_id}.json.gz
manual-imports/{store_code}/{YYYY}/{MM}/{upload_id}/{sanitized_filename}
quarantine/{store_code}/{YYYY}/{MM}/{DD}/{ingestion_id}/{object_name}
exports/{store_code}/{YYYY}/{MM}/{DD}/{export_id}/{filename}
exports/cross-store/{YYYY}/{MM}/{DD}/{export_id}/{filename}
backups/d1/{database_name}/{YYYY}/{MM}/{DD}/{snapshot_name}.sql.gz
```

## Raw report contract

For every successfully downloaded Amazon report, `report_jobs.r2_object_key` points to exactly one immutable raw object.

Object metadata should include only non-secret operational metadata:

- `store_code`
- `profile_id`
- `report_type`
- `ad_product`
- `run_id`
- `schema_version`
- `sha256`

No OAuth token, API secret, user email, or authorization header is written to metadata.

## Immutability

Objects under `raw/amazon-ads/` are immutable. If Amazon regenerates a report, save the new report under its own report ID and update the D1 ingestion lineage. Never overwrite historical source evidence in place.

## Manual uploads

Manual uploads are staged under `manual-imports/`. The Worker records uploader user ID, SHA-256, byte size, detected file type, and parsing status in D1. Unsafe filenames are never used as authorization inputs.

## Quarantine

Files that fail schema validation or data-quality gates are moved/copied to `quarantine/` with an issue record in the Store D1. Quarantined data is not merged into fact tables.

## Exports

Generated XLSX/CSV exports are treated as derived artifacts, not source-of-truth data. Export object keys use internal user/store IDs rather than email addresses.

## Retention

V1 does not auto-delete raw Amazon report objects. Retention/lifecycle rules should be set only after actual monthly storage growth is measured and recovery requirements are agreed.
