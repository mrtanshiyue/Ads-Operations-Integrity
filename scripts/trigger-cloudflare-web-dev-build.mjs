import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createExactCommitBuild,
  waitForExactSuccessfulBuild,
} from './cloudflare-workers-builds-client.mjs';
import { assertCanonicalMainCi } from './trigger-cloudflare-sync-dev-build.mjs';

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCRIPT_TAG_PATTERN = /^[0-9a-f]{32}$/i;

export class CloudflareWebDevBuildError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'CloudflareWebDevBuildError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Trigger one manual, branchless exact-main Workers Build for ads-operations-web-dev.
 *
 * Unlike the Sync Dev trigger wrapper, Web trigger/script identities are intentionally NOT
 * hard-coded here. Phase 5 requires those Cloudflare identities to be live-read and supplied by
 * the operator immediately before execution. This prevents historical trigger UUIDs from silently
 * becoming deployment authority when Cloudflare configuration may have drifted.
 */
export async function runCloudflareWebDevExactBuild(options = {}) {
  const env = options.env ?? process.env;
  const commitSha = requiredSha(options.commitSha ?? env.GITHUB_SHA);
  const accountId = requiredAccountId(options.accountId ?? env.CLOUDFLARE_ACCOUNT_ID);
  const apiToken = requiredText(options.apiToken ?? env.CLOUDFLARE_API_TOKEN, 'CF_WEB_DEV_BUILD_API_TOKEN_REQUIRED');
  const triggerUuid = requiredUuid(
    options.triggerUuid ?? env.CF_WEB_DEV_BUILD_TRIGGER_UUID,
    'CF_WEB_DEV_BUILD_TRIGGER_UUID_REQUIRED',
  );
  const scriptTag = requiredScriptTag(options.scriptTag ?? env.CF_WEB_DEV_SCRIPT_TAG);
  const fetchImpl = options.fetchImpl ?? fetch;
  if (typeof fetchImpl !== 'function') throw new CloudflareWebDevBuildError('CF_WEB_DEV_BUILD_FETCH_INVALID');

  try {
    await assertCanonicalMainCi({
      fetchImpl,
      githubApi:options.githubApi ?? env.GITHUB_API_URL,
      githubToken:options.githubToken ?? env.GITHUB_TOKEN,
      repository:options.repository ?? env.GITHUB_REPOSITORY,
      commitSha,
      requiredContext:options.requiredContext ?? env.CF_WEB_DEV_REQUIRED_CONTEXT,
    });
  } catch (error) {
    throw new CloudflareWebDevBuildError(
      `CF_WEB_DEV_MAIN_POLICY_FAILED:${String(error?.code || error?.message || 'unknown')}`,
      error,
    );
  }

  let created;
  let accepted;
  try {
    created = await createExactCommitBuild({
      accountId,
      triggerUuid,
      commitSha,
      token:apiToken,
      fetchImpl,
    });
    accepted = await waitForExactSuccessfulBuild({
      accountId,
      triggerUuid,
      workerTag:scriptTag,
      commitSha,
      buildUuid:created.buildUuid,
      token:apiToken,
      fetchImpl,
      attempts:options.attempts ?? env.CF_WEB_DEV_BUILD_ATTEMPTS,
      delayMs:options.delayMs ?? env.CF_WEB_DEV_BUILD_DELAY_MS,
      sleep:options.sleep,
    });
  } catch (error) {
    throw new CloudflareWebDevBuildError(
      `CF_WEB_DEV_BUILD_CLIENT_FAILED:${String(error?.code || error?.message || 'unknown')}`,
      error,
    );
  }

  if (accepted.buildTriggerSource !== 'manual') {
    throw new CloudflareWebDevBuildError('CF_WEB_DEV_BUILD_SOURCE_NOT_MANUAL');
  }
  if (accepted.branch !== null) {
    throw new CloudflareWebDevBuildError('CF_WEB_DEV_BUILD_BRANCH_NOT_EMPTY');
  }

  return Object.freeze({
    ok:true,
    commitSha,
    buildUuid:accepted.buildUuid,
    triggerUuid:accepted.triggerUuid,
    scriptTag:accepted.workerTag,
    buildOutcome:accepted.buildOutcome,
    source:accepted.buildTriggerSource,
  });
}

function requiredSha(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!GIT_SHA_PATTERN.test(text)) throw new CloudflareWebDevBuildError('CF_WEB_DEV_BUILD_SHA_INVALID');
  return text;
}

function requiredAccountId(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(text)) throw new CloudflareWebDevBuildError('CF_WEB_DEV_BUILD_ACCOUNT_ID_REQUIRED');
  return text;
}

function requiredUuid(value, missingCode) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) throw new CloudflareWebDevBuildError(missingCode);
  if (!UUID_PATTERN.test(text)) throw new CloudflareWebDevBuildError('CF_WEB_DEV_BUILD_TRIGGER_UUID_INVALID');
  return text;
}

function requiredScriptTag(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) throw new CloudflareWebDevBuildError('CF_WEB_DEV_SCRIPT_TAG_REQUIRED');
  if (!SCRIPT_TAG_PATTERN.test(text)) throw new CloudflareWebDevBuildError('CF_WEB_DEV_SCRIPT_TAG_INVALID');
  return text;
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new CloudflareWebDevBuildError(code);
  return text;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const result = await runCloudflareWebDevExactBuild({ commitSha:process.env.EXPECTED_GIT_SHA });
  console.log(JSON.stringify(result, null, 2));
}
