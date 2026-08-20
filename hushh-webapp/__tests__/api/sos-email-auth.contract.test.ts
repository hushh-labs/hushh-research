// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The SOS email route 401'd every real request on UAT.
 *
 * Callers reach it through `sendSosEmails` in lib/one-location/service.ts, which
 * uses `jsonAuthHeaders(vaultOwnerToken)` — the SAME credential every other
 * /api/one/location/* call sends, a VAULT_OWNER consent token. The route ran it
 * through `validateFirebaseToken()`, which only accepts a Firebase ID token, so
 * it rejected the caller before the request ever reached the backend. The SOS
 * alert went out; the email leg never even tried.
 *
 * These are source assertions because the failure is structural: the route can
 * be perfectly correct in every other respect and still reject 100% of traffic
 * by checking the wrong kind of credential.
 */

const ROUTE = fs.readFileSync(
  path.resolve(
    __dirname,
    "../../app/api/one/location/sos-email/route.ts",
  ),
  "utf8",
);

const SERVICE = fs.readFileSync(
  path.resolve(__dirname, "../../lib/one-location/service.ts"),
  "utf8",
);

describe("SOS email route — credential contract", () => {
  it("does not validate the caller as a Firebase user", () => {
    // The caller does not hold a Firebase ID token at this point; it holds a
    // vault owner token. Checking for the wrong one rejects every request.
    expect(ROUTE).not.toContain("validateFirebaseToken");
  });

  it("forwards the caller's Authorization header to the backend", () => {
    // The backend is the single authority: it validates the token with
    // require_vault_owner_token and checks the grants belong to that caller.
    expect(ROUTE).toContain("authorization: authHeader");
  });

  it("still refuses a request that carries no credential at all", () => {
    expect(ROUTE).toContain('request.headers.get("authorization")');
    expect(ROUTE).toMatch(/if \(!authHeader\)[\s\S]{0,80}401/);
  });

  it("treats a non-2xx from the backend as no recipients, not a crash", () => {
    // The alert has already gone out by the time this runs. An upstream refusal
    // must be reported as a count, never raised.
    expect(ROUTE).toContain("if (!upstream.ok)");
  });

  it("is still the caller that sends a vault owner token", () => {
    // If this ever changes to a Firebase token, the route's forwarding is still
    // correct, but this test should be revisited deliberately rather than by
    // accident.
    expect(SERVICE).toContain("jsonAuthHeaders(params.vaultOwnerToken)");
  });

  it("reaches the Next route by absolute URL on native, not the backend", () => {
    // Every other call in service.ts goes to the Python backend, so a relative
    // path is right. This one is a Next.js route — on iOS and Android a
    // relative path resolves against the backend, which does not host it, and
    // the alert's email leg would 404 on exactly the platforms an SOS is most
    // likely sent from.
    expect(SERVICE).toContain("nextRouteOrigin()}/api/one/location/sos-email");
    expect(SERVICE).toContain("Capacitor.isNativePlatform()");
    expect(SERVICE).toContain("resolveRuntimeFrontendUrl");
  });
});
