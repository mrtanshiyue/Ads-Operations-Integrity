import { buildFinalClosureEvidence } from './final-closure-evidence-contract.mjs';
import { collectFinalClosureEvidence as collectV2 } from './final-closure-control-plane-v2.mjs';

const RELEASE_TRACE_WORKFLOW = 'Cloudflare Release Trace';
const RELEASE_TRACE_JOB = Object.freeze({
  development: 'Trace development release',
  production: 'Trace production release',
});

export async function collectFinalClosureEvidence(options = {}) {
  const snapshot = await collectV2(options);
  const repo = requiredText(options.repo || process.env.GITHUB_REPOSITORY, 'FINAL_CLOSURE_GITHUB_REPOSITORY_REQUIRED');
  const githubToken = requiredText(options.githubToken || process.env.GITHUB_TOKEN, 'FINAL_CLOSURE_GITHUB_TOKEN_REQUIRED');
  const fetchImpl = options.fetchImpl || fetch;
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error('FINAL_CLOSURE_GITHUB_REPOSITORY_INVALID');

  const gh = (path) => githubGet({ fetchImpl, githubToken, path });
  const mainSha = String(snapshot?.mainSha || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(mainSha)) throw new Error('FINAL_CLOSURE_MAIN_SHA_INVALID');

  const releaseTrace = {
    development: await verifyEnvironmentReleaseTrace({ gh, owner, name, mainSha, environment: 'development' }),
    production: await verifyEnvironmentReleaseTrace({ gh, owner, name, mainSha, environment: 'production' }),
  };

  return buildFinalClosureEvidence({
    ...snapshot,
    generatedAt: new Date().toISOString(),
    releaseTrace,
  });
}

export async function verifyEnvironmentReleaseTrace({ gh, owner, name, mainSha, environment }) {
  const expectedJobName = RELEASE_TRACE_JOB[environment];
  if (!expectedJobName) throw new Error(`FINAL_CLOSURE_RELEASE_TRACE_ENVIRONMENT_INVALID:${environment}`);
  const artifactName = `cloudflare-release-trace-${environment}-${mainSha}`;
  const artifacts = await findArtifacts({ gh, owner, name, artifactName, maxPages: 10 });
  artifacts.sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));

  let latestCandidate = null;
  for (const artifact of artifacts) {
    const runId = artifact?.workflow_run?.id;
    if (!runId) continue;
    const run = await gh(`/repos/${owner}/${name}/actions/runs/${runId}`);
    if (run?.name !== RELEASE_TRACE_WORKFLOW || run?.event !== 'workflow_run') continue;

    const jobsBody = await gh(`/repos/${owner}/${name}/actions/runs/${runId}/jobs?per_page=100`);
    const jobs = Array.isArray(jobsBody?.jobs) ? jobsBody.jobs : [];
    const job = jobs.find((candidate) => candidate?.name === expectedJobName);
    latestCandidate ||= {
      verified: false,
      artifact: artifactName,
      artifactId: artifact.id,
      runId,
      runConclusion: run?.conclusion || null,
      jobId: job?.id || null,
      jobConclusion: job?.conclusion || null,
    };
    if (job?.conclusion !== 'success') continue;

    return {
      verified: true,
      artifact: artifact.name,
      artifactId: artifact.id,
      runId,
      runConclusion: run?.conclusion || null,
      jobId: job.id,
      jobConclusion: job.conclusion,
      environment,
      targetSha: mainSha,
    };
  }

  return latestCandidate || {
    verified: false,
    artifact: artifactName,
    artifactId: null,
    runId: null,
    runConclusion: null,
    jobId: null,
    jobConclusion: null,
  };
}

async function findArtifacts({ gh, owner, name, artifactName, maxPages }) {
  const found = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const body = await gh(`/repos/${owner}/${name}/actions/artifacts?per_page=100&page=${page}`);
    const artifacts = Array.isArray(body?.artifacts) ? body.artifacts : [];
    found.push(...artifacts.filter((artifact) => artifact?.name === artifactName));
    if (artifacts.length < 100) break;
  }
  return found;
}

async function githubGet({ fetchImpl, githubToken, path }) {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${githubToken}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`FINAL_CLOSURE_GITHUB_GET_FAILED:${response.status}:${path}`);
  return response.json();
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(code);
  return text;
}
