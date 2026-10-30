import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

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
  it("keeps native products out of Tailwind discovery without dropping authored UI classes", async () => {
    const root = process.cwd();
    const directives = readFileSync(join(root, "app/globals.css"), "utf8").match(/^@source not .+;$/gm) ?? [];
    const compiled = await compile(`@import "tailwindcss";\n${directives.join("\n")}`, { base: join(root, "app"), onDependency: () => undefined });
    const fixture = mkdtempSync(join(tmpdir(), "hussh-native-css-source-"));
    try {
      mkdirSync(join(fixture, "app"));
      const files = [
        ["components/Panel.tsx", "min-h-11"],
        ["ios/App/build/Candidate/output.tsx", "z-[99101]"],
        ["android/app/build/output.tsx", "z-[99102]"],
        ["out/index.html", "z-[99103]"],
        [".next-fixture/output.tsx", "z-[99104]"],
      ];
      for (const [name, value] of files) {
        const file = join(fixture, name!);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `<div className="${value}"></div>`);
      }
      const authored = { base: fixture, pattern: "**/*", negated: false };
      const excluded = compiled.sources.filter(source => source.negated).map(source => ({
        ...source, base: resolve(fixture, relative(root, source.base)),
      }));
      const scanner = new Scanner({ sources: [authored, ...excluded] });
      const candidates = new Set(scanner.scan());
      expect(candidates.has("min-h-11")).toBe(true);
      for (const [, value] of files.slice(1)) expect(candidates.has(value!)).toBe(false);
      expect(scanner.files.some(file => file.startsWith(join(fixture, "ios")))).toBe(false);
      // Negative control: absent the authored exclusions, native output enters
      // the real installed scanner, matching the observed runaway export.
      expect(new Scanner({ sources: [authored] }).scan()).toContain("z-[99101]");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

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
