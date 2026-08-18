import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAmazonSearchTermCsv } from '../cloudflare/runtime/csv-search-term-import.js';
import { analyzeCsvImportBatches } from '../cloudflare/runtime/csv-joint-report-analysis.js';

export async function analyzeCsvFiles(filePaths, options = {}) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw cliError('CSV_ANALYSIS_FILES_REQUIRED');
  }

  const uploadedAt = options.uploadedAt || new Date().toISOString();
  const batches = [];
  for (const filePath of filePaths) {
    const csvText = await readFile(filePath, 'utf8');
    const batch = await parseAmazonSearchTermCsv({
      csvText,
      sourceFileName: path.basename(filePath),
      marketplace: options.marketplace || null,
      profileId: options.profileId || null,
      currencyCode: options.currencyCode || null,
      uploadedAt,
    });
    if (!batch.ok) {
      const error = cliError('CSV_ANALYSIS_IMPORT_REJECTED');
      error.details = {
        sourceFileName: batch.sourceFileName,
        validationSummary: batch.validationSummary,
        errors: batch.errors.slice(0, 20),
      };
      throw error;
    }
    batches.push(batch);
  }

  const rules = {};
  if (options.targetAcos != null) rules.targetAcos = options.targetAcos;
  return analyzeCsvImportBatches(batches, { rules });
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(helpText());
    return;
  }

  const result = await analyzeCsvFiles(parsed.files, {
    marketplace: parsed.marketplace,
    profileId: parsed.profileId,
    currencyCode: parsed.currencyCode,
    uploadedAt: parsed.uploadedAt,
    targetAcos: parsed.targetAcos,
  });
  process.stdout.write(`${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`);
}

function parseArgs(argv) {
  const files = [];
  const parsed = {
    files,
    help: false,
    pretty: false,
    marketplace: null,
    profileId: null,
    currencyCode: null,
    uploadedAt: null,
    targetAcos: null,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--pretty') {
      parsed.pretty = true;
      continue;
    }
    if (arg.startsWith('--marketplace=')) {
      parsed.marketplace = requiredFlagValue(arg, '--marketplace=');
      continue;
    }
    if (arg.startsWith('--profile-id=')) {
      parsed.profileId = requiredFlagValue(arg, '--profile-id=');
      continue;
    }
    if (arg.startsWith('--currency=')) {
      parsed.currencyCode = requiredFlagValue(arg, '--currency=').toUpperCase();
      continue;
    }
    if (arg.startsWith('--uploaded-at=')) {
      parsed.uploadedAt = requiredFlagValue(arg, '--uploaded-at=');
      continue;
    }
    if (arg.startsWith('--target-acos=')) {
      const value = Number(requiredFlagValue(arg, '--target-acos='));
      if (!Number.isFinite(value) || value <= 0 || value > 100) throw cliError('CSV_ANALYSIS_TARGET_ACOS_INVALID');
      parsed.targetAcos = value;
      continue;
    }
    if (arg.startsWith('-')) throw cliError('CSV_ANALYSIS_UNKNOWN_FLAG');
    files.push(arg);
  }

  if (!parsed.help && files.length === 0) throw cliError('CSV_ANALYSIS_FILES_REQUIRED');
  return parsed;
}

function requiredFlagValue(arg, prefix) {
  const value = arg.slice(prefix.length).trim();
  if (!value) throw cliError('CSV_ANALYSIS_FLAG_VALUE_REQUIRED');
  return value;
}

function helpText() {
  return [
    'Usage: node scripts/analyze-search-term-csv-files.mjs <report.csv> [more.csv ...] [options]',
    '',
    'Options:',
    '  --target-acos=0.35      Profitability ACoS target used for advisory classification',
    '  --marketplace=US        Supply marketplace only when the CSV does not contain it',
    '  --profile-id=<value>    Supply observed profile scope only when the CSV does not contain it',
    '  --currency=USD          Supply currency only when the CSV does not contain it',
    '  --uploaded-at=<iso>     Deterministic import timestamp for reproducible diagnostics',
    '  --pretty                Pretty-print JSON output',
    '  --help                  Show this help',
    '',
    'Safety: this command reads local CSV files and writes JSON to stdout only.',
    'It does not call Amazon Ads, Cloudflare, D1, R2, or any execution endpoint.',
    '',
  ].join('\n');
}

function cliError(code) {
  const error = new Error(code);
  error.name = 'CsvAnalysisCliError';
  error.code = code;
  return error;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const payload = {
      ok: false,
      error: error?.code || 'CSV_ANALYSIS_FAILED',
      details: error?.details || null,
    };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = 1;
  });
}
