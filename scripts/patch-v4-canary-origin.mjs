import { readFile, writeFile, mkdir } from "node:fs/promises";

const OLD_ORIGIN = "https://amazon-ad-private-api-v2.tanshiyuesir.workers.dev";
const NEW_ORIGIN = "https://amazon-warehouse-cloud-v4.tanshiyuesir.workers.dev";
const files = ["assets/private-cloud-warehouse-v3.js", "index.html"];
const result = {
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  branch: "cloud-migration-phase-1",
  oldOrigin: OLD_ORIGIN,
  newOrigin: NEW_ORIGIN,
  files: [],
  conclusion: "failed",
};

let totalReplacements = 0;
for (const path of files) {
  const source = await readFile(path, "utf8");
  const oldCount = source.split(OLD_ORIGIN).length - 1;
  const existingNewCount = source.split(NEW_ORIGIN).length - 1;
  const output = source.split(OLD_ORIGIN).join(NEW_ORIGIN);
  const finalOldCount = output.split(OLD_ORIGIN).length - 1;
  const finalNewCount = output.split(NEW_ORIGIN).length - 1;
  if (finalOldCount !== 0) throw new Error(`${path} still contains the old Worker origin`);
  if (finalNewCount < 1) throw new Error(`${path} does not contain the V4 Worker origin`);
  if (output !== source) await writeFile(path, output, "utf8");
  totalReplacements += oldCount;
  result.files.push({
    path,
    oldOccurrencesBefore: oldCount,
    newOccurrencesBefore: existingNewCount,
    replacements: oldCount,
    oldOccurrencesAfter: finalOldCount,
    newOccurrencesAfter: finalNewCount,
  });
}

result.totalReplacements = totalReplacements;
result.conclusion = "passed";
await mkdir(".diagnostics", { recursive: true });
await writeFile(".diagnostics/cloud-v4-canary-origin.json", `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(`V4 canary origin patch complete: ${totalReplacements} replacement(s)`);
