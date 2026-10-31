import { describe, expect, it, vi } from "vitest";

describe("Chat selection within one app launch", () => {
  it("starts blank on a cold load and resumes only within the running app", async () => {
    vi.resetModules();
    const first = await import("@/lib/agent/in-app-chat-selection");
    expect(first.selectedInAppChat("owner-a")).toBeNull();
    first.rememberInAppChat("owner-a", "chat-1");
    expect(first.selectedInAppChat("owner-a")).toBe("chat-1");
    expect(first.selectedInAppChat("owner-b")).toBeNull();
    first.rememberInAppChat("owner-a", null);
    expect(first.selectedInAppChat("owner-a")).toBeNull();

    first.rememberInAppChat("owner-a", "chat-2");
    vi.resetModules();
    const nextLaunch = await import("@/lib/agent/in-app-chat-selection");
    expect(nextLaunch.selectedInAppChat("owner-a")).toBeNull();
  });
});
