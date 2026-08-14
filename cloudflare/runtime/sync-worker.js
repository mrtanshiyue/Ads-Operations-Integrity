import { NonRetryableError, WorkflowEntrypoint } from 'cloudflare:workers';

const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const ALLOWED_TRIGGER_TYPES = new Set(['scheduled', 'manual', 'recovery', 'backfill']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/health') return new Response('Not found', { status: 404 });

    return Response.json({
      ok: true,
      service: 'ads-operations-sync',
      environment: env.APP_ENV || 'unknown',
      amazonAdsEnabled: env.AMAZON_ADS_ENABLED === 'true',
      dependencies: {
        controlDb: Boolean(env.CONTROL_DB),
        dataBucket: Boolean(env.DATA_BUCKET),
        storeDatabases: configuredStoreDatabaseCount(env),
        workflow: Boolean(env.AMAZON_SYNC_WORKFLOW),
      },
    }, {
      headers: {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  },
};

export class AmazonAdsSyncWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const input = normalizeSyncInput(event?.payload);

    const route = await step.do('resolve store route', async () => {
      const store = await this.env.CONTROL_DB.prepare(`
        SELECT store_id, store_code, d1_binding_key, status
        FROM stores
        WHERE store_id = ?1
        LIMIT 1
      `).bind(input.storeId).first();

      if (!store || store.status !== 'active') {
        throw new NonRetryableError('sync_store_not_active');
      }
      if (!STORE_BINDINGS.has(store.d1_binding_key)) {
        throw new NonRetryableError('sync_store_binding_not_allowed');
      }
      return {
        storeId: store.store_id,
        storeCode: store.store_code,
        bindingKey: store.d1_binding_key,
      };
    });

    const storeDb = resolveStoreDb(this.env, route.bindingKey);
    if (!storeDb) throw new NonRetryableError('sync_store_db_not_bound');

    const profile = await step.do('validate Amazon profile', async () => {
      const row = await storeDb.prepare(`
        SELECT profile_id, marketplace_id, country_code, currency_code, timezone, status
        FROM amazon_profiles
        WHERE profile_id = ?1
        LIMIT 1
      `).bind(input.profileId).first();
      if (!row || row.status !== 'active') {
        throw new NonRetryableError('sync_profile_not_active');
      }
      return row;
    });

    const plan = await step.do('build report plan', async () => {
      const jobs = [];
      for (const dataset of input.datasets) {
        const fingerprint = await sha256Hex(JSON.stringify({
          storeId: input.storeId,
          profileId: input.profileId,
          dataset,
          startDate: input.startDate,
          endDate: input.endDate,
          configVersion: input.reportConfigVersion,
        }));
        jobs.push({
          dataset,
          requestFingerprint: fingerprint,
          idempotencyKey: `amazon-ads:${fingerprint}`,
        });
      }
      return jobs;
    });

    if (this.env.AMAZON_ADS_ENABLED !== 'true') {
      return {
        ok: true,
        mode: 'disabled',
        storeId: route.storeId,
        profileId: profile.profile_id,
        plannedJobs: plan,
        message: 'Amazon Ads adapter is intentionally disabled; no external API call or database mutation was performed.',
      };
    }

    throw new NonRetryableError('amazon_ads_adapter_not_implemented');
  }
}

function normalizeSyncInput(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const storeId = requiredText(input.storeId, 'storeId');
  const profileId = requiredText(input.profileId, 'profileId');
  const startDate = isoDate(input.startDate, 'startDate');
  const endDate = isoDate(input.endDate, 'endDate');
  if (endDate < startDate) throw new NonRetryableError('sync_date_range_invalid');

  const triggerType = String(input.triggerType || 'manual').trim().toLowerCase();
  if (!ALLOWED_TRIGGER_TYPES.has(triggerType)) {
    throw new NonRetryableError('sync_trigger_type_invalid');
  }

  const datasets = [...new Set((Array.isArray(input.datasets) ? input.datasets : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
  if (!datasets.length) throw new NonRetryableError('sync_datasets_required');
  if (datasets.length > 20) throw new NonRetryableError('sync_dataset_limit_exceeded');

  return {
    storeId,
    profileId,
    startDate,
    endDate,
    triggerType,
    datasets,
    reportConfigVersion: String(input.reportConfigVersion || 'v1').trim(),
    requestedBy: String(input.requestedBy || '').trim() || null,
  };
}

function requiredText(value, field) {
  const text = String(value || '').trim();
  if (!text) throw new NonRetryableError(`sync_${field}_required`);
  if (text.length > 200) throw new NonRetryableError(`sync_${field}_too_long`);
  return text;
}

function isoDate(value, field) {
  const text = requiredText(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new NonRetryableError(`sync_${field}_invalid`);
  }
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new NonRetryableError(`sync_${field}_invalid`);
  }
  return text;
}

function resolveStoreDb(env, bindingKey) {
  if (!STORE_BINDINGS.has(bindingKey)) return null;
  return env[bindingKey] || null;
}

function configuredStoreDatabaseCount(env) {
  return [...STORE_BINDINGS].filter((name) => Boolean(env[name])).length;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
