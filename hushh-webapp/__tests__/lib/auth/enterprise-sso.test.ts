import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  decideEnterpriseSsoCallback,
  hasEnterpriseSsoCallbackParams,
  isEnterpriseSsoEnabled,
  looksLikeWorkEmail,
  savePendingEnterpriseSso,
  takePendingEnterpriseSso,
} from "@/lib/auth/enterprise-sso";

const pending = { state: "signed.state", resume: "/kai", startedAt: 1_000 };
const query = (value: string) => new URLSearchParams(value);

describe("enterprise SSO callback decision", () => {
  it("exchanges only when the returned state matches the one this browser stored", () => {
    // Negative control: the matching callback is honored.
    expect(decideEnterpriseSsoCallback(query("code=abc&state=signed.state"), pending)).toEqual({
      kind: "exchange",
      code: "abc",
      state: "signed.state",
      resume: "/kai",
    });
    // A code minted for someone else's sign-in carries a state this browser never stored.
    expect(decideEnterpriseSsoCallback(query("code=abc&state=forged"), pending)).toMatchObject({
      kind: "failed",
      reason: "state_mismatch",
    });
  });

  it("refuses a callback with no pending attempt, a provider error, or missing parts", () => {
    expect(decideEnterpriseSsoCallback(query("code=abc&state=s"), null)).toMatchObject({
      kind: "failed",
      reason: "expired",
    });
    expect(
      decideEnterpriseSsoCallback(query("error=access_denied&state=signed.state"), pending),
    ).toMatchObject({ kind: "failed", reason: "provider_error" });
    expect(decideEnterpriseSsoCallback(query("code=abc"), pending)).toEqual({ kind: "none" });
  });

  it("only treats state plus code or error as a callback, so other login queries are untouched", () => {
    expect(hasEnterpriseSsoCallbackParams(query("redirect=%2Fkai"))).toBe(false);
    expect(hasEnterpriseSsoCallbackParams(query("state=x"))).toBe(false);
    expect(hasEnterpriseSsoCallbackParams(query("code=1&state=x"))).toBe(true);
    expect(hasEnterpriseSsoCallbackParams(query("error=e&state=x"))).toBe(true);
  });
});

describe("pending attempt storage", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("is single-use", () => {
    expect(savePendingEnterpriseSso(pending)).toBe(true);
    expect(takePendingEnterpriseSso(2_000)?.state).toBe("signed.state");
    expect(takePendingEnterpriseSso(2_000)).toBeNull();
  });

  it("expires, and is consumed even when expired or malformed", () => {
    savePendingEnterpriseSso(pending);
    expect(takePendingEnterpriseSso(1_000 + 11 * 60 * 1000)).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
    window.sessionStorage.setItem("hushh.enterprise_sso.pending", "{not json");
    expect(takePendingEnterpriseSso(2_000)).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("enterprise SSO entry flag", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("ships dark: unset or false is off, only an explicit opt-in is on", () => {
    expect(isEnterpriseSsoEnabled()).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_WORKOS_SSO_ENABLED", "false");
    expect(isEnterpriseSsoEnabled()).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_WORKOS_SSO_ENABLED", "true");
    expect(isEnterpriseSsoEnabled()).toBe(true);
  });

  it("recognizes a plausible work email", () => {
    expect(looksLikeWorkEmail(" ada@acme.example ")).toBe(true);
    expect(looksLikeWorkEmail("ada@acme")).toBe(false);
    expect(looksLikeWorkEmail("not an email")).toBe(false);
  });
});
