import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Console diagnostic ratchet for `lib/`.
 *
 * Every `console.log`, `console.info`, and `console.debug` in lib/ is a
 * potential PII / token leakage surface — these calls land in the
 * browser's developer console where they survive across navigation and
 * are visible to anyone the user pairs with, screen-shares to, or
 * remote-supports.
 *
 * The repo has shipped multiple cleanup PRs to remove specific PII from
 * client-side logs (#460 user identity; #397 credential fragments;
 * #464 server-side user IDs). This ratchet locks in the cleanup
 * progress: the count can only go DOWN, never up.
 *
 * If this test fails because you ADDED a console.{log,info,debug}:
 *   - Remove the new call you added, OR
 *   - Downgrade it to `console.warn` / `console.error` if it represents a
 *     legitimate failure path (warn/error are exempt from the ratchet
 *     because they are the documented logging channel for actual
 *     failures, surfaced by the runtime telemetry pipeline).
 *
 * If you intentionally REMOVED some pre-existing console calls in this
 * PR, lower `MAX_DIAGNOSTIC_CONSOLE_CALLS` in this file to lock in the
 * progress.
 *
 * Why warn/error are exempt:
 *   warn/error are routed through the production observability pipeline
 *   (Sentry / GA4 error events) and are intended for legitimate failure
 *   reporting. log/info/debug are NOT — they are dev-time artifacts that
 *   ship to production unintentionally.
 */

const REPO_ROOT = path.resolve(process.cwd());
const LIB_DIR = path.join(REPO_ROOT, "lib");

// As of the introduction of this ratchet, lib/ contains exactly this many
// console.{log,info,debug} calls. The count is allowed to go down but never
// up. To safely raise: do so in the same PR as a documented justification
// reviewed by a code owner.
const MAX_DIAGNOSTIC_CONSOLE_CALLS = 116;

const PATTERN = /console\.(log|info|debug)\b/g;

function walkTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkTypeScriptFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

interface FileCount {
  file: string;
  count: number;
}

function countDiagnosticConsoleCalls(): {
  total: number;
  perFile: FileCount[];
} {
  const files = walkTypeScriptFiles(LIB_DIR);
  let total = 0;
  const perFile: FileCount[] = [];
  for (const file of files) {
    const matches = readFileSync(file, "utf8").match(PATTERN);
    const count = matches?.length ?? 0;
    if (count > 0) {
      total += count;
      perFile.push({ file: path.relative(REPO_ROOT, file), count });
    }
  }
  return { total, perFile };
}

describe("Codebase ratchet — console.{log,info,debug} in lib/", () => {
  it(`enforces a ceiling of ${MAX_DIAGNOSTIC_CONSOLE_CALLS} diagnostic console calls`, () => {
    const { total, perFile } = countDiagnosticConsoleCalls();

    if (total > MAX_DIAGNOSTIC_CONSOLE_CALLS) {
      perFile.sort((a, b) => b.count - a.count);
      const topOffenders = perFile
        .slice(0, 10)
        .map((o) => `    ${String(o.count).padStart(3)}  ${o.file}`)
        .join("\n");

      const message =
        `\n  lib/ now contains ${total} console.{log,info,debug} calls — ` +
        `above the ratchet ceiling of ${MAX_DIAGNOSTIC_CONSOLE_CALLS}.\n\n` +
        `  Top files by count:\n${topOffenders}\n\n` +
        `  These calls can leak PII (emails, UIDs, tokens, payload fragments) ` +
        `to the browser console.\n` +
        `  Options:\n` +
        `    • Remove the new console.{log,info,debug} call(s) you added\n` +
        `    • Downgrade to console.warn / console.error if this is a legitimate failure path\n` +
        `    • If you intentionally removed pre-existing calls, lower\n` +
        `      MAX_DIAGNOSTIC_CONSOLE_CALLS in __tests__/codebase/console-ratchet.test.ts ` +
        `to ${total} in the same PR\n`;

      throw new Error(message);
    }

    expect(total).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CONSOLE_CALLS);
  });

  it("nudges contributors to lower the ceiling when progress has been made", () => {
    const { total } = countDiagnosticConsoleCalls();

    // This assertion never fails (toBeGreaterThanOrEqual 0 is trivially true);
    // it exists so the current count is captured in the test output for
    // reviewers, making it obvious when the ceiling could be lowered.
    if (total < MAX_DIAGNOSTIC_CONSOLE_CALLS) {
      console.warn(
        `[console-ratchet] lib/ now has ${total} diagnostic console calls ` +
          `(ceiling is ${MAX_DIAGNOSTIC_CONSOLE_CALLS}). ` +
          `Consider lowering MAX_DIAGNOSTIC_CONSOLE_CALLS to ${total} in this PR ` +
          `to lock the improvement.`
      );
    }
    expect(total).toBeGreaterThanOrEqual(0);
  });
});