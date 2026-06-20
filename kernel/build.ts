// Bundles src/extension.ts — including the portable engine it reaches through
// ../../../../src/*.ts (liveAdapter, intentEngine, recipes, registry, measure, wav) and the
// `ws` WebSocket server — into a single CommonJS file at manifest.entry, so the packaged
// extension is self-contained with no node_modules at runtime.
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
