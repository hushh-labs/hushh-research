import { describe, expect, it } from "vitest";
import {
  planPkmSourceChunks,
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
