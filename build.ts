// Bundles src/extension/index.ts (and everything it imports from src/extension/,
// src/common/, and node_modules ws) into a single CommonJS file at manifest.entry.
// esbuild follows the relative imports, transpiles TypeScript, and inlines them so the
// packaged artifact is self-contained — no node_modules at runtime.
import * as esbuild from "esbuild";
import * as fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const production = process.argv.includes("--production");

await esbuild.build({
  entryPoints: ["src/extension/index.ts"],
  outfile: manifest.entry,
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcesContent: false,
  logLevel: "info",
  minify: production,
  sourcemap: !production,
});
