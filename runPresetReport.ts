import { readPresetCorpusFile } from "./src/presetCorpusStore.ts";
import {
  buildPresetSimilarityReport,
  formatPresetSimilarityReportText,
  writePresetSimilarityReport,
} from "./src/presetSimilarity.ts";

interface CliOptions {
  corpus: string;
  query: string;
  out?: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let corpus = "";
  let query = "";
  let out: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--corpus") {
      corpus = argv[index + 1] ?? "";
      index++;
      continue;
    }
    if (arg === "--query") {
      query = argv[index + 1] ?? "";
      index++;
      continue;
    }
    if (arg === "--out") {
      out = argv[index + 1] ?? "";
      index++;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!corpus || !query) {
    printHelp();
    throw new Error("Missing required arguments: --corpus and --query");
  }

  return { corpus, query, ...(out ? { out } : {}) };
}

function printHelp(): void {
  process.stdout.write(
    "Usage: node runPresetReport.ts --corpus <path> --query <preset-id> [--out <path>]\n",
  );
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const corpus = readPresetCorpusFile(options.corpus);
  if (!corpus) {
    throw new Error(`Corpus not found: ${options.corpus}`);
  }

  const report = buildPresetSimilarityReport(corpus, options.query);
  const text = formatPresetSimilarityReportText(report);
  const outPath = writePresetSimilarityReport(report, options.out);
  process.stdout.write(text);
  process.stdout.write(`Report JSON: ${outPath}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
