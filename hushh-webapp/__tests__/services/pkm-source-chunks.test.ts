import { describe, expect, it } from "vitest";
import {
  planPkmSourceChunks,
  planPkmSourceSelection,
  sourceChunkRange,
  sourceChunkText,
  splitPkmSourceChunk,
} from "@/lib/pkm/pkm-source-chunks";

describe("source-preserving Memory transport planning", () => {
  it("treats numbered one-line facts as bounded items rather than heading-only lines", () => {
    const source = Array.from(
      { length: 33 },
      (_, index) => `${index + 1}. I prefer synthetic option ${index}.`,
    ).join("\n");
    const chunks = planPkmSourceChunks(source);
    expect(chunks).toHaveLength(6);
    expect(chunks.map((chunk) => sourceChunkText(source, chunk)).join("")).toBe(
      source,
    );
  });
  it("packs 33 labeled fields into six requests without losing exact source spans", () => {
    const source = Array.from(
      { length: 33 },
      (_, index) => `Field: synthetic ${index}`,
    ).join("\r\n");
    const chunks = planPkmSourceChunks(source);
    expect(chunks).toHaveLength(6);
    expect(chunks.map((chunk) => sourceChunkText(source, chunk)).join("")).toBe(
      source,
    );
    expect(sourceChunkRange(chunks[0]!)).toEqual({
      start: 0,
      end: source.indexOf("Field: synthetic 6"),
    });
  });
  it("keeps headings and qualifications with their body during retries", () => {
    const source =
      "# Project — proposed\r\nRole: Editor, not appointed.\r\n\r\n# Owner — history\r\nRole: Analyst until 2021.";
    const chunks = planPkmSourceChunks(source);
    const children = splitPkmSourceChunk(source, chunks[0]!)!;
    expect(
      children.map((chunk) => sourceChunkText(source, chunk)).join(""),
    ).toBe(source);
    expect(sourceChunkText(source, children[0]!)).toContain(
      "# Project — proposed\r\nRole:",
    );
    expect(sourceChunkText(source, children[1]!)).toContain(
      "# Owner — history\r\nRole:",
    );
    expect(splitPkmSourceChunk(source, children[0]!)).toBeNull();
  });
  it("does not detach nested headings or split a protected long section", () => {
    const source = "# Project\n## Proposed\nRole: " + "synthetic ".repeat(800);
    const chunks = planPkmSourceChunks(source);
    expect(chunks).toHaveLength(1);
    expect(sourceChunkText(source, chunks[0]!)).toBe(source);
    expect(splitPkmSourceChunk(source, chunks[0]!)).toBeNull();
  });
  it("splits a protected section with more facts than one proposal between whole lines, keeping its heading", () => {
    const bullets = Array.from({ length: 12 }, (_, index) => `- **Synthetic item ${index}:** value ${index}`);
    const source = `## Synthetic preferences\n${bullets.join("\n")}\n`;
    const [chunk] = planPkmSourceChunks(source);
    const children = splitPkmSourceChunk(source, chunk!)!;
    expect(children).toHaveLength(2);
    const [first, second] = children.map((child) => sourceChunkText(source, child));
    expect(first!.startsWith("## Synthetic preferences\n")).toBe(true);
    expect(second!.startsWith("## Synthetic preferences\n- **Synthetic item")).toBe(true);
    // Coverage ranges tile the section exactly once; the carried heading is not covered twice.
    expect(sourceChunkRange(children[0]!).end).toBe(sourceChunkRange(children[1]!).start);
    expect(source.slice(sourceChunkRange(children[1]!).start)).not.toContain("## Synthetic");
    for (const bullet of bullets) {
      expect([first, second].filter((text) => text!.includes(`${bullet}\n`))).toHaveLength(1);
    }
    // Recursion ends at one statement per proposal; a single line is never cut.
    let queue = children;
    for (let round = 0; round < 8; round++) {
      queue = queue.flatMap((child) => splitPkmSourceChunk(source, child) ?? [child]);
    }
    expect(queue).toHaveLength(12);
    expect(queue.every((child) => sourceChunkText(source, child).startsWith("## Synthetic preferences\n"))).toBe(true);
  });
  it("carries the innermost heading path, not a sibling heading, into a later split", () => {
    const source = [
      "# Synthetic profile", "## Health", "- Detail A", "- Detail B",
      "## Food", "- Detail C", "- Detail D", "- Detail E", "- Detail F",
    ].join("\n");
    const [chunk] = planPkmSourceChunks(source);
    let later = splitPkmSourceChunk(source, chunk!)![1]!;
    while (!sourceChunkText(source, later).includes("- Detail F\n") && !sourceChunkText(source, later).endsWith("- Detail F")) {
      later = splitPkmSourceChunk(source, later)![1]!;
    }
    const text = sourceChunkText(source, later);
    expect(text.startsWith("# Synthetic profile\n## Food\n")).toBe(true);
    expect(text).not.toContain("## Health");
  });
  it("re-plans one reported span for a retry and refuses a span outside the note", () => {
    const source = "1. Section one\nFact one.\n\n2. Section two\nFact two.";
    const start = source.indexOf("2. Section two");
    const chunks = planPkmSourceSelection(source, { start, end: source.length });
    expect(chunks.map((chunk) => sourceChunkText(source, chunk)).join("")).toBe(source.slice(start));
    expect(sourceChunkRange(chunks[0]!).start).toBe(start);
    expect(() => planPkmSourceSelection(source, { start: 0, end: source.length + 1 })).toThrow();
    expect(() => planPkmSourceSelection(source, { start, end: source.length }, [{ start, end: start + 4 }])).toThrow();
  });
  it("bounds unheaded prose while preserving every original character", () => {
    const source = "A synthetic paragraph with qualified facts. ".repeat(500);
    const chunks = planPkmSourceChunks(source);
    expect(
      chunks.every((chunk) => sourceChunkText(source, chunk).length <= 6000),
    ).toBe(true);
    expect(chunks.map((chunk) => sourceChunkText(source, chunk)).join("")).toBe(
      source,
    );
  });
});
