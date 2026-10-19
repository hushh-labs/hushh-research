import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectCallSession } from "@/lib/direct-messages/call-session";
import { ApiError } from "@/lib/services/api-client";
import type { DirectCall, DirectCallsService } from "@/lib/services/direct-calls-service";
import type { CallMedia } from "@/lib/direct-messages/call-media";

vi.mock("@/lib/direct-messages/call-crypto", () => ({
  digest: async () => "synthetic-code", callSignalContext: () => "synthetic-context",
  verifyCallProof: async () => undefined, openCallSignal: async () => ({ type: "offer", sdp: "synthetic" }),
  sealCallSignal: async () => ({ synthetic: true }),
}));

const base: DirectCall = { id: "call", conversationId: "conversation", state: "ringing", revision: 1,
  expiresAt: 9999999999, isCaller: false, callerDeviceId: "caller", calleeDeviceId: null };
function fixture(incoming = false) {
  const call = { ...base, isCaller: !incoming };
  const service = { identity: { deviceId: incoming ? "callee" : "caller" }, userId: incoming ? "bob" : "alice",
    capabilities: vi.fn(async () => ({ available: true })), initialize: vi.fn(async () => undefined),
    inbox: vi.fn(async () => ({ items: [call] })), create: vi.fn(async () => call),
    devices: vi.fn(async () => ({ items: [
      { deviceId: "caller", userId: "alice" }, { deviceId: "callee", userId: "bob" },
    ] })), relay: vi.fn(async () => ({})), offer: vi.fn(async () => call),
    read: vi.fn(async () => ({ ...call, offers: [{ synthetic: true }],
      offerProof: { payload: { callId: call.id, offers: [{ synthetic: true }] }, proof: {} }, signals: [] })),
    action: vi.fn(async (_call: DirectCall, action: string) => ({ ...call,
      state: action === "accept" ? "connecting" as const : "ended" as const, calleeDeviceId: "callee", revision: 2 })),
  };
  let connected!: () => void;
  const media = { open: vi.fn(async (_config: unknown, onConnected: () => void) => { connected = onConnected; }),
    description: vi.fn(async () => ({ type: "offer", sdp: "synthetic" })), stop: vi.fn(), remote: vi.fn() };
  const publish = vi.fn();
  const session = new DirectCallSession(service as unknown as DirectCallsService, publish, async () => false, media as unknown as CallMedia);
  return { service, media, publish, session, connected: () => connected() };
}
afterEach(() => { vi.useRealTimers(); });

describe("call session concurrency", () => {
  it("ignores an old rendered call's Answer, End and Mute intents", async () => {
    vi.useFakeTimers();
    const f = fixture(true);
    await f.session.initialize(); await vi.advanceTimersByTimeAsync(2000);
    f.media.stop.mockClear();
    const reads = f.service.read.mock.calls.length;
    await f.session.answer("old-call");
    await f.session.end(true, "old-call");
    f.session.mute("old-call");
    expect(f.service.read).toHaveBeenCalledTimes(reads);
    expect(f.service.action).not.toHaveBeenCalled();
    expect(f.media.stop).not.toHaveBeenCalled();
    expect(f.publish.mock.lastCall?.[0].muted).toBe(false);
    f.session.dispose();
  });
  it("accepts at most once when Answer is activated twice during a deferred read", async () => {
    vi.useFakeTimers();
    const f = fixture(true);
    await f.session.initialize(); await vi.advanceTimersByTimeAsync(2000);
    const remote = await f.service.read();
    let resolve!: (value: typeof remote) => void;
    f.service.read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const first = f.session.answer(); await Promise.resolve();
    await f.session.answer();
    resolve(remote); await first;
    expect(f.service.action.mock.calls.filter(([, action]) => action === "accept")).toHaveLength(1);
    // Rejected human verification never admits the microphone.
    expect(f.media.open).not.toHaveBeenCalled(); f.session.dispose();
  });

  it("does not accept after cancellation while the offer read is pending", async () => {
    vi.useFakeTimers();
    const f = fixture(true);
    await f.session.initialize(); await vi.advanceTimersByTimeAsync(2000);
    const remote = await f.service.read();
    let resolve!: (value: typeof remote) => void;
    f.service.read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const answering = f.session.answer(); await Promise.resolve();
    await f.session.end(); resolve(remote); await answering;
    expect(f.service.action.mock.calls.some(([, action]) => action === "accept")).toBe(false);
    expect(f.media.open).not.toHaveBeenCalled(); f.session.dispose();
  });

  it("retries the simultaneous connected CAS once without ending healthy media", async () => {
    const f = fixture(); await f.session.start("conversation");
    f.service.action.mockRejectedValueOnce(new ApiError("Call changed", 409, { code: "CALL_CHANGED" }));
    f.connected();
    await vi.waitFor(() => expect(f.service.action).toHaveBeenCalledTimes(2));
    expect(f.service.action.mock.calls.every(([, action]) => action === "connected")).toBe(true);
    expect(f.media.stop).not.toHaveBeenCalled(); f.session.dispose();
  });
});
