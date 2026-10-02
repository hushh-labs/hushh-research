import { expect, it, vi } from "vitest";
import { ownerPodRequest } from "@/lib/services/pod-app-access";

const pod = vi.hoisted(() => ({ currentPodConnection: vi.fn() }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { getCurrentUser: () => ({ uid: "owner" }) } }));
vi.mock("@/lib/services/owner-pod-endpoint", () => ({
  loadPinnedEndpoint: async () => ({ hushhId: "ha1_owner", url: "https://owner.a.run.app" }),
  currentPodConnection: pod.currentPodConnection,
}));

it("refuses a cancelled chat while preserving another caller's shared admission", async () => {
  let admitted!: (connection: unknown) => void;
  const admission = new Promise((resolve) => { admitted = resolve; });
  pod.currentPodConnection.mockReturnValue(admission);
  const hub = vi.fn();
  const fetch = vi.fn(async () => new Response("{}"));
  const ports = { transport: async () => ({ hub }), fetch } as Parameters<typeof ownerPodRequest>[2];
  const caller = new AbortController();
  const cancelled = ownerPodRequest("agent-chat", {
    method: "POST", body: JSON.stringify({ messages: [], forwardedProps: {} }), signal: caller.signal,
  }, ports);
  const refused = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(pod.currentPodConnection).toHaveBeenCalledOnce());
  caller.abort(new DOMException("Owner cancelled", "AbortError"));
  admitted({ endpoint: { hushhId: "ha1_owner", url: "https://owner.a.run.app" }, session: { session: "synthetic-session" } });
  await refused;
  expect(hub).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  await ownerPodRequest("agent-chat/conversations/owner", { method: "GET" }, ports);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][0]).toBe("https://owner.a.run.app/api/one/pod/agent-chat/conversations/owner");
});
