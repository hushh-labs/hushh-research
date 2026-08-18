/**
 * Cross-surface contract for the connection-request notification.
 *
 * Web, iOS and Android all consume ONE payload, built by one Python function.
 * Issue #5422 was not a rendering bug — it was the two sides of that boundary
 * disagreeing: the server wrote the requester's name into the banner body while
 * the client read it from the data map, and nothing anywhere asserted that the
 * field the server writes is the field the client reads.
 *
 * So this test reads the Python source and checks it against the TypeScript that
 * consumes it. No fixture, no duplicated expectation: if either side moves, this
 * fails. That is what makes the fix hold on all three platforms rather than just
 * the one someone happened to retest.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BRAND_NAME,
  GENERIC_REQUESTER_LABEL,
  connectionRequestBody,
} from "@/lib/branding/brand";

const protocolFile = (...segments: string[]) =>
  fs.readFileSync(
    path.resolve(__dirname, "../../../consent-protocol", ...segments),
    "utf8",
  );

const BRANDING_PY = protocolFile("hushh_mcp/branding.py");
const PUSH_PY = protocolFile("hushh_mcp/services/push_notifications.py");
const PROVIDER_TSX = fs.readFileSync(
  path.resolve(__dirname, "../../components/consent/notification-provider.tsx"),
  "utf8",
);
const FCM_SERVICE_TS = fs.readFileSync(
  path.resolve(__dirname, "../../lib/notifications/fcm-service.ts"),
  "utf8",
);

function pythonStringConstant(source: string, name: string): string {
  const match = new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m").exec(source);
  if (!match) {
    throw new Error(
      `${name} not found in the Python source — the constant moved and this contract needs re-pointing.`,
    );
  }
  return match[1];
}

/** The keys the backend puts in the FCM `data` map for a connection request. */
function pythonClientDataKeys(): string[] {
  const block = /client_data\s*=\s*\{([\s\S]*?)\}/.exec(PUSH_PY);
  if (!block) {
    throw new Error(
      "client_data literal not found in push_notifications.py — re-point this contract.",
    );
  }
  return [...block[1].matchAll(/"([a-z_]+)":/g)].map((match) => match[1]);
}

describe("connection-request notification: Python <-> TypeScript brand contract", () => {
  it("agrees on the brand name", () => {
    expect(pythonStringConstant(BRANDING_PY, "BRAND_NAME")).toBe(BRAND_NAME);
  });

  it("agrees on the generic fallback word", () => {
    expect(pythonStringConstant(BRANDING_PY, "GENERIC_REQUESTER_LABEL")).toBe(
      GENERIC_REQUESTER_LABEL,
    );
  });

  it("composes byte-identical copy on both sides", () => {
    // The OS banner is rendered from the Python string and the in-app toast from
    // the TypeScript one. On web with the tab visible, and on iOS, a user can see
    // both at once — they used to disagree outright.
    const template =
      /return f"\{label\}([^"]*?)\{BRAND_NAME\}\."/.exec(BRANDING_PY);
    expect(
      template,
      "the Python sentence template moved; re-point this contract",
    ).not.toBeNull();
    const middle = template![1];

    for (const label of ["Rohan Mehta", "Ankit"]) {
      expect(connectionRequestBody(label)).toBe(
        `${label}${middle}${BRAND_NAME}.`,
      );
    }
    expect(connectionRequestBody(null)).toBe(
      `${GENERIC_REQUESTER_LABEL}${middle}${BRAND_NAME}.`,
    );
  });

  it("never emits the pre-rebrand spelling from either side", () => {
    for (const value of [null, "Rohan"]) {
      expect(connectionRequestBody(value).toLowerCase()).not.toContain("hushh");
    }
    const pythonSentenceLines = BRANDING_PY.split("\n").filter((line) =>
      line.includes("wants to connect with you"),
    );
    expect(pythonSentenceLines.length).toBeGreaterThan(0);
    for (const line of pythonSentenceLines) {
      expect(line.toLowerCase()).not.toContain("on hushh");
    }
  });
});

describe("connection-request notification: payload field contract", () => {
  it("ships the identity field the in-app toast actually reads", () => {
    // The bug in one assertion: the server resolved the name and never put it in
    // the data map, which is the only thing the toast sees.
    expect(pythonClientDataKeys()).toContain("requester_label");
    expect(PROVIDER_TSX).toContain("requesterLabel: data.requester_label");
  });

  it("ships a request id, and every consumer reads it", () => {
    expect(pythonClientDataKeys()).toContain("request_id");
    // Web toast target.
    expect(PROVIDER_TSX).toContain('String(data.request_id || "").trim()');
    // Native tap target.
    expect(FCM_SERVICE_TS).toContain(
      'typeof data?.request_id === "string" && data.request_id',
    );
  });

  it("declares no data-map key the client silently ignores", () => {
    // A field the server pays to send and nobody reads is how `requester_label`
    // came to exist on the SSE payload alone for so long without being noticed.
    const consumed = `${PROVIDER_TSX}\n${FCM_SERVICE_TS}`;
    for (const key of pythonClientDataKeys()) {
      expect(consumed, `no client reads the "${key}" data field`).toContain(key);
    }
  });

  it("deep-links to the review sheet, not the list", () => {
    // The Consent Center opens the incoming review sheet only from `?requestId`.
    expect(PUSH_PY).toContain("/one/consent?tab=pending&requestId=");
    // ...and the id is percent-encoded, so an opaque id cannot inject a param.
    expect(PUSH_PY).toMatch(/requestId=\{quote\(request_id, safe=''\)\}/);
  });
});
