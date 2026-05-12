import { describe, expect, it, vi } from "vitest";
import { parseSSEChunk } from "@/lib/streaming/sse-parser";

describe("parseSSEChunk - Memory Limit Circuit Breaker", () => {
  it("processes normal chunks correctly under the limit", () => {
    const chunk = "data: {\"test\": 1}\n\n";
    const result = parseSSEChunk(chunk, "");
    
    expect(result.parsedEvents).toHaveLength(1);
    expect(result.leftoverBuffer).toBe("");
  });

  it("safely triggers the circuit breaker on strings exceeding 1MB", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    
    // Create a massive chunk slightly over 1MB without any newlines
    const massiveChunkSize = (1024 * 1024) + 10;
    const maliciousChunk = "A".repeat(massiveChunkSize);
    
    const result = parseSSEChunk(maliciousChunk, "");
    
    // The buffer should be wiped clean, not appended to
    expect(result.leftoverBuffer).toBe("");
    expect(result.parsedEvents).toHaveLength(0);
    
    // Ensure the system logged the warning
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("SSE Buffer overflow threshold reached")
    );
    
    consoleSpy.mockRestore();
  });

  it("prevents cumulative buffer growth over 1MB", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    
    const existingBuffer = "A".repeat(1024 * 1020); // 1020 KB
    const newChunk = "B".repeat(1024 * 5); // 5 KB (pushes total over 1024 KB)
    
    const result = parseSSEChunk(newChunk, existingBuffer);
    
    expect(result.leftoverBuffer).toBe("");
    expect(consoleSpy).toHaveBeenCalled();
    
    consoleSpy.mockRestore();
  });

  it("skips empty JSON string payloads without throwing", () => {
    const emptyPayloadChunk = "data: \n\ndata: {\"valid\": true}\n\n";
    const result = parseSSEChunk(emptyPayloadChunk, "");
    
    // Should skip the empty "data: " and only parse the valid object
    expect(result.parsedEvents).toHaveLength(1);
    expect(result.parsedEvents[0]).toEqual({ valid: true });
  });
});