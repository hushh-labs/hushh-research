import { describe, expect, it } from "vitest";

import {
  KAI_PORTFOLIO_IMPORT_IDLE_TIMEOUT_MS,
  KAI_PORTFOLIO_IMPORT_TIMEOUT_SECONDS,
} from "@/lib/services/kai-import-stream-config";

describe("kai-import-stream-config", () => {
  it("exports a positive finite timeout in seconds", () => {
    expect(typeof KAI_PORTFOLIO_IMPORT_TIMEOUT_SECONDS).toBe("number");
    expect(Number.isFinite(KAI_PORTFOLIO_IMPORT_TIMEOUT_SECONDS)).toBe(true);
    expect(KAI_PORTFOLIO_IMPORT_TIMEOUT_SECONDS).toBeGreaterThan(0);
  });

  it("locks the timeout contract at 360 seconds", () => {
    expect(KAI_PORTFOLIO_IMPORT_TIMEOUT_SECONDS).toBe(360);
  });

  it("exports a positive finite idle timeout", () => {
    expect(typeof KAI_PORTFOLIO_IMPORT_IDLE_TIMEOUT_MS).toBe("number");
    expect(Number.isFinite(KAI_PORTFOLIO_IMPORT_IDLE_TIMEOUT_MS)).toBe(true);
    expect(KAI_PORTFOLIO_IMPORT_IDLE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("derives idle timeout from the backend timeout contract", () => {
    expect(KAI_PORTFOLIO_IMPORT_IDLE_TIMEOUT_MS).toBe(
      (KAI_PORTFOLIO_IMPORT_TIMEOUT_SECONDS + 60) * 1000,
    );
  });

  it("keeps idle timeout greater than backend timeout", () => {
    expect(KAI_PORTFOLIO_IMPORT_IDLE_TIMEOUT_MS).toBeGreaterThan(
      KAI_PORTFOLIO_IMPORT_TIMEOUT_SECONDS * 1000,
    );
  });
});