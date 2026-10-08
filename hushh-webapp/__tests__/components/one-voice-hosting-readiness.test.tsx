import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OneVoiceReadinessProvider, useOneVoiceReadiness } from "@/lib/one-voice/readiness";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const { state, hosting, readiness } = vi.hoisted(() => ({
  state: { uid: "owner-a" }, hosting: vi.fn(), readiness: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: state.uid } }) }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: {
  getPersonalAgentStatus: hosting, getOneVoiceReadiness: readiness,
} }));
function Probe() {
  const result = useOneVoiceReadiness();
  return <output>{result.microphoneOwner ?? "checking"}</output>;
}
const view = () => <OneVoiceReadinessProvider><Probe /></OneVoiceReadinessProvider>;
const ready = { enabled: true, status: "ready", model: "synthetic", location: "global", wsPath: "/api/one/voice/live" };

describe("voice compute follows verified owner hosting", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.resetAllMocks();
    window.sessionStorage.clear();
    state.uid = "owner-a";
    publishValidatedAuthSessionOwner(null);
    publishValidatedAuthSessionOwner(state.uid);
    readiness.mockResolvedValue(ready);
  });

  it.each([
    ["byoc", "pod_commands"], ["shared", "shared_live"],
    ["pending", "none"], ["unknown", "none"], ["hussh_pods", "none"],
    [undefined, "none"],
  ])("selects %s without treating missing placement as Shared", async (hostingMode, expected) => {
    hosting.mockResolvedValue({ hostingMode });
    render(view());
    await screen.findByText(expected);
  });

  it("refreshes placement even with a cached ready hub and after focus", async () => {
    window.sessionStorage.setItem("one_voice_readiness_v1:owner-a", JSON.stringify({
      at: Date.now(), value: { status: "resolved", liveEnabled: true, serverStatus: "ready", model: "synthetic", location: "global", wsPath: "/api/one/voice/live" },
    }));
    hosting.mockResolvedValueOnce({ hostingMode: "shared" }).mockResolvedValue({ hostingMode: "byoc" });
    render(view());
    await screen.findByText("shared_live");
    act(() => { window.dispatchEvent(new Event("focus")); });
    await screen.findByText("pod_commands");
    expect(hosting).toHaveBeenCalledTimes(2);
    expect(readiness).not.toHaveBeenCalled();
  });

  it("does not extend provider-cache lifetime when focus reuses it", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    hosting.mockResolvedValue({ hostingMode: "shared" });
    render(view());
    await screen.findByText("shared_live");
    now += 9 * 60_000;
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(hosting).toHaveBeenCalledTimes(2));
    expect(readiness).toHaveBeenCalledOnce();
    now += 2 * 60_000;
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(readiness).toHaveBeenCalledTimes(2));
  });

  it("refuses unavailable placement without arming either microphone", async () => {
    hosting.mockRejectedValue(new Error("synthetic registry failure"));
    render(view());
    await screen.findByText("none");
  });

  it("recovers in the same tab after the existing hosting invalidation", async () => {
    hosting.mockRejectedValueOnce(new Error("synthetic outage"))
      .mockResolvedValue({ hostingMode: "byoc" });
    render(view());
    await screen.findByText("none");
    act(() => dispatchFeedStateChanged());
    await screen.findByText("pod_commands");
    expect(readiness).not.toHaveBeenCalled();
  });

  it("discards an old owner's response even after returning to the same UID", async () => {
    let settle!: (value: { hostingMode: string }) => void;
    hosting.mockReturnValueOnce(new Promise(resolve => { settle = resolve; }));
    const mounted = render(view());
    await waitFor(() => expect(hosting).toHaveBeenCalledOnce());
    publishValidatedAuthSessionOwner("owner-b");
    publishValidatedAuthSessionOwner("owner-a");
    hosting.mockResolvedValue({ hostingMode: "byoc" });
    mounted.rerender(view());
    await screen.findByText("pod_commands");
    await act(async () => { settle({ hostingMode: "shared" }); });
    expect(screen.getByText("pod_commands")).toBeTruthy();
  });
});
