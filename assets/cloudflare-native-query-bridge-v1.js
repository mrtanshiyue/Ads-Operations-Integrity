(function initCloudflareNativeQueryBridge(global) {
  'use strict';

  const VERSION = '1.5.0';
  const STORE_SOURCE_CONTRACT_VERSION = 'store-targeting-source-v2';
  const CURRENT_BID_SNAPSHOT_SEMANTIC = 'current_entity_mirror';
  const TARGETING_SOURCE_TIMESTAMP_SEMANTIC = 'source_entity_updated_at';
  const STORE_FACT_CONTRACT_VERSION = 'store-search-term-fact-v1';
  const FACT_MIRROR_TIMESTAMP_SEMANTIC = 'latest_local_fact_row_updated_at';
  const STORE_FACT_LINEAGE_CONTRACT_VERSION = 'store-search-term-fact-lineage-v1';
  const STORE_SOURCE_REPORT_CONTRACT_VERSION = 'store-search-term-source-report-v1';
  const STORE_SOURCE_OBJECT_CONTRACT_VERSION = 'store-search-term-source-object-v1';
  const CACHE_TTL_MS = 30000;
  const MAX_ROWS_PER_STORE = 2000;
  const PAGE_LIMIT = 200;
  const cache = new Map();
  let storeCache = null;
  let storeCacheAt = 0;

  function api() {
    if (!global.CloudflareNativeAPI) {
      throw bridgeError(503, 'cloudflare_native_api_not_ready');
    }
    return global.CloudflareNativeAPI;
  }

  function text(value) {
    return String(value ?? '').trim();
  }

  function nullableText(value) {
    if (value === null || value === undefined || value === '') return null;
    return typeof value === 'string' ? value : String(value);
  }

  function number(value) {
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function nullableNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function microsToAmount(value) {
    return number(value) / 1000000;
  }

  function normalizeScope(value) {
    return text(value || 'ALL').toUpperCase() || 'ALL';
  }

  function canonicalDate(value) {
    const date = text(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bridgeError(400, 'date_required');
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw bridgeError(400, 'date_invalid');
    }
    return date;
  }

  async function stores() {
    const now = Date.now();
    if (storeCache && now - storeCacheAt < CACHE_TTL_MS) return storeCache;
    const payload = await api().stores();
    const rows = Array.isArray(payload?.stores) ? payload.stores : [];
    storeCache = rows.map((row) => ({
      storeId: text(row.store_id || row.storeId),
      storeCode: text(row.store_code || row.storeCode).toUpperCase(),
      displayName: text(row.display_name || row.displayName),
      marketplace: text(row.marketplace_code || row.marketplaceCode),
    })).filter((row) => row.storeId);
    storeCacheAt = now;
    return storeCache;
  }

  async function resolveScope(scopeValue) {
    const scope = normalizeScope(scopeValue);
    const rows = await stores();
    if (scope === 'ALL') return rows;
    const normalized = token(scope);
    const selected = rows.filter((row) => [
      row.storeId,
      row.storeCode,
      row.displayName,
    ].some((candidate) => token(candidate) === normalized));
    if (!selected.length) throw bridgeError(403, 'store_scope_not_available');
    return selected;
  }

  function token(value) {
    return text(value).toUpperCase().replace(/[^A-Z0-9]+/g, '');
  }

  function cacheKey(kind, input) {
    return `${kind}:${JSON.stringify(input, Object.keys(input).sort())}`;
  }

  async function cached(kind, input, loader) {
    const key = cacheKey(kind, input);
    const existing = cache.get(key);
    if (existing && Date.now() - existing.createdAt < CACHE_TTL_MS) return existing.value;
    const value = await loader();
    cache.set(key, { createdAt: Date.now(), value });
    return value;
  }

  async function collectStoreSearchTerms(store, options) {
    const rows = [];
    let cursor = null;
    let sourceContractReady = true;
    let factContractReady = true;
    let factLineageContractReady = true;
    let sourceReportContractReady = true;
    let sourceObjectContractReady = true;
    do {
      const payload = await api().searchTermsDaily(store.storeId, {
        startDate: options.from,
        endDate: options.to,
        sort: 'cost',
        limit: PAGE_LIMIT,
        cursor,
      });
      const pageContractReady = validStoreSourceContract(payload?.sourceContract);
      const pageFactContractReady = validStoreFactContract(payload?.factContract);
      const pageFactLineageContractReady = validStoreFactLineageContract(payload?.factLineageContract);
      const pageSourceReportContractReady = validStoreSourceReportContract(payload?.sourceReportContract);
      const pageSourceObjectContractReady = validStoreSourceObjectContract(payload?.sourceObjectContract);
      sourceContractReady = sourceContractReady && pageContractReady;
      factContractReady = factContractReady && pageFactContractReady;
      factLineageContractReady = factLineageContractReady && pageFactLineageContractReady;
      sourceReportContractReady = sourceReportContractReady && pageSourceReportContractReady;
      sourceObjectContractReady = sourceObjectContractReady && pageSourceObjectContractReady;
      const items = Array.isArray(payload?.items) ? payload.items : [];
      for (const item of items) {
        rows.push(toLegacyAdRow(store, item, options, {
          sourceContractReady: pageContractReady,
          factContractReady: pageFactContractReady,
          factLineageContractReady: pageFactLineageContractReady,
          sourceReportContractReady: pageSourceReportContractReady,
          sourceObjectContractReady: pageSourceObjectContractReady,
        }));
        if (rows.length >= MAX_ROWS_PER_STORE) break;
      }
      cursor = payload?.nextCursor || null;
      if (!items.length || rows.length >= MAX_ROWS_PER_STORE) break;
    } while (cursor);
    return {
      rows,
      truncated: Boolean(cursor),
      sourceContractReady,
      factContractReady,
      factLineageContractReady,
      sourceReportContractReady,
      sourceObjectContractReady,
    };
  }

  function validStoreSourceContract(contract) {
    return contract?.schemaVersion === STORE_SOURCE_CONTRACT_VERSION
      && contract?.identityRule === 'keyword_xor_target'
      && contract?.bidUnit === 'micros'
      && contract?.bidNullability === 'preserved'
      && contract?.currentBidMirrorTimestamp === 'synced_at'
      && contract?.targetingSourceTimestamp === 'source_updated_at';
  }

  function validStoreFactContract(contract) {
    return contract?.schemaVersion === STORE_FACT_CONTRACT_VERSION
      && contract?.mirrorTimestamp === 'search_term_daily.updated_at'
      && contract?.mirrorTimestampAggregation === 'max';
  }

  function validStoreFactLineageContract(contract) {
    return contract?.schemaVersion === STORE_FACT_LINEAGE_CONTRACT_VERSION
      && contract?.sourceReportJobId === 'search_term_daily.source_report_job_id'
      && contract?.sourceReportJobAggregation === 'unanimous_non_null';
  }

  function validStoreSourceReportContract(contract) {
    return contract?.schemaVersion === STORE_SOURCE_REPORT_CONTRACT_VERSION
      && contract?.sourceReportJobId === 'report_jobs.job_id'
      && contract?.amazonReportId === 'report_jobs.amazon_report_id'
      && contract?.joinRule === 'validated_source_report_job_id'
      && contract?.contextRule === 'profile_ad_product_date_covered';
  }

  function validStoreSourceObjectContract(contract) {
    return contract?.schemaVersion === STORE_SOURCE_OBJECT_CONTRACT_VERSION
      && contract?.r2ObjectKey === 'report_jobs.r2_object_key'
      && contract?.storageBackend === 'r2'
      && contract?.identityRule === 'validated_source_amazon_report_identity';
  }

  function sourceProvenance(
    item,
    sourceContractReady,
    factContractReady,
    factLineageContractReady,
    sourceReportContractReady,
    sourceObjectContractReady,
  ) {
    const keywordId = text(item?.keywordId);
    const targetId = text(item?.targetId);
    const xorIdentity = Boolean(keywordId) !== Boolean(targetId);
    const expectedKind = keywordId ? 'keyword' : targetId ? 'target' : null;
    const kindMatches = xorIdentity && text(item?.targetingKind).toLowerCase() === expectedKind;
    const identityValid = sourceContractReady
      && item?.targetingIdentityValid === true
      && xorIdentity
      && kindMatches;
    const bidSource = identityValid ? text(item?.bidSource).toLowerCase() : '';
    const bidSourceMatches = bidSource === expectedKind;
    const bidMicros = identityValid && bidSourceMatches ? nullableNumber(item?.currentBidMicros) : null;
    const bidValueShapeValid = item?.currentBidMicros === null
      || item?.currentBidMicros === undefined
      || (Number.isFinite(Number(item.currentBidMicros)) && Number(item.currentBidMicros) >= 0);
    const bidNullabilityPreserved = identityValid && bidSourceMatches && bidValueShapeValid;
    const currentBidSyncedAt = identityValid && bidSourceMatches ? nullableText(item?.currentBidSyncedAt) : null;
    const targetingSourceUpdatedAt = identityValid ? nullableText(item?.targetingSourceUpdatedAt) : null;
    const adProduct = sourceContractReady ? text(item?.adProduct) : '';
    const factMirrorUpdatedAt = factContractReady ? nullableText(item?.factMirrorUpdatedAt) : null;
    const sourceReportJobId = factLineageContractReady ? nullableText(item?.sourceReportJobId) : null;
    const sourceReportJobIdentityValid = factLineageContractReady
      && item?.sourceReportJobIdentityValid === true
      && sourceReportJobId !== null;
    const sourceAmazonReportId = sourceReportContractReady ? nullableText(item?.sourceAmazonReportId) : null;
    const sourceAmazonReportIdentityValid = sourceReportContractReady
      && sourceReportJobIdentityValid
      && item?.sourceAmazonReportIdentityValid === true
      && sourceAmazonReportId !== null;
    const sourceR2ObjectKey = sourceObjectContractReady ? nullableText(item?.sourceR2ObjectKey) : null;
    const sourceR2ObjectIdentityValid = sourceObjectContractReady
      && sourceAmazonReportIdentityValid
      && item?.sourceR2ObjectIdentityValid === true
      && sourceR2ObjectKey !== null;
    return {
      schemaVersion: sourceContractReady ? STORE_SOURCE_CONTRACT_VERSION : '',
      targetingIdentityValid: identityValid,
      targetingKind: identityValid ? expectedKind : null,
      bidSource: bidSourceMatches ? bidSource : null,
      bidNullabilityPreserved,
      bidMicros,
      bidSnapshotSemantic: sourceContractReady ? CURRENT_BID_SNAPSHOT_SEMANTIC : null,
      currentBidSyncedAt,
      currentBidSyncedAtObserved: currentBidSyncedAt !== null,
      targetingSourceUpdatedAt,
      targetingSourceUpdatedAtObserved: targetingSourceUpdatedAt !== null,
      targetingSourceTimestampSemantic: sourceContractReady ? TARGETING_SOURCE_TIMESTAMP_SEMANTIC : null,
      adProductPresent: Boolean(adProduct),
      adProduct,
      factSchemaVersion: factContractReady ? STORE_FACT_CONTRACT_VERSION : '',
      factMirrorUpdatedAt,
      factMirrorUpdatedAtObserved: factMirrorUpdatedAt !== null,
      factMirrorTimestampSemantic: factContractReady ? FACT_MIRROR_TIMESTAMP_SEMANTIC : null,
      factLineageSchemaVersion: factLineageContractReady ? STORE_FACT_LINEAGE_CONTRACT_VERSION : '',
      sourceReportJobIdentityValid,
      sourceReportJobId: sourceReportJobIdentityValid ? sourceReportJobId : null,
      sourceReportJobObserved: sourceReportJobIdentityValid,
      sourceReportSchemaVersion: sourceReportContractReady ? STORE_SOURCE_REPORT_CONTRACT_VERSION : '',
      sourceAmazonReportIdentityValid,
      sourceAmazonReportId: sourceAmazonReportIdentityValid ? sourceAmazonReportId : null,
      sourceAmazonReportObserved: sourceAmazonReportIdentityValid,
      sourceObjectSchemaVersion: sourceObjectContractReady ? STORE_SOURCE_OBJECT_CONTRACT_VERSION : '',
      sourceR2ObjectIdentityValid,
      sourceR2ObjectKey: sourceR2ObjectIdentityValid ? sourceR2ObjectKey : null,
      sourceR2ObjectObserved: sourceR2ObjectIdentityValid,
    };
  }

  function toLegacyAdRow(store, item, options, context = {}) {
    const keywordId = text(item.keywordId);
    const targetId = text(item.targetId);
    const targetingId = keywordId || targetId;
    const targeting = text(item.keywordText) || text(item.targetExpressionText) || targetId;
    const reportDate = canonicalDate(item.reportDate);
    const provenance = sourceProvenance(
      item,
      context.sourceContractReady === true,
      context.factContractReady === true,
      context.factLineageContractReady === true,
      context.sourceReportContractReady === true,
      context.sourceObjectContractReady === true,
    );
    const currentBid = provenance.bidNullabilityPreserved && provenance.bidMicros !== null
      ? microsToAmount(provenance.bidMicros)
      : null;
    return {
      id: [store.storeId, reportDate, item.profileId, item.campaignId, item.adGroupId, targetingId, item.searchTerm].map(text).join('|'),
      storeId: store.storeCode || store.storeId.toUpperCase(),
      date: reportDate,
      campaignId: text(item.campaignId),
      campaign: text(item.campaignName),
      adGroupId: text(item.adGroupId),
      adGroup: text(item.adGroupName),
      targetingId,
      targeting,
      targetingType: text(item.targetType) || (keywordId ? 'KEYWORD' : (targetId ? 'PRODUCT_TARGET' : '')),
      targetingState: provenance.targetingIdentityValid ? text(item.targetingState) : '',
      searchTerm: text(item.searchTerm),
      matchType: text(item.matchType),
      currentBid,
      currentBidSyncedAt: provenance.currentBidSyncedAt,
      targetingSourceUpdatedAt: provenance.targetingSourceUpdatedAt,
      factMirrorUpdatedAt: provenance.factMirrorUpdatedAt,
      sourceReportJobId: provenance.sourceReportJobId,
      sourceAmazonReportId: provenance.sourceAmazonReportId,
      sourceR2ObjectKey: provenance.sourceR2ObjectKey,
      targetBid: null,
      bid: currentBid,
      impressions: number(item.impressions),
      clicks: number(item.clicks),
      spend: microsToAmount(item.costMicros),
      orders: number(item.purchases),
      units: number(item.unitsSold),
      sales: microsToAmount(item.salesMicros),
      adProduct: provenance.adProduct || null,
      advertisedAsin: null,
      advertisedSku: null,
      purchasedAsin: null,
      purchasedSku: null,
      sourceFile: 'cloudflare-d1',
      reportGranularity: 'DAY',
      attributionWindowDays: null,
      bidValueTrusted: false,
      governanceReady: false,
      sourceProvenance: {
        schemaVersion: provenance.schemaVersion,
        targetingIdentityValid: provenance.targetingIdentityValid,
        targetingKind: provenance.targetingKind,
        bidSource: provenance.bidSource,
        bidNullabilityPreserved: provenance.bidNullabilityPreserved,
        bidMicros: provenance.bidMicros,
        bidSnapshotSemantic: provenance.bidSnapshotSemantic,
        currentBidSyncedAt: provenance.currentBidSyncedAt,
        currentBidSyncedAtObserved: provenance.currentBidSyncedAtObserved,
        targetingSourceUpdatedAt: provenance.targetingSourceUpdatedAt,
        targetingSourceUpdatedAtObserved: provenance.targetingSourceUpdatedAtObserved,
        targetingSourceTimestampSemantic: provenance.targetingSourceTimestampSemantic,
        adProductPresent: provenance.adProductPresent,
        factSchemaVersion: provenance.factSchemaVersion,
        factMirrorUpdatedAt: provenance.factMirrorUpdatedAt,
        factMirrorUpdatedAtObserved: provenance.factMirrorUpdatedAtObserved,
        factMirrorTimestampSemantic: provenance.factMirrorTimestampSemantic,
        factLineageSchemaVersion: provenance.factLineageSchemaVersion,
        sourceReportJobIdentityValid: provenance.sourceReportJobIdentityValid,
        sourceReportJobId: provenance.sourceReportJobId,
        sourceReportJobObserved: provenance.sourceReportJobObserved,
        sourceReportSchemaVersion: provenance.sourceReportSchemaVersion,
        sourceAmazonReportIdentityValid: provenance.sourceAmazonReportIdentityValid,
        sourceAmazonReportId: provenance.sourceAmazonReportId,
        sourceAmazonReportObserved: provenance.sourceAmazonReportObserved,
        sourceObjectSchemaVersion: provenance.sourceObjectSchemaVersion,
        sourceR2ObjectIdentityValid: provenance.sourceR2ObjectIdentityValid,
        sourceR2ObjectKey: provenance.sourceR2ObjectKey,
        sourceR2ObjectObserved: provenance.sourceR2ObjectObserved,
      },
      sourceCoverage: {
        backend: 'cloudflare-d1',
        startDate: options.from,
        endDate: options.to,
        grain: 'day',
        aggregatedRange: false,
      },
    };
  }

  function summarizeSourceEvidence(
    rows,
    sourceContractReady,
    factContractReady,
    factLineageContractReady,
    sourceReportContractReady,
    sourceObjectContractReady,
  ) {
    const input = Array.isArray(rows) ? rows : [];
    const provenanceRows = input.map((row) => row?.sourceProvenance || {});
    return {
      schemaVersion: sourceContractReady ? STORE_SOURCE_CONTRACT_VERSION : '',
      rowCount: input.length,
      sourceContractObserved: Boolean(sourceContractReady),
      factSchemaVersion: factContractReady ? STORE_FACT_CONTRACT_VERSION : '',
      factContractObserved: Boolean(factContractReady),
      factLineageSchemaVersion: factLineageContractReady ? STORE_FACT_LINEAGE_CONTRACT_VERSION : '',
      factLineageContractObserved: Boolean(factLineageContractReady),
      sourceReportSchemaVersion: sourceReportContractReady ? STORE_SOURCE_REPORT_CONTRACT_VERSION : '',
      sourceReportContractObserved: Boolean(sourceReportContractReady),
      sourceObjectSchemaVersion: sourceObjectContractReady ? STORE_SOURCE_OBJECT_CONTRACT_VERSION : '',
      sourceObjectContractObserved: Boolean(sourceObjectContractReady),
      targetingIdentityObserved: input.length > 0
        && provenanceRows.every((item) => item.targetingIdentityValid === true),
      bidSourceObserved: input.length > 0
        && provenanceRows.every((item) => item.bidSource === 'keyword' || item.bidSource === 'target'),
      bidNullabilityPreserved: input.length > 0
        && provenanceRows.every((item) => item.bidNullabilityPreserved === true),
      currentBidSnapshotSemantic: sourceContractReady ? CURRENT_BID_SNAPSHOT_SEMANTIC : null,
      currentBidSyncedAtObserved: input.length > 0
        && provenanceRows.every((item) => item.currentBidSyncedAtObserved === true),
      targetingSourceTimestampSemantic: sourceContractReady ? TARGETING_SOURCE_TIMESTAMP_SEMANTIC : null,
      targetingSourceUpdatedAtObserved: input.length > 0
        && provenanceRows.every((item) => item.targetingSourceUpdatedAtObserved === true),
      adProductObserved: input.length > 0
        && provenanceRows.every((item) => item.adProductPresent === true),
      factMirrorTimestampSemantic: factContractReady ? FACT_MIRROR_TIMESTAMP_SEMANTIC : null,
      factMirrorUpdatedAtObserved: input.length > 0
        && provenanceRows.every((item) => item.factMirrorUpdatedAtObserved === true),
      sourceReportJobIdentityObserved: input.length > 0
        && provenanceRows.every((item) => item.sourceReportJobIdentityValid === true),
      sourceReportJobObserved: input.length > 0
        && provenanceRows.every((item) => item.sourceReportJobObserved === true),
      sourceAmazonReportIdentityObserved: input.length > 0
        && provenanceRows.every((item) => item.sourceAmazonReportIdentityValid === true),
      sourceAmazonReportObserved: input.length > 0
        && provenanceRows.every((item) => item.sourceAmazonReportObserved === true),
      sourceR2ObjectIdentityObserved: input.length > 0
        && provenanceRows.every((item) => item.sourceR2ObjectIdentityValid === true),
      sourceR2ObjectObserved: input.length > 0
        && provenanceRows.every((item) => item.sourceR2ObjectObserved === true),
    };
  }

  function adsGovernance(scope, selectedStores, options, truncated, sourceEvidence) {
    return {
      schemaVersion: 'ads-query-governance-v2',
      sourceBackend: 'cloudflare-d1',
      scope,
      stores: selectedStores.map((store) => store.storeCode || store.storeId),
      fromMonth: options.from.slice(0, 7),
      toMonth: options.to.slice(0, 7),
      fileCount: 0,
      truncated: Boolean(truncated),
      dimensions: {
        campaign: true,
        adGroup: true,
        searchTerm: true,
        date: true,
        keywordOrTargetIdentity: sourceEvidence.targetingIdentityObserved ? 'source-observed' : 'partial',
        adProduct: sourceEvidence.adProductObserved,
        currentBid: sourceEvidence.bidSourceObserved && sourceEvidence.bidNullabilityPreserved,
      },
      sourceEvidence,
      readiness: {
        searchTermReady: true,
        targetingIdentityReady: false,
        bidSourceColumnReady: false,
        bidValueNullabilityTrusted: false,
        adProductReady: false,
        advertisedProductIdentityReady: false,
        attributionMaturityReady: false,
        bidGovernanceReady: false,
        campaignStudioReady: false,
      },
      legacyCompatibility: {
        transport: 'cloudflare-native-query-bridge-v1',
        dailyRows: true,
        rangeRows: false,
        bidNullability: 'explicit-null-untrusted',
        bidSnapshot: 'current-entity-mirror-untrusted',
      },
    };
  }

  async function ads(options = {}) {
    const from = canonicalDate(options.from);
    const to = canonicalDate(options.to);
    if (to < from) throw bridgeError(400, 'date_range_invalid');
    const scope = normalizeScope(options.scope);
    const limit = boundedInteger(options.limit, 500, 1, 500);
    const offset = boundedInteger(options.offset, 0, 0, 500000);
    const selectedStores = await resolveScope(scope);
    const fingerprint = { scope, from, to, stores: selectedStores.map((store) => store.storeId), grain: 'day' };

    const collected = await cached('ads', fingerprint, async () => {
      const perStore = await Promise.all(selectedStores.map((store) => collectStoreSearchTerms(store, { from, to })));
      const rows = perStore.flatMap((entry) => entry.rows);
      rows.sort((a, b) => b.spend - a.spend || b.sales - a.sales || b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
      return {
        rows,
        truncated: perStore.some((entry) => entry.truncated),
        sourceContractReady: perStore.length > 0 && perStore.every((entry) => entry.sourceContractReady),
        factContractReady: perStore.length > 0 && perStore.every((entry) => entry.factContractReady),
        factLineageContractReady: perStore.length > 0 && perStore.every((entry) => entry.factLineageContractReady),
        sourceReportContractReady: perStore.length > 0 && perStore.every((entry) => entry.sourceReportContractReady),
        sourceObjectContractReady: perStore.length > 0 && perStore.every((entry) => entry.sourceObjectContractReady),
      };
    });

    const page = collected.rows.slice(offset, offset + limit);
    const nextOffset = offset + page.length < collected.rows.length ? offset + page.length : null;
    const sourceEvidence = summarizeSourceEvidence(
      collected.rows,
      collected.sourceContractReady,
      collected.factContractReady,
      collected.factLineageContractReady,
      collected.sourceReportContractReady,
      collected.sourceObjectContractReady,
    );
    return {
      rows: page,
      nextOffset,
      source: 'query-cloudflare-d1',
      governance: adsGovernance(scope, selectedStores, { from, to }, collected.truncated, sourceEvidence),
    };
  }

  async function overview(options = {}) {
    const from = canonicalDate(options.from);
    const to = canonicalDate(options.to);
    if (to < from) throw bridgeError(400, 'date_range_invalid');
    const scope = normalizeScope(options.scope);
    const selectedStores = await resolveScope(scope);
    const params = { startDate: from, endDate: to };
    if (selectedStores.length === 1) params.storeId = selectedStores[0].storeId;
    const payload = await api().analyticsOverview(params);
    const daily = Array.isArray(payload?.daily) ? payload.daily : [];
    return {
      schemaVersion: '1.0',
      source: 'query-cloudflare-d1',
      scope,
      from,
      to,
      grain: text(options.grain).toLowerCase() === 'month' ? 'month' : 'day',
      series: daily.map((row) => ({
        date: text(row.reportDate),
        impressions: number(row.impressions),
        clicks: number(row.clicks),
        spend: microsToAmount(row.costMicros),
        orders: number(row.purchases),
        units: number(row.unitsSold),
        sales: microsToAmount(row.salesMicros),
      })),
      totals: payload?.totals ? {
        impressions: number(payload.totals.impressions),
        clicks: number(payload.totals.clicks),
        spend: microsToAmount(payload.totals.costMicros),
        orders: number(payload.totals.purchases),
        units: number(payload.totals.unitsSold),
        sales: microsToAmount(payload.totals.salesMicros),
      } : null,
      stores: payload?.stores || [],
      sync: payload?.sync || [],
    };
  }

  async function allTransactions() {
    throw bridgeError(501, 'cloudflare_transactions_not_migrated');
  }

  function boundedInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
  }

  function bridgeError(status, code) {
    const error = new Error(code);
    error.name = 'CloudflareNativeQueryBridgeError';
    error.status = status;
    error.code = code;
    return error;
  }

  const bridge = Object.freeze({
    version: VERSION,
    source: 'query-cloudflare-d1',
    ads,
    overview,
    allTransactions,
    clearCache() {
      cache.clear();
      storeCache = null;
      storeCacheAt = 0;
    },
  });

  Object.defineProperty(global, 'CloudflareNativeQueryBridge', {
    value: bridge,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  Object.defineProperty(global, 'PrivateCloudQuery', {
    value: bridge,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  global.dispatchEvent?.(new CustomEvent('lr:query-client-ready', {
    detail: { version: VERSION, source: 'query-cloudflare-d1' },
  }));
})(window);