import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { prepareWorkflowExecution } from './sync-workflow-orchestration.js';
import { assertProducerIntentSupported } from './sync-producer-capability.js';

const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);

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
    const route = await step.do('resolve store route', async () => {
      const storeId = requiredPayloadStoreId(event?.payload);
      const store = await this.env.CONTROL_DB.prepare(`
        SELECT store_id, store_code, marketplace_code, amazon_region, d1_binding_key, status
        FROM stores
        WHERE store_id = ?1
        LIMIT 1
      `).bind(storeId).first();

      if (!store || store.status !== 'active') {
        throw new NonRetryableError('sync_store_not_active');
      }
      if (!STORE_BINDINGS.has(store.d1_binding_key)) {
        throw new NonRetryableError('sync_store_binding_not_allowed');
      }
      return {
        storeId: store.store_id,
        storeCode: store.store_code,
        marketplaceCode: store.marketplace_code,
        amazonRegion: store.amazon_region,
        bindingKey: store.d1_binding_key,
      };
    });

    const storeDb = resolveStoreDb(this.env, route.bindingKey);
    if (!storeDb) throw new NonRetryableError('sync_store_db_not_bound');

    const execution = await step.do('load durable sync intent receipt', async () => {
      try {
        return await prepareWorkflowExecution({
          eventInstanceId: event?.instanceId,
          payload: event?.payload,
          repository: {
            async loadRun(runId) {
              return storeDb.prepare(`
                SELECT run_id, profile_id, trigger_type, status, requested_by, intent_fingerprint,
                       started_at, completed_at, stats_json, error_summary, created_at
                FROM sync_runs
                WHERE run_id = ?1
                LIMIT 1
              `).bind(runId).first();
            },
          },
        });
      } catch (error) {
        throw new NonRetryableError(String(error?.code || error?.message || 'sync_intent_receipt_invalid'));
      }
    });

    if (execution.profileStage === 'REUSE_TERMINAL') {
      return {
        ok: execution.run.status === 'succeeded',
        mode: 'terminal_receipt_reused',
        storeId: route.storeId,
        profileId: execution.run.profile_id || null,
        runStatus: execution.run.status,
      };
    }

    // Kill switch remains ahead of every producer capability check and producer-side mutation.
    if (this.env.AMAZON_ADS_ENABLED !== 'true') {
      return {
        ok: true,
        mode: 'disabled',
        storeId: route.storeId,
        profileId: execution.run.profile_id || null,
        profileStage: execution.profileStage,
        message: 'Amazon Ads producer is intentionally disabled; no Amazon API, R2, or Store D1 producer mutation was performed.',
      };
    }

    // Fail closed before profile/entity/report/R2/fact production when the durable intent
    // contains a dataset for which this producer has no complete contract yet.
    try {
      assertProducerIntentSupported(execution.intent);
    } catch (error) {
      throw new NonRetryableError(String(error?.code || error?.message || 'producer_capability_invalid'));
    }

    if (execution.profileStage === 'RESOLVE_CANONICAL_PROFILE') {
      throw new NonRetryableError('amazon_profile_adapter_not_implemented');
    }

    throw new NonRetryableError('amazon_ads_adapter_not_implemented');
  }
}

function requiredPayloadStoreId(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const storeId = String(input.storeId || '').trim();
  if (!storeId) throw new NonRetryableError('sync_storeId_required');
  if (storeId.length > 200) throw new NonRetryableError('sync_storeId_too_long');
  return storeId;
}

function resolveStoreDb(env, bindingKey) {
  if (!STORE_BINDINGS.has(bindingKey)) return null;
  return env[bindingKey] || null;
}

function configuredStoreDatabaseCount(env) {
  return [...STORE_BINDINGS].filter((name) => Boolean(env[name])).length;
}
