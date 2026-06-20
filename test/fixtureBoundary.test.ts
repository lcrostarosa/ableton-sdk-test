import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const runtimeRoots = [
  "src",
  "extension/src",
  "extension/ableton-sdk-mcp/kernel/src",
  "extension/ableton-sdk-mcp/abletonsdk-mcp-server/src",
];

const forbiddenImportChecks = [
  {
    label: "imports test fixtures",
    matches: (statement: string, specifier: string, resolvedSpecifier: string) =>
      specifier.includes("test/fixtures") || resolvedSpecifier.includes("test/fixtures"),
  },
  {
    label: "imports fakeSerum",
    matches: (statement: string, specifier: string, resolvedSpecifier: string) =>
      statement.includes("FakeSerum") || specifier.includes("fakeSerum") || resolvedSpecifier.includes("src/fakeSerum.ts"),
  },
  {
    label: "imports SimAdapter",
    matches: (statement: string, specifier: string, resolvedSpecifier: string) =>
      statement.includes("SimAdapter") || resolvedSpecifier.endsWith("src/adapters.ts"),
  },
];

const requiredAbsentFiles = ["src/fakeSerum.ts", "src/adapters.ts", "runIntent.ts"];

function walkRuntimeFiles(relativeDir: string): string[] {
  const absoluteDir = path.join(rootDir, relativeDir);
  if (!fs.existsSync(absoluteDir)) return [];
  const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(absoluteDir, entry.name);
    const relativePath = path.relative(rootDir, absolutePath);
    if (entry.isDirectory()) {
      files.push(...walkRuntimeFiles(relativePath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!relativePath.endsWith(".ts")) continue;
    if (relativePath.endsWith(".test.ts")) continue;
    files.push(relativePath);
  }
  return files;
}

interface ImportRecord {
  statement: string;
  specifier: string;
}

function extractImportSpecifiers(source: string): ImportRecord[] {
  const imports = new Map<string, ImportRecord>();
  const patterns = [
    /(?<statement>\bimport\s+(?:type\s+)?[\s\S]*?\sfrom\s+["'](?<specifier>[^"']+)["'])/g,
    /(?<statement>\bexport\s+[\s\S]*?\sfrom\s+["'](?<specifier>[^"']+)["'])/g,
    /(?<statement>\bimport\s*\(\s*["'](?<specifier>[^"']+)["']\s*\))/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const statement = match.groups?.statement;
      const specifier = match.groups?.specifier;
      if (statement && specifier) {
        imports.set(`${statement}:${specifier}`, { statement, specifier });
      }
    }
  }
  return [...imports.values()];
}

function normalizeResolvedSpecifier(relativeFile: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const resolved = path.normalize(path.join(path.dirname(relativeFile), specifier));
  return resolved.split(path.sep).join("/");
}

function collectImportViolations(files: string[]): string[] {
  const violations: string[] = [];
  for (const relativeFile of files) {
    const source = fs.readFileSync(path.join(rootDir, relativeFile), "utf8");
    const imports = extractImportSpecifiers(source);
    for (const imported of imports) {
      const resolvedSpecifier = normalizeResolvedSpecifier(relativeFile, imported.specifier);
      for (const check of forbiddenImportChecks) {
        if (check.matches(imported.statement, imported.specifier, resolvedSpecifier)) {
          violations.push(`${relativeFile}: ${check.label} via ${imported.specifier}`);
        }
      }
    }
  }
  return violations;
}

function collectMissingAbsenceViolations(): string[] {
  const violations: string[] = [];
  for (const relativeFile of requiredAbsentFiles) {
    if (fs.existsSync(path.join(rootDir, relativeFile))) {
      violations.push(`${relativeFile}: file must be removed by the fixture migration`);
    }
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  if (packageJson.scripts?.["demo:intent"]) {
    violations.push('package.json#scripts["demo:intent"]: script must be removed by the fixture migration');
  }

  return violations;
}

const runtimeFiles = runtimeRoots.flatMap(walkRuntimeFiles).sort();
const violations = [
  ...collectImportViolations(runtimeFiles),
  ...collectMissingAbsenceViolations(),
];

if (violations.length > 0) {
  console.error("Fixture boundary violations found:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(`Fixture boundary clear across ${runtimeFiles.length} runtime files.`);
