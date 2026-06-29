import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on how it handles very large
// string payloads (10,000+ characters).
//
// Truth-first note: formatCompleteJson imposes NO string length limit and does
// NOT truncate text. String values route through formatValue -> cleanMarkdown,
// which only strips markdown markers (***, **, *, `) and trims surrounding
// whitespace; the remaining characters are emitted in full. There is no
// ellipsis, byte cap, or "... and N more" applied to scalar string fields.
//
// (The only truncation paths in this module are array element caps — e.g.
// holdings.slice(0, 10) — not string-length caps.)

const HUGE = "x".repeat(10_000);

describe("formatCompleteJson — large string payloads", () => {
  it("emits a 10,000+ char top-level string field in full (no truncation)", () => {
    const out = formatCompleteJson({ description: HUGE });
    expect(out).toContain(`Security: ${HUGE}`);
    // The full payload survives: line length is at least the payload length.
    expect(out.length).toBeGreaterThanOrEqual(HUGE.length);
    expect(out).not.toContain("...");
  });

  it("emits a large string inside an object section in full", () => {
    const out = formatCompleteJson({
      account_metadata: {
        institution_name: HUGE,
      },
    });
    expect(out).toContain(`  Institution: ${HUGE}`);
    expect(out).not.toContain("...");
  });

  it("strips markdown markers but preserves the large remaining body", () => {
    const body = "y".repeat(10_000);
    const withMarkdown = `**${body}**`;
    const out = formatCompleteJson({ description: withMarkdown });
    // cleanMarkdown removes the ** wrappers; the 10k body remains intact.
    expect(out).toContain(`Security: ${body}`);
    expect(out).not.toContain("**");
  });

  it("does not throw and remains performant on a very large payload", () => {
    const big = "z".repeat(50_000);
    const start = Date.now();
    const out = formatCompleteJson({ description: big });
    const elapsed = Date.now() - start;
    expect(out).toContain(big);
    // Generous upper bound — this is linear string work, not a parser blow-up.
    expect(elapsed).toBeLessThan(2_000);
  });

  it("preserves embedded newlines within a large multi-line string", () => {
    const block = Array.from({ length: 500 }, (_, i) => `line-${i}`).join("\n");
    const out = formatCompleteJson({ description: block });
    expect(out).toContain("line-0");
    expect(out).toContain("line-499");
  });
});
