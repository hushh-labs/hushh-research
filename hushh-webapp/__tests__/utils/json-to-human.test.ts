import { describe, expect, it } from "vitest";

import {
  createParserContext,
  formatCompleteJson,
  formatJsonChunk,
  tryFormatComplete,
} from "@/lib/utils/json-to-human";

describe("json-to-human", () => {
  describe("createParserContext", () => {
    it("returns a parser context", () => {
      const ctx = createParserContext();

      expect(ctx).toBeTruthy();
      expect(typeof ctx).toBe("object");
    });

    it("returns a fresh object each time", () => {
      expect(createParserContext()).not.toBe(
        createParserContext(),
      );
    });
  });

  describe("formatCompleteJson", () => {
    it("formats a simple object", () => {
      const result = formatCompleteJson({
        portfolio_summary: {
          ending_value: 100,
        },
      });

      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("renders a nested object within an object section with indented bullet sub-fields", () => {
      const output = formatCompleteJson({
        ytd_metrics: {
          realized_summary: {
            net_realized: 2500,
          },
        },
      });

      expect(output).toContain(
        "--- Year-to-Date Metrics ---",
      );

      expect(output).toContain(
        "  Realized Summary:",
      );

      expect(output).toContain(
        "    • Net Realized: $2,500.00",
      );
    });
  });

  describe("tryFormatComplete", () => {
    it("returns null for incomplete json", () => {
      const ctx = createParserContext();

      ctx.accumulatedJson = '{"portfolio_summary":';

      expect(tryFormatComplete(ctx)).toBeNull();
    });

    it("returns formatted output for valid json", () => {
      const ctx = createParserContext();

      ctx.accumulatedJson = JSON.stringify({
        portfolio_summary: {
          ending_value: 100,
        },
      });

      expect(tryFormatComplete(ctx)).not.toBeNull();
    });
  });

  describe("formatJsonChunk", () => {
    it("accumulates chunks", () => {
      const ctx = createParserContext();

      formatJsonChunk("hello ", ctx);
      formatJsonChunk("world", ctx);

      expect(ctx.accumulatedJson).toBe(
        "hello world",
      );
    });

    it("returns text and context", () => {
      const ctx = createParserContext();

      const result = formatJsonChunk(
        "chunk",
        ctx,
      );

      expect(result).toHaveProperty("text");
      expect(result).toHaveProperty("context");
    });
  });
});