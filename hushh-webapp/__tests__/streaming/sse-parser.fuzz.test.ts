import { describe, expect, it } from "vitest";

import { parseSSEBlocks } from "@/lib/streaming/sse-parser";
import type { ParsedSSEFrame } from "@/lib/streaming/kai-stream-types";

/**
 * Property-based fuzz tests for the SSE parser.
 *
 * Hand-written tests cover specific scenarios. These tests verify
 * mathematical invariants that must hold for ALL valid inputs — the
 * properties the parser is contractually obligated to preserve.
 *
 * Each `it` block runs N independently-seeded trials. The seed is
 * derived from the trial index, so any failure is reproducible: the
 * test output prints the seed and you can pin it to debug.
 */

// ---------------------------------------------------------------------------
// Deterministic PRNG (xorshift32) — no Math.random in tests
// ---------------------------------------------------------------------------

class SeededRandom {
  private state: number;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed;
    // xorshift32 must not start at 0
    this.state = seed === 0 ? 0xdeadbeef : seed;
  }

  /** Returns a uniform random number in [0, 1). */
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return (this.state & 0x7fffffff) / 0x7fffffff;
  }

  /** Returns an integer in [min, max). */
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min)) + min;
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error("pick: empty array");
    return arr[this.int(0, arr.length)] as T;
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }
}

function runFuzz(
  numTrials: number,
  body: (rng: SeededRandom, trial: number) => void
): void {
  for (let trial = 0; trial < numTrials; trial++) {
    const seed = trial * 0x9e3779b1 + 0x12345;
    const rng = new SeededRandom(seed);
    try {
      body(rng, trial);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Fuzz trial ${trial} (seed=${seed}) failed: ${detail}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// SSE event generator
// ---------------------------------------------------------------------------

interface FuzzEvent {
  event: string;
  id?: string;
  dataLines: string[];
}

const EVENT_NAMES = [
  "stage",
  "chunk",
  "terminal",
  "error",
  "message",
  "ping",
  "ready",
];

function randomDataLine(rng: SeededRandom): string {
  const len = rng.int(0, 60);
  if (len === 0) return "";
  // ASCII printable EXCLUDING space (0x20) so we never produce wire forms
  // like "data:  foo" with extra leading whitespace — those are stripped
  // by the parser's `trimStart()` per SSE convention, which would create
  // a spurious mismatch with the test's reference value.
  let s = "";
  for (let i = 0; i < len; i++) {
    s += String.fromCharCode(rng.int(0x21, 0x7e + 1));
  }
  return s;
}

function randomEvent(rng: SeededRandom): FuzzEvent {
  const event = rng.pick(EVENT_NAMES);
  const id = rng.bool(0.5) ? String(rng.int(0, 100_000)) : undefined;
  const numDataLines = rng.bool(0.2) ? rng.int(2, 5) : 1;
  const dataLines = Array.from({ length: numDataLines }, () =>
    randomDataLine(rng)
  );
  return { event, id, dataLines };
}

function eventToFrame(e: FuzzEvent): string {
  const lines: string[] = [];
  lines.push(`event: ${e.event}`);
  if (e.id !== undefined) lines.push(`id: ${e.id}`);
  for (const dl of e.dataLines) lines.push(`data: ${dl}`);
  return lines.join("\n") + "\n\n";
}

function expectedFrame(e: FuzzEvent): ParsedSSEFrame {
  return {
    event: e.event,
    id: e.id,
    data: e.dataLines.join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Stream chunker
// ---------------------------------------------------------------------------

function chunkify(stream: string, rng: SeededRandom): string[] {
  if (stream.length === 0) return [""];
  const chunks: string[] = [];
  let i = 0;
  while (i < stream.length) {
    const remaining = stream.length - i;
    const len = rng.int(1, Math.min(remaining + 1, 25));
    chunks.push(stream.slice(i, i + len));
    i += len;
  }
  return chunks;
}

function feedChunks(chunks: readonly string[]): {
  events: ParsedSSEFrame[];
  finalRemainder: string;
} {
  let remainder = "";
  const events: ParsedSSEFrame[] = [];
  for (const chunk of chunks) {
    const r = parseSSEBlocks(chunk, remainder);
    remainder = r.remainder;
    events.push(...r.events);
  }
  return { events, finalRemainder: remainder };
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("SSE parser — property-based fuzz tests", () => {
  it("P1: parsing chunk-by-chunk is equivalent to parsing the whole stream", () => {
    runFuzz(50, (rng) => {
      const numEvents = rng.int(1, 8);
      const events = Array.from({ length: numEvents }, () => randomEvent(rng));
      const stream = events.map(eventToFrame).join("");

      const reference = parseSSEBlocks(stream);
      expect(reference.remainder).toBe("");
      expect(reference.events).toHaveLength(numEvents);

      const chunks = chunkify(stream, rng);
      const fed = feedChunks(chunks);

      expect(fed.finalRemainder).toBe("");
      expect(fed.events).toHaveLength(numEvents);
      expect(fed.events).toEqual(reference.events);
    });
  });

  it("P2: parser is deterministic — repeated calls on identical input yield identical output", () => {
    runFuzz(30, (rng) => {
      const events = Array.from({ length: rng.int(1, 5) }, () =>
        randomEvent(rng)
      );
      const stream = events.map(eventToFrame).join("");

      const a = parseSSEBlocks(stream);
      const b = parseSSEBlocks(stream);

      expect(a.events).toEqual(b.events);
      expect(a.remainder).toBe(b.remainder);
    });
  });

  it("P3: an empty chunk is a no-op — remainder is unchanged and no events are produced", () => {
    runFuzz(20, (rng) => {
      const partial =
        `event: ${rng.pick(EVENT_NAMES)}\n` +
        `id: ${rng.int(1, 9999)}\n` +
        `data: ${randomDataLine(rng)}`; // intentionally no terminating \n\n

      const r = parseSSEBlocks("", partial);
      expect(r.events).toHaveLength(0);
      expect(r.remainder).toBe(partial);
    });
  });

  it("P4: \\r\\n line endings are equivalent to \\n line endings", () => {
    runFuzz(20, (rng) => {
      const events = Array.from({ length: rng.int(1, 4) }, () =>
        randomEvent(rng)
      );
      const lfStream = events.map(eventToFrame).join("");
      const crlfStream = lfStream.replace(/\n/g, "\r\n");

      const a = parseSSEBlocks(lfStream);
      const b = parseSSEBlocks(crlfStream);

      expect(a.events).toEqual(b.events);
    });
  });

  it("P5: comment-only blocks (lines starting with `:`) never produce events", () => {
    runFuzz(20, (rng) => {
      const numComments = rng.int(1, 6);
      const comments = Array.from(
        { length: numComments },
        () => `: heartbeat ${rng.int(0, 1_000_000)}`
      ).join("\n");
      const stream = comments + "\n\n";

      const r = parseSSEBlocks(stream);
      expect(r.events).toHaveLength(0);
      expect(r.remainder).toBe("");
    });
  });

  it("P6: a block with `data:` but no `event:` is dropped", () => {
    runFuzz(20, (rng) => {
      const stream = `data: ${randomDataLine(rng)}\n\n`;
      const r = parseSSEBlocks(stream);
      expect(r.events).toHaveLength(0);
    });
  });

  it("P7: a block with `event:` but no `data:` is dropped", () => {
    runFuzz(20, (rng) => {
      const stream =
        `event: ${rng.pick(EVENT_NAMES)}\n` +
        `id: ${rng.int(1, 9999)}\n\n`;
      const r = parseSSEBlocks(stream);
      expect(r.events).toHaveLength(0);
    });
  });

  it("P8: multi-line `data:` fields are reassembled with `\\n` separators", () => {
    runFuzz(20, (rng) => {
      const numLines = rng.int(2, 5);
      const dataLines = Array.from({ length: numLines }, () =>
        randomDataLine(rng)
      );
      const stream =
        `event: chunk\n` +
        dataLines.map((d) => `data: ${d}`).join("\n") +
        "\n\n";

      const r = parseSSEBlocks(stream);
      expect(r.events).toHaveLength(1);
      expect(r.events[0]?.data).toBe(dataLines.join("\n"));
    });
  });

  it("P9: extra blank lines between events are tolerated and produce no spurious events", () => {
    runFuzz(20, (rng) => {
      const events = Array.from({ length: rng.int(2, 5) }, () =>
        randomEvent(rng)
      );
      // Insert random blank lines (i.e., extra `\n\n`) between events
      const stream = events
        .map((e) => eventToFrame(e) + "\n".repeat(rng.int(0, 4)))
        .join("");

      const r = parseSSEBlocks(stream);
      expect(r.events).toHaveLength(events.length);
      expect(r.events).toEqual(events.map(expectedFrame));
    });
  });

  it("P10: feeding an unterminated stream byte-by-byte never produces an event until \\n\\n arrives", () => {
    runFuzz(15, (rng) => {
      const event = randomEvent(rng);
      // Use the frame WITHOUT its trailing \n\n
      const frame = eventToFrame(event).slice(0, -2);

      let remainder = "";
      for (const ch of frame) {
        const r = parseSSEBlocks(ch, remainder);
        expect(r.events).toHaveLength(0);
        remainder = r.remainder;
      }

      // Now flush
      const r = parseSSEBlocks("\n\n", remainder);
      expect(r.events).toHaveLength(1);
      expect(r.events[0]).toEqual(expectedFrame(event));
      expect(r.remainder).toBe("");
    });
  });

  it("P11: parser never throws on adversarial inputs", () => {
    runFuzz(40, (rng) => {
      const len = rng.int(0, 200);
      let s = "";
      for (let i = 0; i < len; i++) {
        // Mix of newlines, colons, ASCII printable, and SSE-relevant tokens
        const choice = rng.int(0, 10);
        if (choice === 0) s += "\n";
        else if (choice === 1) s += "\r";
        else if (choice === 2) s += ":";
        else if (choice === 3) s += "event:";
        else if (choice === 4) s += "data:";
        else if (choice === 5) s += "id:";
        else s += String.fromCharCode(rng.int(0x20, 0x7e));
      }

      // Should never throw, regardless of the garbage we feed it
      expect(() => parseSSEBlocks(s)).not.toThrow();
      expect(() => parseSSEBlocks(s, s)).not.toThrow();
    });
  });
});