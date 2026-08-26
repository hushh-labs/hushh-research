/**
 * The four PDF themes are a published contract, and every one of them must resolve.
 *
 * `light` · `dark` · `molten-gold-light` · `molten-gold` — two Foundation grounds crossed
 * with two accents. Documents already in circulation name these strings (the DocuSign
 * document is `molten-gold-light`), so the names are an external contract, not an
 * implementation detail.
 *
 * This exists because two of the four were broken at once and nothing noticed:
 *
 *   - `molten-gold-light` was not defined at all. The gold LIGHT token block existed in
 *     globals.css, but the exporter hardcoded `useDarkFoundation = theme !== "light"`,
 *     so gold could only ever pair with a dark ground.
 *   - `dark` threw `Missing Morphy accent token(s)` for all seven accent names — every
 *     time it had ever been invoked. `globals.css` declares `.dark` several times by
 *     design, and the resolver sampled only the FIRST and LAST blocks; the one carrying
 *     the `--app-accent-*` family sat between them and was silently dropped.
 *
 * Both are the same class of defect this codebase keeps finding: a component that passes
 * inspection and has never executed. So this test asserts the RESOLUTION, not the
 * palette — it runs the real token extraction against the real globals.css and checks
 * that each theme produces a complete, correctly-grounded accent set.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PDF_FORMATTER_THEMES,
  createPdfDocumentFormatter,
} from "@/lib/morphy-ux/pdf-document-formatter.mjs";
// The REAL resolver, not a copy. A test that reimplements token resolution passes while
// the resolver is broken -- which is precisely how `dark` survived every prior run.
import { resolveFormatter } from "../../scripts/reports/export-markdown-pdf.mjs";

const REPO_ROOT = path.resolve(__dirname, "../..");
const GLOBALS = path.join(REPO_ROOT, "app/globals.css");

/** Mirrors the exporter's extraction so the test exercises the real CSS, not a fixture. */
function extractBlock(source: string, selector: string, startAt = 0): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escaped}\\s*\\{`, "m");
  const match = pattern.exec(source.slice(startAt));
  if (!match) throw new Error(`Missing selector: ${selector}`);
  const open = startAt + match.index + match[0].lastIndexOf("{");
  let depth = 0;
  let commentOpen = false;
  let quote: string | null = null;
  for (let i = open; i < source.length; i += 1) {
    const character = source[i];
    const next = source[i + 1];
    if (commentOpen) {
      if (character === "*" && next === "/") {
        commentOpen = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (character === "\\") {
        i += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      commentOpen = true;
      i += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`Unterminated block: ${selector}`);
}

function readTokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, name, value] of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[name] = value.trim();
  }
  return out;
}

function mergeAll(source: string, selector: string): Record<string, string> {
  const merged: Record<string, string> = {};
  let cursor = 0;
  for (;;) {
    let block: string;
    try {
      block = extractBlock(source, selector, cursor);
    } catch {
      break;
    }
    Object.assign(merged, readTokens(block));
    const next = source.indexOf(block, cursor);
    if (next < 0) break;
    cursor = next + block.length;
  }
  return merged;
}

async function resolve(theme: string) {
  const globals = await readFile(GLOBALS, "utf8");
  const dark = !theme.endsWith("light");
  const foundation = dark
    ? { ...readTokens(extractBlock(globals, ":root")), ...mergeAll(globals, ".dark") }
    : readTokens(extractBlock(globals, ":root"));
  const rootAccent = readTokens(extractBlock(globals, ":root"));
  const accent =
    theme === "molten-gold"
      ? readTokens(extractBlock(globals, 'html[data-accent="gold"].dark'))
      : theme === "molten-gold-light"
        ? readTokens(extractBlock(globals, 'html[data-accent="gold"]'))
        : dark
          ? { ...rootAccent, ...mergeAll(globals, ".dark") }
          : rootAccent;
  return { foundation, accent };
}

describe("PDF theme canon", () => {
  it("declares exactly the four contracted themes, in order", () => {
    expect([...PDF_FORMATTER_THEMES]).toEqual([
      "light",
      "dark",
      "molten-gold-light",
      "molten-gold",
    ]);
  });

  it.each([...PDF_FORMATTER_THEMES])("%s resolves through the real exporter", async (theme) => {
    // resolveFormatter reads globals.css, picks the ground and accent, and constructs
    // the formatter -- which validates both token sets and throws BY NAME on any gap.
    // That whole chain is the assertion; this is the case that catches a resolver
    // regression, because it runs the shipped code rather than a mirror of it.
    await expect(resolveFormatter(theme, undefined)).resolves.toBeTruthy();
  });

  it("pairs each accent with the correct ground", async () => {
    // Gold on light must read the LIGHT gold block, not the dark one. Before the fix
    // there was no way to express this pairing at all.
    const goldLight = await resolve("molten-gold-light");
    const goldDark = await resolve("molten-gold");

    expect(goldLight.accent["--app-accent-deep"]).toBe("#b8894d");
    expect(goldDark.accent["--app-accent-deep"]).toBe("#e6b366");
    expect(goldLight.accent["--app-accent-deep"]).not.toBe(goldDark.accent["--app-accent-deep"]);
  });

  it("gives the dark theme a complete accent family", async () => {
    // The precise regression: these seven names were all missing for `dark`.
    const { accent } = await resolve("dark");
    for (const token of [
      "--app-accent-deep",
      "--app-accent-bright",
      "--app-accent-surface",
      "--app-accent-border",
      "--app-accent-hero-from",
      "--app-accent-hero-mid",
      "--app-accent-hero-to",
    ]) {
      expect(accent[token], `dark theme is missing ${token}`).toBeTruthy();
    }
  });

  it("resolves the executive profile through the real formatter", async () => {
    await expect(resolveFormatter("light", "executive")).resolves.toMatchObject({ id: "executive" });
  });

  it("refuses a theme outside the canon", async () => {
    const { foundation, accent } = await resolve("light");
    expect(() =>
      createPdfDocumentFormatter({ theme: "molten-gold-dark", profile: undefined, foundation, accent }),
    ).toThrow(/Unsupported PDF formatter theme/);
  });
});
