import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Onboarding must never leave the App Router.
 *
 * The vault key is held in memory and nowhere else. A document navigation --
 * `window.location.assign`, a `.href =`, a reload -- tears down the JavaScript
 * context, so the key is gone and the person is sent back to unlock in the
 * middle of setting something up. That is what "Skip setup wiped my session"
 * is: not a lost cookie, a lost process.
 *
 * Every skip, finish and step-completion handler in these trees therefore has
 * to navigate with the Next router (`router.push` / `router.replace`) or with
 * `requestInternalAppNavigation`, which the app's own provider turns into a
 * router call.
 *
 * This is a source scan rather than a behavioural test on purpose: the failure
 * it guards against is a single line reintroduced anywhere in about a hundred
 * files, and no realistic set of rendered cases would catch that.
 */

const WEBAPP_ROOT = path.resolve(__dirname, "..", "..");

/** The trees an onboarding journey actually runs inside. */
const ONBOARDING_TREES = [
  "components/onboarding",
  "components/one-location/onboarding",
  "components/kai/onboarding",
  "app/one/setup",
];

/**
 * Reading `window.location` is fine and common -- the journey guard compares
 * the current path, the flow reports the route it is on. Only the calls that
 * REPLACE the document are banned.
 */
const HARD_NAVIGATION_PATTERNS: { name: string; pattern: RegExp }[] = [
  {
    name: "window.location.assign(…)",
    pattern: /\bwindow\.location\.assign\s*\(/,
  },
  {
    name: "window.location.replace(…)",
    pattern: /\bwindow\.location\.replace\s*\(/,
  },
  {
    name: "window.location.reload(…)",
    pattern: /\bwindow\.location\.reload\s*\(/,
  },
  {
    name: "assignment to window.location",
    pattern: /\bwindow\.location(\.(href|pathname|search|hash))?\s*=[^=]/,
  },
  {
    name: "location.assign / .replace / .reload without window",
    pattern: /(^|[^.\w])location\.(assign|replace|reload)\s*\(/m,
  },
  {
    name: "a document-replacing helper from lib/utils/browser-navigation",
    pattern:
      /import\s*\{[^}]*\b(assignWindowLocation|replaceWindowLocation|reloadWindow)\b[^}]*\}\s*from\s*["'][^"']*browser-navigation["']/s,
  },
];

function sourceFilesUnder(relativeDir: string): string[] {
  const root = path.join(WEBAPP_ROOT, relativeDir);
  if (!fs.existsSync(root)) return [];

  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      found.push(full);
    }
  };
  walk(root);
  return found;
}

describe("onboarding navigates inside the App Router", () => {
  const files = ONBOARDING_TREES.flatMap(sourceFilesUnder);

  it("finds the onboarding trees it is meant to be scanning", () => {
    // A path that silently stops matching would turn this whole file into a
    // test that always passes.
    for (const tree of ONBOARDING_TREES) {
      expect(
        sourceFilesUnder(tree).length,
        `${tree} should contain source files`,
      ).toBeGreaterThan(0);
    }
    expect(files.length).toBeGreaterThan(20);
  });

  it("never replaces the document, which would drop the in-memory vault key", () => {
    const offences: string[] = [];

    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      for (const { name, pattern } of HARD_NAVIGATION_PATTERNS) {
        if (!pattern.test(source)) continue;
        offences.push(`${path.relative(WEBAPP_ROOT, file)} — ${name}`);
      }
    }

    expect(
      offences,
      "Use router.push / router.replace / requestInternalAppNavigation instead:\n" +
        offences.join("\n"),
    ).toEqual([]);
  });
});
