import { readFile, writeFile, mkdir } from "node:fs/promises";

const OLD_ORIGIN = "https://amazon-ad-private-api-v2.tanshiyuesir.workers.dev";
const NEW_ORIGIN = "https://amazon-warehouse-cloud-v4.tanshiyuesir.workers.dev";
const OLD_VERSION_GUARD = "!String(health?.version || '').startsWith('3.')";
const NEW_VERSION_GUARD = "!/^(3|4)\\./.test(String(health?.version || ''))";
const OLD_VERSION_ERROR = "Cloudflare Worker 尚未升级到私密仓库 V3 接口";
const NEW_VERSION_ERROR = "私密仓库接口版本不兼容";
const OLD_CHANNEL = "channel: () => 'warehouse-v3'";
const NEW_CHANNEL = "channel: () => 'warehouse-v4-canary'";
const files = ["assets/private-cloud-warehouse-v3.js", "index.html"];
const result = {
  schemaVersion: "1.1",
  generatedAt: new Date().toISOString(),
  branch: "cloud-migration-phase-1",
  oldOrigin: OLD_ORIGIN,
  newOrigin: NEW_ORIGIN,
  supportedApiMajors: [3, 4],
  channel: "warehouse-v4-canary",
  files: [],
  conclusion: "failed",
};

let totalReplacements = 0;
for (const path of files) {
  const source = await readFile(path, "utf8");
  const counts = {
    origin: occurrences(source, OLD_ORIGIN),
    versionGuard: occurrences(source, OLD_VERSION_GUARD),
    versionError: occurrences(source, OLD_VERSION_ERROR),
    channel: occurrences(source, OLD_CHANNEL),
  };
  let output = source
    .split(OLD_ORIGIN).join(NEW_ORIGIN)
    .split(OLD_VERSION_GUARD).join(NEW_VERSION_GUARD)
    .split(OLD_VERSION_ERROR).join(NEW_VERSION_ERROR)
    .split(OLD_CHANNEL).join(NEW_CHANNEL);

  if (output.includes(OLD_ORIGIN)) throw new Error(`${path} still contains the old Worker origin`);
  if (!output.includes(NEW_ORIGIN)) throw new Error(`${path} does not contain the V4 Worker origin`);
  if (output.includes(OLD_VERSION_GUARD)) throw new Error(`${path} still rejects API version 4`);
  if (!output.includes(NEW_VERSION_GUARD)) throw new Error(`${path} does not allow API versions 3 and 4`);
  if (output.includes(OLD_CHANNEL)) throw new Error(`${path} still reports the V3-only channel`);
  if (!output.includes(NEW_CHANNEL)) throw new Error(`${path} does not report the V4 canary channel`);

  if (output !== source) await writeFile(path, output, "utf8");
  const replacements = Object.values(counts).reduce((sum, value) => sum + value, 0);
  totalReplacements += replacements;
  result.files.push({
    path,
    replacements,
    replacementCounts: counts,
    oldOriginAfter: occurrences(output, OLD_ORIGIN),
    newOriginAfter: occurrences(output, NEW_ORIGIN),
    oldVersionGuardAfter: occurrences(output, OLD_VERSION_GUARD),
    newVersionGuardAfter: occurrences(output, NEW_VERSION_GUARD),
    oldChannelAfter: occurrences(output, OLD_CHANNEL),
    newChannelAfter: occurrences(output, NEW_CHANNEL),
  });
}

result.totalReplacements = totalReplacements;
result.conclusion = "passed";
await mkdir(".diagnostics", { recursive: true });
await writeFile(".diagnostics/cloud-v4-canary-origin.json", `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(`V4 canary compatibility patch complete: ${totalReplacements} replacement(s)`);

function occurrences(text, value) {
  return value ? text.split(value).length - 1 : 0;
}
