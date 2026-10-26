/**
 * Evaluate the TicketsManage classifier against the labeled corpus.
 *
 * Usage:
 *   npm run eval:model -- --rules-only          # deterministic stages only
 *   npm run eval:model -- --model qwen2.5:3b    # production fast path
 *   npm run eval:model -- --model qwen2.5:3b --always-semantic  # model every row
 *
 * The script never fabricates a model result: if the requested local model is
 * missing it reports the exact installation command and exits with code 2.
 */
import fs from 'node:fs';
import path from 'node:path';
import { classifyReason } from '../server/classifier/pipeline.js';
import { OllamaClient } from '../server/classifier/ollama.js';
import { CATEGORY_IDS, TAXONOMY_BY_ID } from '../server/classifier/taxonomy.js';
import { APP_ROOT, DATA_DIR, ensureRuntimeDirs } from '../server/config.js';
import type { CategoryId } from '../server/types.js';

interface CorpusRow {
  id: string;
  language: string;
  reason: string;
  expectedCategories: CategoryId[];
  note?: string;
}

interface Corpus {
  version: string;
  description?: string;
  rows: CorpusRow[];
}

interface RowResult {
  id: string;
  language: string;
  reason: string;
  expected: CategoryId[];
  predicted: CategoryId[];
  fallback: boolean;
  method: string;
  reviewRequired: boolean;
  explanation: string;
  exact: boolean;
  missing: CategoryId[];
  extra: CategoryId[];
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function loadCorpus(filePath: string): Corpus {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as Corpus;
  if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) {
    throw new Error(`Corpus ${filePath} has no rows.`);
  }
  for (const row of parsed.rows) {
    if (!row.id || typeof row.reason !== 'string' || !Array.isArray(row.expectedCategories)) {
      throw new Error(`Corpus row is malformed: ${JSON.stringify(row).slice(0, 120)}`);
    }
    for (const category of row.expectedCategories) {
      if (!(CATEGORY_IDS as string[]).includes(category)) {
        throw new Error(`Corpus row ${row.id} names unknown category ${category}.`);
      }
    }
  }
  return parsed;
}

function sameSet(left: CategoryId[], right: CategoryId[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<number> {
  const corpusPath = path.resolve(
    APP_ROOT,
    argument('corpus') ?? 'eval/classification-corpus.json',
  );
  const rulesOnly = hasFlag('rules-only');
  const model = argument('model') ?? process.env.OLLAMA_MODEL ?? 'qwen2.5:3b';
  const ollamaUrl = argument('ollama') ?? process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
  const fuzzyThreshold = Number(argument('threshold') ?? 0.82);
  const limit = Number(argument('limit') ?? 0);

  if (!Number.isFinite(fuzzyThreshold) || fuzzyThreshold <= 0 || fuzzyThreshold > 1) {
    console.error('The fuzzy threshold must be between 0 and 1.');
    return 1;
  }

  const corpus = loadCorpus(corpusPath);
  const rows = limit > 0 ? corpus.rows.slice(0, limit) : corpus.rows;

  let client: OllamaClient | null = null;
  if (!rulesOnly) {
    client = new OllamaClient(ollamaUrl, model);
    const status = await client.status();
    if (!status.running) {
      console.error('');
      console.error('The local semantic model cannot be evaluated: Ollama is not reachable.');
      console.error(`  Expected runtime: ${status.baseUrl}`);
      console.error(`  Error: ${status.error}`);
      console.error('  Fix: start Ollama (ollama serve) and run this command again.');
      console.error('  Offline alternative: npm run eval:model -- --rules-only');
      console.error('');
      return 2;
    }
    if (!status.selectedInstalled) {
      console.error('');
      console.error(
        `The requested model "${model}" is not installed as a local model. Installed local models: ${
          status.localModels.length ? status.localModels.join(', ') : '(none)'
        }`,
      );
      if (status.models.some((item) => item.remote)) {
        console.error('Cloud-hosted models are intentionally not used for private ticket data.');
      }
      console.error(`  Install it with: ollama pull ${model}`);
      console.error('  Offline alternative: npm run eval:model -- --rules-only');
      console.error('');
      return 2;
    }
  }

  const results: RowResult[] = [];
  const started = Date.now();
  for (const row of rows) {
    const classification = await classifyReason(row.reason, 'present', {
      fuzzyThreshold,
      semanticEnabled: !rulesOnly,
      // Evaluation is the only place that may run the model. Live
      // classification never calls it and falls back instead.
      semanticMode: rulesOnly ? 'off' : 'always',
      model: rulesOnly ? null : model,
      suppressSemanticDisabledReview: rulesOnly,
      semantic: client ? (reason) => client.classifyReason(reason) : undefined,
    });
    const rawPredicted = classification.categories.map((category) => category.categoryId);
    // The explicit fallback is not a defensible category match. It is tracked
    // separately so it cannot inflate recall or destroy precision for
    // General Issue, whose real meaning is "a problem affecting many players".
    const predicted = classification.fallback ? [] : rawPredicted;
    const missing = row.expectedCategories.filter((category) => !predicted.includes(category));
    const extra = predicted.filter((category) => !row.expectedCategories.includes(category));
    results.push({
      id: row.id,
      language: row.language,
      reason: row.reason,
      expected: row.expectedCategories,
      predicted,
      fallback: classification.fallback,
      method: classification.method,
      reviewRequired: classification.reviewRequired,
      explanation: classification.explanation,
      exact: sameSet(predicted, row.expectedCategories),
      missing,
      extra,
    });
    process.stdout.write('.');
  }
  process.stdout.write('\n\n');
  const elapsedMs = Date.now() - started;

  const labelled = results.filter((result) => result.expected.length > 0);
  const exactMatches = labelled.filter((result) => result.exact).length;
  const fallbackRows = results.filter((result) => result.fallback);
  const correctlyFallback = fallbackRows.filter((result) => result.expected.length === 0).length;

  const perCategory = CATEGORY_IDS.map((categoryId) => {
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    for (const result of results) {
      const expected = result.expected.includes(categoryId);
      const predicted = result.predicted.includes(categoryId);
      if (expected && predicted) truePositive += 1;
      if (!expected && predicted) falsePositive += 1;
      if (expected && !predicted) falseNegative += 1;
    }
    const precision = truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive);
    const recall = truePositive + falseNegative === 0 ? 0 : truePositive / (truePositive + falseNegative);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { categoryId, truePositive, falsePositive, falseNegative, precision, recall, f1 };
  });

  const microTp = perCategory.reduce((sum, item) => sum + item.truePositive, 0);
  const microFp = perCategory.reduce((sum, item) => sum + item.falsePositive, 0);
  const microFn = perCategory.reduce((sum, item) => sum + item.falseNegative, 0);
  const microPrecision = microTp + microFp === 0 ? 0 : microTp / (microTp + microFp);
  const microRecall = microTp + microFn === 0 ? 0 : microTp / (microTp + microFn);
  const microF1 =
    microPrecision + microRecall === 0
      ? 0
      : (2 * microPrecision * microRecall) / (microPrecision + microRecall);

  const report = {
    generatedAt: new Date().toISOString(),
    mode: rulesOnly ? 'rules-only' : 'hybrid',
    model: rulesOnly ? null : model,
    ollamaUrl: rulesOnly ? null : ollamaUrl,
    fuzzyThreshold,
    corpusPath,
    corpusVersion: corpus.version,
    rows: results.length,
    elapsedMs,
    summary: {
      labelledRows: labelled.length,
      exactSetMatches: exactMatches,
      exactSetAccuracy: labelled.length ? exactMatches / labelled.length : 0,
      microPrecision,
      microRecall,
      microF1,
      fallbackRows: fallbackRows.length,
      correctlyFallback,
      rowsRequiringReview: results.filter((result) => result.reviewRequired).length,
      averageLatencyMs: Math.round(elapsedMs / Math.max(results.length, 1)),
    },
    perCategory,
    failures: results
      .filter((result) => !result.exact)
      .map((result) => ({
        id: result.id,
        reason: result.reason,
        expected: result.expected,
        predicted: result.predicted,
        missing: result.missing,
        extra: result.extra,
        fallback: result.fallback,
        method: result.method,
      })),
    results,
  };

  ensureRuntimeDirs();
  const outDir = path.join(DATA_DIR, 'eval');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(outDir, `eval-${report.mode}-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(`TicketsManage classifier evaluation — ${rulesOnly ? 'RULES ONLY' : `HYBRID (${model})`}`);
  console.log(`Corpus: ${corpusPath} (v${corpus.version}, ${results.length} rows)`);
  console.log('');
  console.log(`Exact set match  ${exactMatches}/${labelled.length}  ${percent(report.summary.exactSetAccuracy)}`);
  console.log(`Micro precision  ${percent(microPrecision)}`);
  console.log(`Micro recall     ${percent(microRecall)}`);
  console.log(`Micro F1         ${percent(microF1)}`);
  console.log(`Fallback rows    ${fallbackRows.length} (${correctlyFallback} expected)`);
  console.log(`Review required  ${report.summary.rowsRequiringReview}/${results.length}`);
  console.log(`Total time       ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log('');
  console.log('Per category:');
  for (const item of perCategory) {
    console.log(
      `  ${TAXONOMY_BY_ID[item.categoryId]!.code.padEnd(30)} P ${percent(item.precision).padStart(6)}  R ${percent(
        item.recall,
      ).padStart(6)}  F1 ${percent(item.f1).padStart(6)}`,
    );
  }
  if (report.failures.length) {
    console.log('');
    console.log('Failures:');
    for (const failure of report.failures) {
      console.log(`  ${failure.id}  ${failure.reason.slice(0, 90)}`);
      console.log(
        `      expected [${failure.expected.join(', ')}] predicted [${failure.predicted.join(', ')}]${
          failure.fallback ? ' (fallback)' : ''
        }`,
      );
    }
  }
  console.log('');
  console.log(`Report saved: ${outPath}`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error('Evaluation failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
