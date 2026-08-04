import { createHash } from "node:crypto";
import process from "node:process";

const v3Origin = String(process.env.V3_ORIGIN || "https://amazon-ad-private-api-v2.tanshiyuesir.workers.dev").replace(/\/$/, "");
const v4Origin = required("V4_ORIGIN").replace(/\/$/, "");
const password = required("WAREHOUSE_PASSWORD");
const scope = String(process.env.SCOPE || "ALL").trim().toUpperCase();
const fullCompare = /^(1|true|yes)$/i.test(process.env.FULL_COMPARE || "false");

const [v3Health, v4Health] = await Promise.all([
  fetchJson(v3Origin, "/api/v1/health"),
  fetchJson(v4Origin, "/api/v1/health")
]);

assert(v3Health?.ok && String(v3Health.version || "").startsWith("3."), "V3 health contract failed");
assert(v4Health?.ok && String(v4Health.version || "").startsWith("4."), "V4 health contract failed");

const [v3Manifest, v4Manifest] = await Promise.all([
  fetchJson(v3Origin, `/api/v1/manifest?scope=${encodeURIComponent(scope)}`),
  fetchJson(v4Origin, `/api/v1/manifest?scope=${encodeURIComponent(scope)}`)
]);

const v3Files = indexManifest(v3Manifest);
const v4Files = indexManifest(v4Manifest);
const keys = [...new Set([...v3Files.keys(), ...v4Files.keys()])].sort();
const differences = [];

for (const key of keys) {
  const left = v3Files.get(key);
  const right = v4Files.get(key);
  if (!left) {
    differences.push(`${key}: missing from V3`);
    continue;
  }
  if (!right) {
    differences.push(`${key}: missing from V4`);
    continue;
  }
  if (String(left.dataType || "") !== String(right.dataType || "")) {
    differences.push(`${key}: dataType ${left.dataType} != ${right.dataType}`);
  }
  const leftRows = Number(left.rowCount || 0);
  const rightRows = Number(right.rowCount || 0);
  if (leftRows && rightRows && leftRows !== rightRows) {
    differences.push(`${key}: rowCount ${leftRows} != ${rightRows}`);
  }
  const isTransaction = String(left.dataType || "").toLowerCase() === "transactions";
  if (!isTransaction && Number(left.size || 0) && Number(right.size || 0) && Number(left.size) !== Number(right.size)) {
    differences.push(`${key}: size ${left.size} != ${right.size}`);
  }

  if (fullCompare && !isTransaction) {
    const [leftHash, rightHash] = await Promise.all([
      fetchSha256(v3Origin, left.url),
      fetchSha256(v4Origin, right.url)
    ]);
    if (leftHash !== rightHash) differences.push(`${key}: byte hash mismatch`);
  }
}

console.log(JSON.stringify({
  scope,
  v3Version: v3Health.version,
  v4Version: v4Health.version,
  v3Files: v3Files.size,
  v4Files: v4Files.size,
  fullCompare,
  differences
}, null, 2));

if (differences.length) process.exitCode = 1;

function indexManifest(manifest) {
  const map = new Map();
  for (const file of Array.isArray(manifest?.files) ? manifest.files : []) {
    const key = [file.storeId, file.month, file.reportType].map(value => String(value || "")).join("|");
    if (!key.includes("||")) map.set(key, file);
  }
  return map;
}

async function fetchJson(origin, path) {
  const response = await authenticatedFetch(origin, path);
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
  if (!response.ok) throw new Error(`${origin}${path}: ${payload.error || text || `HTTP ${response.status}`}`);
  return payload;
}

async function fetchSha256(origin, path) {
  const response = await authenticatedFetch(origin, path);
  if (!response.ok) throw new Error(`${origin}${path}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return createHash("sha256").update(buffer).digest("hex");
}

function authenticatedFetch(origin, path) {
  return fetch(`${origin}${normalizePath(path)}`, {
    headers: {
      "Authorization": `Bearer ${password}`,
      "X-Dashboard-Password": password
    },
    cache: "no-store"
  });
}

function normalizePath(path) {
  const value = String(path || "/");
  if (value.startsWith("/api/v1/")) return value;
  if (value === "/api/v1") return value;
  return `/api/v1${value.startsWith("/") ? value : `/${value}`}`;
}

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
