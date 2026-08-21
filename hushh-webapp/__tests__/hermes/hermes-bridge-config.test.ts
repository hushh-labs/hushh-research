import { describe, expect, it } from "vitest";

import {
  isLoopbackBaseUrl,
  resolveHermesBridgeConfig,
  resolveHermesProfileDir,
} from "@/lib/hermes/config";

/**
 * The Hermes bridge can run agent turns on the operator's machine, so its
 * configuration is a security boundary rather than a convenience. These tests
 * pin the three properties that keep it safe: off unless asked for, loopback
 * only, and never usable without an explicit credential.
 */

const ENABLED = {
  HERMES_LOCAL_BRIDGE_ENABLED: "true",
  HERMES_LOCAL_API_KEY: "test-key",
} as NodeJS.ProcessEnv;

describe("hermes bridge config", () => {
  it("is disabled when the flag is absent", () => {
    const config = resolveHermesBridgeConfig({} as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(false);
    expect(config.apiKey).toBe("");
    expect(config.disabledReason).toContain("HERMES_LOCAL_BRIDGE_ENABLED");
  });

  it("stays disabled when the flag is set but the key is missing", () => {
    const config = resolveHermesBridgeConfig({
      HERMES_LOCAL_BRIDGE_ENABLED: "true",
    } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(false);
    expect(config.disabledReason).toContain("HERMES_LOCAL_API_KEY");
  });

  it("enables on loopback with a key, and never leaks the key when disabled", () => {
    const config = resolveHermesBridgeConfig(ENABLED);
    expect(config.enabled).toBe(true);
    expect(config.baseUrl).toBe("http://127.0.0.1:8642");

    const off = resolveHermesBridgeConfig({
      ...ENABLED,
      HERMES_LOCAL_BRIDGE_ENABLED: "false",
    } as NodeJS.ProcessEnv);
    expect(off.apiKey).toBe("");
  });

  it("refuses a non-loopback base url so the bridge cannot become an SSRF hop", () => {
    const config = resolveHermesBridgeConfig({
      ...ENABLED,
      HERMES_LOCAL_BASE_URL: "http://169.254.169.254",
    } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(false);
    expect(config.disabledReason).toContain("loopback");
  });

  it("classifies loopback hosts and rejects everything else", () => {
    expect(isLoopbackBaseUrl("http://127.0.0.1:8642")).toBe(true);
    expect(isLoopbackBaseUrl("http://localhost:8642")).toBe(true);
    expect(isLoopbackBaseUrl("http://[::1]:8642")).toBe(true);
    expect(isLoopbackBaseUrl("http://hermes.internal")).toBe(false);
    expect(isLoopbackBaseUrl("file:///etc/passwd")).toBe(false);
    expect(isLoopbackBaseUrl("not a url")).toBe(false);
  });

  it("resolves the Hermes profile directory from HERMES_HOME or HOME", () => {
    expect(resolveHermesProfileDir({ HERMES_HOME: "/tmp/h" } as NodeJS.ProcessEnv)).toBe(
      "/tmp/h",
    );
    expect(resolveHermesProfileDir({ HOME: "/Users/x" } as NodeJS.ProcessEnv)).toBe(
      "/Users/x/.hermes",
    );
  });
});
