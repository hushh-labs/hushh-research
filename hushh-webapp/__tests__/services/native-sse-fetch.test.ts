// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ isNative: true }));
const owner = vi.hoisted(() => ({ current: true }));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => native.isNative,
    getPlatform: () => (native.isNative ? "ios" : "web"),
  },
}));

const plugin = vi.hoisted(() => {
  const listeners = new Set<(event: unknown) => void>();
  return {
    listeners,
    emit(event: unknown) {
      for (const listener of listeners) listener(event);
    },
    open: vi.fn(),
    cancel: vi.fn(async () => ({ cancelled: true })),
    addListener: vi.fn(async (_name: string, fn: (event: unknown) => void) => {
      listeners.add(fn);
      return { remove: () => listeners.delete(fn) };
    }),
  };
});

vi.mock("@/lib/capacitor/stream", () => ({
  HUSHH_STREAM_EVENT: "hushhStreamEvent",
  HushhStream: plugin,
}));

const apiFetchStream = vi.hoisted(() => vi.fn(async () => new Response("web", { status: 200 })));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetchStream },
}));

const verificationRequired = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/session-owner", () => ({
  snapshotValidatedAuthSessionOwner: () => ({ userId: "uid-1", generation: 1 }),
  isValidatedAuthSessionOwnerCurrent: () => owner.current,
  dispatchAuthSessionVerificationRequired: verificationRequired,
}));

import { nativeStreamFetch, streamBridgeErrorCode } from "@/lib/services/native-sse-fetch";

const encoder = new TextEncoder();
const b64 = (bytes: Uint8Array | string) => {
  const array = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
  let binary = "";
  for (const byte of array) binary += String.fromCharCode(byte);
  return btoa(binary);
};

async function readText(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function openedWith(status = 200, headers: Record<string, string> = { "content-type": "text/event-stream" }) {
  plugin.open.mockImplementation(async () => ({ status, headers }));
}

describe("nativeStreamFetch", () => {
  beforeEach(() => {
    native.isNative = true;
    owner.current = true;
    plugin.listeners.clear();
    plugin.open.mockReset();
    plugin.cancel.mockClear();
    plugin.addListener.mockClear();
    apiFetchStream.mockClear();
    verificationRequired.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates to apiFetchStream on web", async () => {
    native.isNative = false;
    const response = await nativeStreamFetch("/api/one/agent-chat", { method: "POST" });
    expect(await response.text()).toBe("web");
    expect(apiFetchStream).toHaveBeenCalledWith("/api/one/agent-chat", { method: "POST" });
    expect(plugin.open).not.toHaveBeenCalled();
  });

  it("streams raw bytes as they arrive, preserving SSE framing across chunks", async () => {
    openedWith();
    const pending = nativeStreamFetch("/api/one/agent-chat", {
      method: "POST",
      headers: { Authorization: "Bearer HCT:abc", "Content-Type": "application/json" },
      body: JSON.stringify({ hello: true }),
    });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const call = plugin.open.mock.calls[0][0] as { streamId: string; path: string; method: string; headers: Record<string, string>; body: string };
    expect(call.path).toBe("/api/one/agent-chat");
    expect(call.method).toBe("POST");
    expect(call.headers.Authorization).toBe("Bearer HCT:abc");
    expect(call.headers["x-request-id"]).toBeTruthy();
    expect(call.headers.Accept).toBe("text/event-stream");
    expect(call.body).toBe(JSON.stringify({ hello: true }));

    // A `data:` block split in the middle, and a 3-byte character (€) split across chunks.
    const text = 'data: {"a":1}\n\ndata: {"b":"€"}\n\n';
    const bytes = encoder.encode(text);
    const cut1 = 9;
    const cut2 = bytes.length - 6; // inside the € sequence
    plugin.emit({ streamId: call.streamId, type: "chunk", base64: b64(bytes.slice(0, cut1)) });
    plugin.emit({ streamId: call.streamId, type: "chunk", base64: b64(bytes.slice(cut1, cut2)) });
    plugin.emit({ streamId: call.streamId, type: "chunk", base64: b64(bytes.slice(cut2)) });
    plugin.emit({ streamId: call.streamId, type: "end" });

    expect(await readText(response)).toBe(text);
  });

  it("ignores events for other streams", async () => {
    openedWith();
    const response = await nativeStreamFetch("/api/one/agent-chat", { method: "POST" });
    const { streamId } = plugin.open.mock.calls[0][0] as { streamId: string };
    plugin.emit({ streamId: "someone-else", type: "chunk", base64: b64("nope") });
    plugin.emit({ streamId, type: "chunk", base64: b64("mine") });
    plugin.emit({ streamId: "someone-else", type: "end" });
    plugin.emit({ streamId, type: "end" });
    expect(await readText(response)).toBe("mine");
  });

  it("aborting the signal cancels the native stream and rejects the reader", async () => {
    openedWith();
    const controller = new AbortController();
    const response = await nativeStreamFetch("/api/one/agent-chat", { method: "POST", signal: controller.signal });
    const { streamId } = plugin.open.mock.calls[0][0] as { streamId: string };
    const reader = response.body!.getReader();
    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    expect(plugin.cancel).toHaveBeenCalledWith({ streamId });
  });

  it("cancelling the reader cancels the native stream", async () => {
    openedWith();
    const response = await nativeStreamFetch("/api/one/agent-chat", { method: "POST" });
    const { streamId } = plugin.open.mock.calls[0][0] as { streamId: string };
    await response.body!.cancel();
    expect(plugin.cancel).toHaveBeenCalledWith({ streamId });
  });

  it("a native failure after the headers errors the stream with its code", async () => {
    openedWith();
    const response = await nativeStreamFetch("/api/one/agent-chat", { method: "POST" });
    const { streamId } = plugin.open.mock.calls[0][0] as { streamId: string };
    const reader = response.body!.getReader();
    plugin.emit({ streamId, type: "end", error: "The network connection was lost.", code: "NETWORK" });
    await expect(reader.read()).rejects.toMatchObject({ code: "NETWORK" });
  });

  it("a rejected open rejects the fetch", async () => {
    plugin.open.mockImplementation(async () => {
      throw Object.assign(new Error("Backend URL is not configured"), { code: "HUSHH_STREAM_NO_BACKEND" });
    });
    await expect(nativeStreamFetch("/api/one/agent-chat", { method: "POST" })).rejects.toThrow(/Backend URL/);
    expect(plugin.listeners.size).toBe(0);
  });

  it("a 401 for a vault-owner bearer drains the body and asks the vault to lock", async () => {
    openedWith(401, { "content-type": "application/json" });
    const lock = vi.fn();
    window.addEventListener("vault-lock-requested", lock as EventListener, { once: true });
    const pending = nativeStreamFetch("/api/one/agent-chat", {
      method: "POST",
      headers: { Authorization: "Bearer HCT:abc" },
    });
    await Promise.resolve();
    const { streamId } = plugin.open.mock.calls[0][0] as { streamId: string };
    plugin.emit({ streamId, type: "chunk", base64: b64('{"detail":"Vault owner token rejected"}') });
    plugin.emit({ streamId, type: "end" });
    const response = await pending;
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("rejected");
    expect(lock).toHaveBeenCalledTimes(1);
    expect((lock.mock.calls[0][0] as CustomEvent).detail).toEqual({
      reason: "AUTH_VAULT_OWNER_INVALID",
      path: "/api/one/agent-chat",
    });
  });

  it("never locks the vault for a stream that another identity started", async () => {
    openedWith(401, { "content-type": "application/json" });
    owner.current = false;
    const lock = vi.fn();
    window.addEventListener("vault-lock-requested", lock as EventListener, { once: true });
    const pending = nativeStreamFetch("/api/one/agent-chat", {
      method: "POST",
      headers: { Authorization: "Bearer HCT:abc" },
    });
    await Promise.resolve();
    const { streamId } = plugin.open.mock.calls[0][0] as { streamId: string };
    plugin.emit({ streamId, type: "chunk", base64: b64("{}") });
    plugin.emit({ streamId, type: "end" });
    await pending;
    expect(lock).not.toHaveBeenCalled();
    window.removeEventListener("vault-lock-requested", lock as EventListener);
  });

  it("classifies lifecycle codes like the native Kai bridge", () => {
    expect(streamBridgeErrorCode(401, '{"detail":{"code":"AUTH_ACCOUNT_NOT_FOUND"}}')).toBe("AUTH_ACCOUNT_NOT_FOUND");
    expect(streamBridgeErrorCode(423, '{"detail":{"code":"AUTH_ACCOUNT_DELETION_IN_PROGRESS"}}')).toBe(
      "AUTH_ACCOUNT_DELETION_IN_PROGRESS",
    );
    expect(streamBridgeErrorCode(503, '{"detail":{"code":"AUTH_ACCOUNT_STATUS_UNAVAILABLE"}}')).toBe(
      "AUTH_ACCOUNT_STATUS_UNAVAILABLE",
    );
    expect(streamBridgeErrorCode(401, '{"detail":"nope"}')).toBe("AUTH_VAULT_OWNER_INVALID");
    expect(streamBridgeErrorCode(403, "")).toBe("AUTH_VAULT_OWNER_INVALID");
    expect(streamBridgeErrorCode(500, "boom")).toBe("HUSHH_HTTP_500");
    // A lifecycle code on the wrong status is not trusted.
    expect(streamBridgeErrorCode(500, '{"detail":{"code":"AUTH_ACCOUNT_NOT_FOUND"}}')).toBe("HUSHH_HTTP_500");
  });
});
