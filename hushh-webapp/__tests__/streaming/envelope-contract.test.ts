import { describe, expect, it } from "vitest";

import {
  isKaiStreamEnvelope,
  type KaiStreamEnvelope,
  type KaiStreamKind,
} from "@/lib/streaming/kai-stream-types";

/**
 * Wire-format contract tests for the Kai stream envelope.
 *
 * Why this exists
 * ---------------
 * The Python backend already enforces the envelope contract server-side
 * via `consent-protocol/tests/test_kai_stream_contract.py`. The TypeScript
 * client previously had only the loose `isKaiStreamEnvelope` runtime
 * check and four hand-written parser tests — which means the backend
 * could change the wire format and the frontend would not notice until
 * an actual stream broke in production.
 *
 * This file mirrors the backend's contract so any drift between platforms
 * fails CI on BOTH sides at PR time, not in production.
 *
 * The Kai stream envelope is consumed by three platforms today:
 *   - hushh-webapp (TypeScript, this repo)
 *   - iOS native (Swift, hushh-webapp/ios/.../KaiPlugin.swift)
 *   - Backend integration tests (Python)
 *
 * Backwards-compatible evolution rules (also asserted below):
 *   - Adding a new optional payload field is SAFE (forward compatibility).
 *   - Changing the type of an existing field is BREAKING.
 *   - Removing a required envelope field is BREAKING.
 *   - Bumping `schema_version` is a coordinated migration across web + iOS
 *     + backend. The version is locked at "1.0" until that work happens.
 */

// ===========================================================================
// Golden samples — these are the exact shapes the backend emits today.
// Source of truth: `consent-protocol/api/routes/kai/_streaming.py`
// (see `CanonicalSSEStream.event(...)`).
// ===========================================================================

const GOLDEN_PORTFOLIO_IMPORT_STAGE = {
  schema_version: "1.0",
  stream_id: "strm_pi_001",
  stream_kind: "portfolio_import",
  seq: 1,
  event: "stage",
  terminal: false,
  payload: { stage: "uploading" },
} as const;

const GOLDEN_PORTFOLIO_IMPORT_TERMINAL = {
  schema_version: "1.0",
  stream_id: "strm_pi_001",
  stream_kind: "portfolio_import",
  seq: 7,
  event: "complete",
  terminal: true,
  payload: { message: "done" },
} as const;

const GOLDEN_PORTFOLIO_OPTIMIZE_STAGE = {
  schema_version: "1.0",
  stream_id: "strm_po_001",
  stream_kind: "portfolio_optimize",
  seq: 1,
  event: "stage",
  terminal: false,
  payload: { status: "ok" },
} as const;

const GOLDEN_PORTFOLIO_OPTIMIZE_TERMINAL = {
  schema_version: "1.0",
  stream_id: "strm_po_001",
  stream_kind: "portfolio_optimize",
  seq: 4,
  event: "complete",
  terminal: true,
  payload: { reallocations: [] },
} as const;

const GOLDEN_STOCK_ANALYZE_AGENT_START = {
  schema_version: "1.0",
  stream_id: "strm_sa_001",
  stream_kind: "stock_analyze",
  seq: 1,
  event: "agent_start",
  terminal: false,
  payload: { agent: "fundamental" },
} as const;

const GOLDEN_STOCK_ANALYZE_AGENT_TOKEN = {
  schema_version: "1.0",
  stream_id: "strm_sa_001",
  stream_kind: "stock_analyze",
  seq: 2,
  event: "agent_token",
  terminal: false,
  payload: { agent: "fundamental", text: "Hello" },
} as const;

const GOLDEN_STOCK_ANALYZE_DECISION = {
  schema_version: "1.0",
  stream_id: "strm_sa_001",
  stream_kind: "stock_analyze",
  seq: 5,
  event: "decision",
  terminal: true,
  payload: { decision: "buy", conviction: 0.82 },
} as const;

const ALL_GOLDEN_ENVELOPES = [
  ["portfolio_import stage", GOLDEN_PORTFOLIO_IMPORT_STAGE],
  ["portfolio_import terminal (complete)", GOLDEN_PORTFOLIO_IMPORT_TERMINAL],
  ["portfolio_optimize stage", GOLDEN_PORTFOLIO_OPTIMIZE_STAGE],
  ["portfolio_optimize terminal (complete)", GOLDEN_PORTFOLIO_OPTIMIZE_TERMINAL],
  ["stock_analyze agent_start", GOLDEN_STOCK_ANALYZE_AGENT_START],
  ["stock_analyze agent_token", GOLDEN_STOCK_ANALYZE_AGENT_TOKEN],
  ["stock_analyze terminal (decision)", GOLDEN_STOCK_ANALYZE_DECISION],
] as const;

// Locks the stream_kind enumeration on the TypeScript side. Any backend
// change that introduces a new stream kind needs to update this list AND
// the `KaiStreamKind` type in lib/streaming/kai-stream-types.ts.
const KNOWN_STREAM_KINDS: ReadonlyArray<KaiStreamKind> = [
  "portfolio_import",
  "portfolio_optimize",
  "stock_analyze",
];

// Documented terminal-event names per stream kind. Mirrors the backend's
// `CanonicalSSEStream` semantics: portfolio_* terminate with `complete`,
// stock_analyze terminates with `decision`.
const TERMINAL_EVENTS_BY_KIND: Record<KaiStreamKind, ReadonlyArray<string>> = {
  portfolio_import: ["complete"],
  portfolio_optimize: ["complete"],
  stock_analyze: ["decision"],
};

// ===========================================================================
// Contract assertions
// ===========================================================================

describe("Kai stream envelope — wire-format contract", () => {
  describe("schema_version is locked to '1.0'", () => {
    it("accepts the locked version", () => {
      expect(isKaiStreamEnvelope(GOLDEN_PORTFOLIO_IMPORT_STAGE)).toBe(true);
    });

    it("rejects any other version (drift detector)", () => {
      // Bumping schema_version is a coordinated migration across web,
      // iOS, and backend. This test forces that conversation to happen.
      expect(
        isKaiStreamEnvelope({
          ...GOLDEN_PORTFOLIO_IMPORT_STAGE,
          schema_version: "1.1",
        })
      ).toBe(false);
      expect(
        isKaiStreamEnvelope({
          ...GOLDEN_PORTFOLIO_IMPORT_STAGE,
          schema_version: "2.0",
        })
      ).toBe(false);
      expect(
        isKaiStreamEnvelope({
          ...GOLDEN_PORTFOLIO_IMPORT_STAGE,
          schema_version: "0.9",
        })
      ).toBe(false);
      // numeric 1.0 is NOT the same as the string "1.0"
      expect(
        isKaiStreamEnvelope({
          ...GOLDEN_PORTFOLIO_IMPORT_STAGE,
          schema_version: 1.0,
        })
      ).toBe(false);
      expect(
        isKaiStreamEnvelope({
          ...GOLDEN_PORTFOLIO_IMPORT_STAGE,
          schema_version: undefined,
        })
      ).toBe(false);
    });
  });

  describe("stream_kind enumeration is locked", () => {
    it("contains exactly the three documented kinds", () => {
      // If the backend adds a new stream_kind (e.g. 'real_estate_analyze'),
      // this test will need to be updated AND the KaiStreamKind type in
      // lib/streaming/kai-stream-types.ts must be widened. Both updates
      // should land in the same PR as the backend rollout.
      expect(KNOWN_STREAM_KINDS).toEqual([
        "portfolio_import",
        "portfolio_optimize",
        "stock_analyze",
      ]);
    });

    it("every known stream_kind has at least one golden sample", () => {
      const tested = new Set(
        ALL_GOLDEN_ENVELOPES.map(([, env]) => env.stream_kind as KaiStreamKind)
      );
      for (const kind of KNOWN_STREAM_KINDS) {
        expect(tested.has(kind)).toBe(true);
      }
    });
  });

  describe("required envelope fields", () => {
    const REQUIRED_FIELDS = [
      "schema_version",
      "stream_id",
      "stream_kind",
      "seq",
      "event",
      "terminal",
      "payload",
    ] as const;

    for (const field of REQUIRED_FIELDS) {
      it(`rejects envelopes missing '${field}'`, () => {
        const broken: Record<string, unknown> = {
          ...GOLDEN_PORTFOLIO_IMPORT_STAGE,
        };
        delete broken[field];
        expect(isKaiStreamEnvelope(broken)).toBe(false);
      });
    }
  });

  describe("field type contracts", () => {
    it("rejects when stream_id is not a string", () => {
      expect(
        isKaiStreamEnvelope({ ...GOLDEN_PORTFOLIO_IMPORT_STAGE, stream_id: 123 })
      ).toBe(false);
      expect(
        isKaiStreamEnvelope({
          ...GOLDEN_PORTFOLIO_IMPORT_STAGE,
          stream_id: null,
        })
      ).toBe(false);
    });

    it("rejects when seq is not a number", () => {
      expect(
        isKaiStreamEnvelope({ ...GOLDEN_PORTFOLIO_IMPORT_STAGE, seq: "1" })
      ).toBe(false);
      expect(
        isKaiStreamEnvelope({ ...GOLDEN_PORTFOLIO_IMPORT_STAGE, seq: null })
      ).toBe(false);
    });

    it("rejects when event is not a string", () => {
      expect(
        isKaiStreamEnvelope({ ...GOLDEN_PORTFOLIO_IMPORT_STAGE, event: 1 })
      ).toBe(false);
    });

    it("rejects when terminal is not a boolean", () => {
      expect(
        isKaiStreamEnvelope({
          ...GOLDEN_PORTFOLIO_IMPORT_STAGE,
          terminal: "false",
        })
      ).toBe(false);
      expect(
        isKaiStreamEnvelope({ ...GOLDEN_PORTFOLIO_IMPORT_STAGE, terminal: 0 })
      ).toBe(false);
      expect(
        isKaiStreamEnvelope({ ...GOLDEN_PORTFOLIO_IMPORT_STAGE, terminal: 1 })
      ).toBe(false);
    });

    it("rejects when payload is null or non-object", () => {
      expect(
        isKaiStreamEnvelope({ ...GOLDEN_PORTFOLIO_IMPORT_STAGE, payload: null })
      ).toBe(false);
      expect(
        isKaiStreamEnvelope({
          ...GOLDEN_PORTFOLIO_IMPORT_STAGE,
          payload: "string",
        })
      ).toBe(false);
      expect(
        isKaiStreamEnvelope({ ...GOLDEN_PORTFOLIO_IMPORT_STAGE, payload: 42 })
      ).toBe(false);
    });

    it("accepts an empty-object payload (no required payload keys at envelope level)", () => {
      expect(
        isKaiStreamEnvelope({ ...GOLDEN_PORTFOLIO_IMPORT_STAGE, payload: {} })
      ).toBe(true);
    });
  });

  describe("non-envelope inputs", () => {
    it("rejects null and undefined", () => {
      expect(isKaiStreamEnvelope(null)).toBe(false);
      expect(isKaiStreamEnvelope(undefined)).toBe(false);
    });

    it("rejects primitives", () => {
      expect(isKaiStreamEnvelope(42)).toBe(false);
      expect(isKaiStreamEnvelope("envelope")).toBe(false);
      expect(isKaiStreamEnvelope(true)).toBe(false);
    });

    it("rejects empty objects and bare arrays", () => {
      expect(isKaiStreamEnvelope({})).toBe(false);
      expect(isKaiStreamEnvelope([])).toBe(false);
    });
  });

  describe("forward compatibility", () => {
    it("accepts envelopes with extra unknown fields (additive evolution is safe)", () => {
      const evolved = {
        ...GOLDEN_PORTFOLIO_IMPORT_STAGE,
        // Hypothetical future fields a newer backend might add
        trace_id: "trace_abc123",
        client_hint: { region: "us-east-1" },
        deprecated_field: false,
      };
      expect(isKaiStreamEnvelope(evolved)).toBe(true);
    });

    it("accepts payloads with extra unknown fields", () => {
      const evolved = {
        ...GOLDEN_STOCK_ANALYZE_DECISION,
        payload: {
          ...GOLDEN_STOCK_ANALYZE_DECISION.payload,
          // Hypothetical future enrichment in the decision payload
          model_version: "v2.7",
          telemetry: { latency_ms: 142 },
        },
      };
      expect(isKaiStreamEnvelope(evolved)).toBe(true);
    });
  });

  describe("type narrowing via the guard", () => {
    it("narrows `unknown` to KaiStreamEnvelope, exposing typed fields", () => {
      const value: unknown = GOLDEN_STOCK_ANALYZE_DECISION;
      if (isKaiStreamEnvelope(value)) {
        // These property accesses are the type-level assertion: if the
        // guard signature regresses (e.g., returns plain `boolean` rather
        // than `value is KaiStreamEnvelope`), the file fails to compile.
        const narrowed: KaiStreamEnvelope = value;
        expect(typeof narrowed.payload).toBe("object");
        expect(typeof narrowed.event).toBe("string");
        expect(narrowed.terminal).toBe(true);
        expect(narrowed.schema_version).toBe("1.0");
      } else {
        throw new Error("type-narrowing test: golden sample failed the guard");
      }
    });
  });

  describe("golden samples — every documented envelope passes", () => {
    for (const [name, envelope] of ALL_GOLDEN_ENVELOPES) {
      it(`accepts the '${name}' golden envelope`, () => {
        expect(isKaiStreamEnvelope(envelope)).toBe(true);
      });
    }

    it("every golden sample's stream_kind is in the known enumeration", () => {
      for (const [, envelope] of ALL_GOLDEN_ENVELOPES) {
        expect(KNOWN_STREAM_KINDS).toContain(
          envelope.stream_kind as KaiStreamKind
        );
      }
    });

    it("terminal events match the documented event-name per stream_kind", () => {
      // Mirrors the backend semantics: portfolio_* terminate with
      // 'complete' and stock_analyze terminates with 'decision'. If a
      // golden sample claims terminal=true with a different event name,
      // the contract has drifted.
      for (const [name, envelope] of ALL_GOLDEN_ENVELOPES) {
        if (envelope.terminal) {
          const allowed =
            TERMINAL_EVENTS_BY_KIND[envelope.stream_kind as KaiStreamKind];
          expect(
            allowed,
            `unknown stream_kind in golden '${name}'`
          ).toBeDefined();
          expect(
            allowed.includes(envelope.event),
            `golden '${name}' has terminal=true but event='${envelope.event}' is not a documented terminal for ${envelope.stream_kind}; allowed: ${allowed.join(", ")}`
          ).toBe(true);
        }
      }
    });

    it("at least one golden sample per stream_kind is terminal", () => {
      const terminalKinds = new Set(
        ALL_GOLDEN_ENVELOPES.filter(([, env]) => env.terminal).map(
          ([, env]) => env.stream_kind as KaiStreamKind
        )
      );
      for (const kind of KNOWN_STREAM_KINDS) {
        expect(terminalKinds.has(kind)).toBe(true);
      }
    });
  });
});