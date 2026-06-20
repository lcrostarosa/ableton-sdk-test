// Bundles src/extension.ts (and the portable ../../src/*.ts modules it imports —
// intentEngine, proposers, recipes, registry, profiles, liveAdapter, measure, wav,
// centroid) into a single CommonJS file at manifest.entry. esbuild follows the relative imports,
// transpiles the TypeScript, and inlines them, so the packaged artifact is self-contained —
// no node_modules at runtime.
import * as esbuild from "esbuild";
import * as fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const production = process.argv.includes("--production");

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcesContent: false,
  logLevel: "info",
  minify: production,
  sourcemap: !production,
});
