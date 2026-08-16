import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { createAmazonAdsAccessTokenProviderFromEnv } from './amazon-ads-credential-provider.js';
import {
  advanceAmazonAdsReportCycle,
  amazonAdsExecutionEnabled,
  prepareAmazonAdsProducerRuntime,
  resolveAmazonAdsSyncPolicy,
  shouldSleepAfterReportCycleAdvance,
} from './amazon-ads-sync-runtime.js';
import { prepareWorkflowExecution } from './sync-workflow-orchestration.js';
import { assertProducerIntentSupported } from './sync-producer-capability.js';

const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const MAX_REPORT_CYCLE_ADVANCES = 8_000;
const AMAZON_STEP_CONFIG = Object.freeze({
  retries:Object.freeze({ limit:3, delay:'5 seconds', backoff:'exponential' }),
  timeout:'5 minutes',
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/health') return new Response('Not found', { status: 404 });

    return Response.json({
      ok: true,
      service: 'ads-operations-sync',
      environment: env.APP_ENV || 'unknown',
      amazonAdsEnabled: amazonAdsExecutionEnabled(env),
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
      return terminalResult(route, execution.run.status, execution.run.profile_id, 'terminal_receipt_reused');
    }

    // Keep the execution-domain kill switch ahead of capability checks, secret validation,
    // LWA token refresh, Amazon API calls, R2 writes, and Store D1 producer mutations.
    if (!amazonAdsExecutionEnabled(this.env)) {
      return {
        ok: true,
        mode: 'disabled',
        storeId: route.storeId,
        profileId: execution.run.profile_id || null,
        profileStage: execution.profileStage,
        message: 'Amazon Ads producer is intentionally disabled; no Amazon API, R2, or Store D1 producer mutation was performed.',
      };
    }

    try {
      assertProducerIntentSupported(execution.intent);
    } catch (error) {
      throw new NonRetryableError(String(error?.code || error?.message || 'producer_capability_invalid'));
    }

    let credentialProvider;
    let policy;
    try {
      credentialProvider = createAmazonAdsAccessTokenProviderFromEnv(this.env);
      policy = resolveAmazonAdsSyncPolicy(this.env);
    } catch (error) {
      throw new NonRetryableError(String(error?.code || error?.message || 'amazon_ads_sync_configuration_invalid'));
    }

    const bootstrap = await step.do('prepare durable Amazon producer bootstrap', AMAZON_STEP_CONFIG, async () => {
      return prepareAmazonAdsProducerRuntime({
        env:this.env,
        execution,
        route,
        storeDb,
        credentialProvider,
      });
    });

    if (!bootstrap?.profileId || !Number.isSafeInteger(bootstrap.reportJobCount) || bootstrap.reportJobCount < 1) {
      throw new NonRetryableError('amazon_ads_bootstrap_receipt_invalid');
    }

    for (let advanceIndex = 0; advanceIndex < MAX_REPORT_CYCLE_ADVANCES; advanceIndex += 1) {
      const advance = await step.do('advance durable Amazon report cycle', AMAZON_STEP_CONFIG, async () => {
        return advanceAmazonAdsReportCycle({
          env:this.env,
          route,
          storeDb,
          runId:execution.instanceId,
          profileId:bootstrap.profileId,
          credentialProvider,
          policy,
        });
      });

      if (advance.directive === 'RUN_TERMINAL') {
        return terminalResult(route, advance.runStatus, bootstrap.profileId, 'report_cycle_terminal');
      }
      if (advance.directive === 'FINALIZE_RUN' && advance.runStatus) {
        return terminalResult(route, advance.runStatus, bootstrap.profileId, 'report_cycle_finalized');
      }
      if (advance.directive === 'BLOCKED') {
        return {
          ok:false,
          mode:'blocked',
          storeId:route.storeId,
          profileId:bootstrap.profileId,
          runStatus:'running',
          reason:advance.reason,
          jobId:advance.jobId,
        };
      }

      if (shouldSleepAfterReportCycleAdvance(advance)) {
        await step.sleep('wait for Amazon report processing', policy.pollIntervalMs);
      }
    }

    throw new NonRetryableError('sync_report_cycle_advance_budget_exhausted');
  }
}

function terminalResult(route, status, profileId, mode) {
  const runStatus = String(status || '').trim();
  if (!['succeeded', 'partial', 'failed', 'cancelled'].includes(runStatus)) {
    throw new NonRetryableError('sync_terminal_status_invalid');
  }
  return {
    ok:runStatus === 'succeeded',
    mode,
    storeId:route.storeId,
    profileId:profileId || null,
    runStatus,
  };
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
