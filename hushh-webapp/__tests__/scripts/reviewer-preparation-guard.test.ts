import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The harness owns this policy; no browser, account, or secrets are needed here.
// @ts-expect-error The canonical Node rehearsal script has no TS declaration.
import { installReadOnlyMutationGuard } from "../../../.codex/skills/reviewer-app-testing/scripts/reviewer-session-harness.mjs";

describe("reviewer preparation-only authority", () => {
  beforeEach(() => vi.stubEnv("REVIEWER_ALLOW_SHARED_MUTATIONS", "false"));
  afterEach(() => vi.unstubAllEnvs());
  it("awaits guard installation before returning", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready = false;
    const install = installReadOnlyMutationGuard(
      { route: () => pending },
      {
        appOrigin: "http://localhost:3001",
        allowMemoryPreparation: true,
      },
    ).then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    release();
    await install;
    expect(ready).toBe(true);
  });

  it.each([
    ["http://localhost:3001/api/pkm/memory/proposals", "POST", true, true],
    ["http://localhost:3001/api/pkm/memory/proposals", "POST", false, false],
    ["http://localhost:3001/api/pkm/memory/proposals", "DELETE", true, false],
    ["https://elsewhere.example/api/pkm/memory/proposals", "POST", true, false],
    ["http://localhost:3001/api/pkm/store-domain", "POST", true, false],
    ["http://localhost:3001/api/consent/pending/approve", "POST", true, false],
    ["http://localhost:3001/api/one/agent-chat", "POST", true, false],
  ])(
    "bounds the opt-in to exact preparation authority (%s %s)",
    async (url, method, enabled, allowed) => {
      let handler!: (route: unknown) => Promise<void>;
      const context = {
        route: vi.fn(async (_glob: string, callback: typeof handler) => {
          handler = callback;
        }),
      };
      const guard = await installReadOnlyMutationGuard(context, {
        appOrigin: "http://localhost:3001",
        allowMemoryPreparation: enabled,
      });
      const route = {
        request: () => ({ url: () => url, method: () => method }),
        continue: vi.fn(),
        fulfill: vi.fn(),
      };
      await handler(route);
      expect(route.continue).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(route.fulfill).toHaveBeenCalledTimes(allowed ? 0 : 1);
      if (allowed) expect(() => guard.assertNoBlockedMutation()).not.toThrow();
      else expect(() => guard.assertNoBlockedMutation()).toThrow("blocked");
    },
  );
});
