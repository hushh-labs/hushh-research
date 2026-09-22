#!/usr/bin/env node
/**
 * Remove the webpack persistent cache before a native export build.
 *
 * The native export runs `next build --webpack`. With the cache present at
 * .next/cache/webpack, the CSS asset for the Tailwind entry came back stale
 * after app/globals.css changed and after a new utility class appeared in a
 * TypeScript file (Tailwind's content scan is not among the cache's
 * invalidation inputs): the bundle's JS referenced classes the stylesheet
 * did not contain. A clean build costs a few minutes; a stale stylesheet on
 * a phone costs a wrong measurement. verify-native-css-fresh.mjs remains
 * the backstop.
 */
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.cwd(), ".next", "cache", "webpack");
if (fs.existsSync(dir)) {
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`clear-webpack-cache: removed ${path.relative(process.cwd(), dir)}`);
} else {
  console.log("clear-webpack-cache: nothing to remove");
}
