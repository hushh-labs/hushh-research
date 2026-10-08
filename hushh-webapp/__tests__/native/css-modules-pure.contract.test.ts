import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// The native iOS/Android build (`npm run cap:build`) compiles with webpack, where Next
// forces CSS-modules "pure" mode: every selector needs a local class or id. A selector
// made only of :global(...) parts fails the native build, but no PR CI lane runs it, so
// it only surfaces when a TestFlight build is cut (it did, from the Wallet dock rule).
const require = createRequire(import.meta.url);
const postcss = require("postcss");
const localByDefault = require("next/dist/compiled/postcss-modules-local-by-default");

const SKIPPED_DIRS = new Set(["node_modules", ".next", "out", "ios", "android", "coverage"]);

function cssModules(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : cssModules(path);
    return /\.module\.(css|scss)$/.test(entry.name) ? [path] : [];
  });
}

async function pureModeError(css: string): Promise<string | null> {
  try {
    await postcss([localByDefault({ mode: "pure" })]).process(css, { from: undefined });
    return null;
  } catch (error) {
    return String((error as { reason?: string }).reason ?? error);
  }
}

describe("CSS modules stay pure for the native webpack build", () => {
  it("accepts every CSS module under the webapp", async () => {
    const root = process.cwd();
    const files = cssModules(root);
    expect(files.length).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const file of files) {
      const error = await pureModeError(readFileSync(file, "utf8"));
      if (error) failures.push(`${relative(root, file)}: ${error}`);
    }
    expect(failures).toEqual([]);
  });

  it("rejects a :global-only selector, so the guard cannot pass vacuously", async () => {
    const error = await pureModeError(
      `:global([data-testid="x"][data-open="true"]):not(:focus-within) { visibility:hidden; }`,
    );
    expect(error).toMatch(/is not pure/);
  });
});
