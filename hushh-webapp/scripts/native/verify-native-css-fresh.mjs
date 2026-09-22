#!/usr/bin/env node
/**
 * Refuse a stale stylesheet in the native export.
 *
 * The webpack persistent cache (.next/cache/webpack, shared by the web build
 * and the native export) handed back an old CSS asset after app/globals.css
 * changed: three device runs shipped JavaScript that referenced rules the
 * stylesheet did not contain. This renders globals.css through the same
 * Tailwind PostCSS pipeline and checks that every rule selector it produces
 * is present in the export's stylesheets. Missing selectors mean the build
 * served cached CSS: clear .next/cache/webpack and rebuild.
 *
 *   node scripts/native/verify-native-css-fresh.mjs [--export .next-native-uat] [--json]
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");

const args = process.argv.slice(2);
const take = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const root = process.cwd();
const exportDir = path.resolve(root, take("--export") ?? process.env.NEXT_DIST_DIR ?? ".next-native-uat");
const cssDir = path.join(exportDir, "_next", "static", "css");
if (!fs.existsSync(cssDir)) {
  console.error(`verify-native-css-fresh: no stylesheets under ${cssDir}; run npm run cap:build first.`);
  process.exit(1);
}
const normalize = (s) => s.replace(/\s+/g, "");
const exported = normalize(
  fs.readdirSync(cssDir).filter((f) => f.endsWith(".css")).map((f) => fs.readFileSync(path.join(cssDir, f), "utf8")).join("\n"),
);

const source = fs.readFileSync(path.join(root, "app/globals.css"), "utf8");
process.env.NODE_ENV = process.env.NODE_ENV || "production";
const result = await postcss([tailwind({})]).process(source, { from: path.join(root, "app/globals.css") });
const selectors = new Set();
postcss.parse(result.css).walkRules((rule) => {
  // Layer and media wrappers do not change the selector text; keyframe
  // steps are not selectors.
  if (rule.parent?.type === "atrule" && /keyframes/.test(rule.parent.name)) return;
  for (const selector of rule.selectors) selectors.add(normalize(selector));
});
const missing = [...selectors].filter((selector) => !exported.includes(selector));
const summary = { selectors: selectors.size, missing: missing.length, sample: missing.slice(0, 8) };
if (args.includes("--json")) console.log(JSON.stringify(summary));
else console.log(`verify-native-css-fresh: ${selectors.size} selectors from globals.css, ${missing.length} missing from the export${missing.length ? `\n  ${missing.slice(0, 8).join("\n  ")}` : ""}`);
if (missing.length) {
  console.error("The native export's stylesheet is stale. Clear .next/cache/webpack and run npm run cap:build again.");
  process.exit(1);
}
