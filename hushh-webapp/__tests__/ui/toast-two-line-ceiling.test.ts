import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A toast is never taller than two lines of text.
 *
 * The reported case was four lines, and the interesting part is where it came
 * from: not a string in this repo's frontend at all, but a backend error that
 * reached the toast through `oneLocationErrorMessage`, whose only length rule
 * is 160 characters. So there are two things to hold, and they are different
 * kinds of thing:
 *
 *   1. The CEILING, in the component. It is the only guarantee, because it is
 *      the only place every string passes through regardless of who wrote it.
 *   2. The COPY, at the call sites. A clamp that truncates is a worse answer
 *      than a sentence that fits, so the strings stay inside the ceiling
 *      rather than relying on it.
 *
 * This test holds both. Without the first, a server message grows the toast
 * again with every frontend string still passing; without the second, the
 * clamp starts eating the ends of sentences and nothing fails.
 */

const WEBAPP = join(__dirname, "..", "..");

/**
 * Characters that fit on two lines.
 *
 * The toast is 22rem wide with 16px of padding a side, and the title is 13px
 * medium: about 45 characters a line on desktop, about 43 on a 360px phone.
 * 86 is the phone number, because the phone is where a toast covers the most
 * of what someone was looking at.
 */
const TWO_LINE_BUDGET = 86;

const TOAST_CALL =
  /toast\.(?:success|error|info|warning|message)\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (
      entry === "node_modules" ||
      entry === ".next" ||
      entry === "__tests__" ||
      entry.startsWith(".")
    ) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("toast two-line ceiling", () => {
  it("clamps the title, which is what almost every toast actually sets", () => {
    const sonner = readFileSync(
      join(WEBAPP, "components", "ui", "sonner.tsx"),
      "utf8",
    );

    // `toast.error("...")` sets the TITLE. It carried no clamp while the
    // description already had one, so the one part everything used was the
    // one part with no ceiling.
    expect(sonner).toMatch(/title:\s*\n?\s*"line-clamp-2 /);
    expect(sonner).toMatch(/description:\s*\n?\s*"line-clamp-1 /);
  });

  it("keeps every literal toast string inside that ceiling", () => {
    const offenders: string[] = [];

    for (const dir of ["app", "components", "lib"]) {
      for (const file of sourceFiles(join(WEBAPP, dir))) {
        const src = readFileSync(file, "utf8");
        for (const match of src.matchAll(TOAST_CALL)) {
          const rendered = match[1]
            .slice(1, -1)
            // A ${name} renders to something; assume a modest display name
            // rather than pretending an interpolation costs nothing.
            .replace(/\$\{[^}]*\}/g, "Xxxxxxxx")
            .replace(/\\n/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          if (rendered.length > TWO_LINE_BUDGET) {
            offenders.push(
              `${file.slice(WEBAPP.length + 1)} (${rendered.length}): ${rendered.slice(0, 80)}…`,
            );
          }
        }
      }
    }

    expect(
      offenders,
      `These toast strings run past two lines. The clamp will cut them, so ` +
        `shorten them instead — put the action first, and leave detail to the ` +
        `screen behind the toast:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("never stacks a description under the title", () => {
    // Two clamped blocks stack, so a toast carrying both reaches three lines.
    // Two is the rule, so a toast is one block: whatever matters goes in the
    // title. 65 call sites were collapsed for this — 23 merged into their
    // title, and 42 whose description was either generic ("Please try again.")
    // or an unbounded server string, which is what made a four-line toast to
    // begin with.
    const offenders: string[] = [];

    for (const dir of ["app", "components", "lib"]) {
      for (const file of sourceFiles(join(WEBAPP, dir))) {
        const src = readFileSync(file, "utf8");
        for (const call of src.matchAll(/\btoast(?:\.\w+)?\s*\(/g)) {
          // Only the options object of THIS call. A `description` in a type
          // annotation or a nested object is none of this rule's business —
          // searching for one without knowing its call is how the first
          // attempt at this ate a function signature.
          const rest = src.slice(call.index! + call[0].length);
          const close = rest.indexOf(");");
          const args = close === -1 ? rest.slice(0, 600) : rest.slice(0, close);
          if (/^[^)]*,\s*\{[^}]*\bdescription\s*:/s.test(args)) {
            const line = src.slice(0, call.index!).split("\n").length;
            offenders.push(`${file.slice(WEBAPP.length + 1)}:${line}`);
          }
        }
      }
    }

    expect(
      offenders,
      `These toasts pass a description, which stacks a second clamped block ` +
        `under the title and takes the toast past two lines. Fold what ` +
        `matters into the title instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
