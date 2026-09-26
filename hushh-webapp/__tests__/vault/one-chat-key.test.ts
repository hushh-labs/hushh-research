// @vitest-environment node
/**
 * One chat history is sealed with a key derived in the browser from the vault
 * key. Only the derived key travels, in the X-Hussh-Chat-Key header, and every
 * proxy on the way to the backend must forward it untouched.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "https://backend.test",
}));

import {
  ONE_CHAT_KEY_HEADER,
  ONE_CHAT_KEY_LABEL,
  deriveOneChatKey,
  oneChatKeyHeaders,
} from "@/lib/vault/one-chat-key";

const VAULT_KEY = "0f".repeat(32);
// Same vector as consent-protocol/tests/test_chat_history_byok.py.
const EXPECTED = "hck1.0a3419cafc7896f9384d95ec76704bb30b272e913e80702075270f69a2feae8b";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("one chat key derivation", () => {
  it("matches the backend HKDF vector and never echoes the vault key", async () => {
    expect(ONE_CHAT_KEY_LABEL).toBe("hussh-one-chat-v1");
    const derived = await deriveOneChatKey(VAULT_KEY);
    expect(derived).toBe(EXPECTED);
    expect(derived).not.toContain(VAULT_KEY);
    expect(await deriveOneChatKey(VAULT_KEY.toUpperCase())).toBe(EXPECTED);
    expect(await oneChatKeyHeaders(VAULT_KEY)).toEqual({ [ONE_CHAT_KEY_HEADER]: EXPECTED });
  });

  it.each([null, undefined, "", "abc", "zz".repeat(32)])(
    "refuses to derive without an unlocked vault key (%s)",
    async (value) => {
      await expect(deriveOneChatKey(value)).rejects.toThrow("Unlock your vault");
    },
  );
});

describe("proxies forward the chat key and nothing derived from the vault key", () => {
  it("forwards X-Hussh-Chat-Key through the /api/one proxy", async () => {
    const upstream = vi.fn().mockResolvedValue(Response.json({ conversations: [] }));
    vi.stubGlobal("fetch", upstream);
    const route = await import("../../app/api/one/[...path]/route");
    const request = new NextRequest("http://localhost:3000/api/one/agent-chat/conversations/u1", {
      headers: { Authorization: "Bearer fixture", [ONE_CHAT_KEY_HEADER]: EXPECTED },
    });
    const response = await route.GET(request, {
      params: Promise.resolve({ path: ["agent-chat", "conversations", "u1"] }),
    });
    expect(response.status).toBe(200);
    const headers = new Headers((upstream.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get(ONE_CHAT_KEY_HEADER)).toBe(EXPECTED);
    expect(String(upstream.mock.calls[0][0])).not.toContain("hck1");
  });

  it("forwards X-Hussh-Chat-Key through the connectors proxy for MCP review", async () => {
    const upstream = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", upstream);
    const { proxyExternalConnectorRequest } = await import("@/app/api/connectors/_proxy");
    await proxyExternalConnectorRequest(
      new NextRequest("https://app.test/api/connectors/custom_synthetic/mcp/review", {
        method: "POST",
        headers: {
          Authorization: "Bearer fixture",
          "Content-Type": "application/json",
          [ONE_CHAT_KEY_HEADER]: EXPECTED,
        },
        body: JSON.stringify({ conversationId: "t", toolName: "mcp_x", arguments: {} }),
      }),
      ["custom_synthetic", "mcp", "review"],
    );
    const headers = new Headers((upstream.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get(ONE_CHAT_KEY_HEADER)).toBe(EXPECTED);
  });
});
