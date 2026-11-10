// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn(), replace: vi.fn(), read: vi.fn(), write: vi.fn(), version: vi.fn(), rewrite: vi.fn() }));
vi.mock("@/lib/pkm/markdown-memory", () => ({ loadMarkdownMemory: mocks.load, replaceChatMarkdownMemory: mocks.replace }));
vi.mock("@/lib/services/secure-durable-resource-service", () => ({
  SecureDurableResourceService: { read: mocks.read, write: mocks.write, version: mocks.version },
  subscribeDurableOwnerReset: () => () => undefined,
}));
vi.mock("@/lib/agent/agent-pkm-auto-save-policy", () => ({ AGENT_PKM_PRODUCT_DEFAULT_EFFECTIVE_AT: "2026-09-04T00:00:00.000Z" }));
vi.mock("@/lib/agent/chat-memory-rewrite", () => ({ rewriteChatMemory: mocks.rewrite }));
import { ownerChatMemory } from "../chat-memory-owner";
import { createChatMemoryRuntime, type ChatMemoryMessage, type ChatMemoryRewriteInput } from "../chat-memory-runtime";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { DurableResourceError } from "@/lib/services/durable-resource-error";

let memory: { markdown: string; persisted: boolean; chatMemoryCheckpoint: { version: 1; editGeneration: number; conversations: Record<string, string[]>; requests: string[] } };
let durable: unknown;
let revision: number;
const session = { userId: "owner", vaultKey: "key", vaultOwnerToken: "token" };
const source = (id: string, content = `Owner detail ${id}`): ChatMemoryMessage => ({ id, conversationId: "chat", role: "user", content });
const runtimes: ReturnType<typeof createChatMemoryRuntime>[] = [];
type Rewrite = ReturnType<typeof vi.fn<(input: ChatMemoryRewriteInput) => Promise<{ markdown: string }>>>;
function create(rewrite: Rewrite = vi.fn(async (_input: ChatMemoryRewriteInput) => ({ markdown: "- Updated memory\n" })), options = {}) {
  const runtime = createChatMemoryRuntime({ getSession: () => session, rewrite, ...options });
  runtimes.push(runtime); return { runtime, rewrite };
}
beforeEach(() => {
  vi.clearAllMocks(); publishValidatedAuthSessionOwner("owner");
  memory = { markdown: "- Existing fact\n", persisted: true,
    chatMemoryCheckpoint: { version: 1, editGeneration: 0, conversations: {}, requests: [] } };
  durable = null; revision = 0;
  mocks.load.mockImplementation(async () => structuredClone(memory));
  mocks.replace.mockImplementation(async params => {
    await params.beforeEffect();
    if (params.expectedMarkdown !== memory.markdown ||
      JSON.stringify(params.expectedCheckpoint) !== JSON.stringify(memory.chatMemoryCheckpoint)) return { success: false, conflict: true };
    memory = { ...memory, markdown: params.markdown, chatMemoryCheckpoint: structuredClone(params.checkpoint) };
    return { success: true };
  });
  mocks.version.mockImplementation(async () => ({ generation: 0, revision }));
  mocks.read.mockImplementation(async () => durable ? { value: structuredClone(durable), generation: 0, revision } : null);
  mocks.write.mockImplementation(async params => {
    if (!params.isCurrent()) throw new Error("Retired session");
    durable = structuredClone(params.value); revision += 1; return { generation: 0, revision };
  });
});
afterEach(() => { advanceVaultSessionEpoch(); runtimes.splice(0).forEach(runtime => runtime.clear()); vi.useRealTimers(); });

describe("incremental owner chat memory", () => {
  it("keeps one owner writer across navigation and cancels it immediately on lock", async () => {
    const owner = { ...session, token: session.vaultOwnerToken, vaultEpoch: snapshotVaultSessionEpoch(), readToken: () => session.vaultOwnerToken };
    const first = ownerChatMemory(owner);
    const afterNavigation = ownerChatMemory(owner);
    expect(afterNavigation).toBe(first);
    await first.registerSnapshot({ conversationId: "chat", messages: [source("nav")] });
    let release!: (value: { markdown: string }) => void;
    mocks.rewrite.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const rewrite = afterNavigation.trigger("switch");
    await vi.waitFor(() => expect(mocks.rewrite).toHaveBeenCalledOnce());
    advanceVaultSessionEpoch();
    release({ markdown: "- Late result after lock" });
    await expect(rewrite).rejects.toThrow();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(memory.markdown).toContain("Existing fact");
  });

  it("commits only new messages and checkpoints tokens only after the store acknowledges", async () => {
    const { runtime, rewrite } = create();
    await runtime.registerSnapshot({ conversationId: "chat", messages: [source("a")] });
    await runtime.recordUsage({ requestId: "r1", inputTokens: 20 });
    mocks.replace.mockResolvedValueOnce({ success: false });
    expect(await runtime.trigger("remember")).toBe(false);
    expect(memory.chatMemoryCheckpoint.requests).toEqual([]);
    expect(await runtime.trigger("remember")).toBe(true);
    expect(memory.chatMemoryCheckpoint.conversations.chat).toEqual(["a"]);
    expect(memory.chatMemoryCheckpoint.requests).toEqual(["r1"]);
    await runtime.registerSnapshot({ conversationId: "chat", messages: [source("a"), source("b")] });
    await runtime.trigger("new_chat");
    expect(rewrite.mock.calls.at(-1)![0].messages.map((message: ChatMemoryMessage) => message.id)).toEqual(["b"]);
  });

  it("retains arrivals during a rewrite and subtracts only its acknowledged request window", async () => {
    let release!: (value: { markdown: string }) => void;
    const rewrite = vi.fn(() => new Promise<{ markdown: string }>(resolve => { release = resolve; }));
    const { runtime } = create(rewrite);
    await runtime.registerSnapshot({ conversationId: "chat", messages: [source("a")] });
    await runtime.recordUsage({ requestId: "r1", inputTokens: 30 });
    const operation = runtime.trigger("remember");
    await vi.waitFor(() => expect(rewrite).toHaveBeenCalledOnce());
    await runtime.registerSnapshot({ conversationId: "chat", messages: [source("a"), source("b")] });
    await runtime.recordUsage({ requestId: "r2", inputTokens: 40 });
    release({ markdown: "- A was integrated\n" }); await operation;
    expect(memory.chatMemoryCheckpoint.requests).toEqual(["r1"]);
    expect(durable).toMatchObject({ messages: [{ id: "b" }], requests: [{ requestId: "r2", inputTokens: 40 }] });
  });

  it("reprepares against a concurrent document and withdraws pre-edit sources after Forget", async () => {
    const rewrite = vi.fn(async () => {
      memory = { ...memory, markdown: "- Owner edited\n", chatMemoryCheckpoint: { ...memory.chatMemoryCheckpoint, editGeneration: 1 } };
      return { markdown: "- Stale result\n" };
    });
    const { runtime } = create(rewrite);
    await runtime.registerSnapshot({ conversationId: "chat", messages: [source("a")] });
    await runtime.recordUsage({ requestId: "r1", inputTokens: 75 });
    expect(await runtime.trigger("remember")).toBe(false);
    expect(memory.markdown).toBe("- Owner edited\n");
    await runtime.registerSnapshot({ conversationId: "chat", messages: [source("a"), source("b")] });
    expect(durable).toMatchObject({ messages: [{ id: "b" }] });
    expect(durable).toMatchObject({ requests: [{ requestId: "r1", inputTokens: 75 }] });
    expect(rewrite).toHaveBeenCalledOnce();
  });

  it("does not persist grant-derived messages or credentials, and refuses late effects after lock", async () => {
    let release!: (value: { markdown: string }) => void;
    const { runtime, rewrite } = create(vi.fn(() => new Promise<{ markdown: string }>(resolve => { release = resolve; })));
    await runtime.registerSnapshot({ conversationId: "chat", messages: [
      source("a", "I like tea. password: not-a-real-password"), { ...source("shared", "Somebody else's private fact"), consentDerived: true },
    ] });
    expect(JSON.stringify(durable)).not.toContain("not-a-real-password");
    expect(JSON.stringify(durable)).not.toContain("Somebody else's private fact");
    const operation = runtime.trigger("remember");
    await vi.waitFor(() => expect(rewrite).toHaveBeenCalledOnce());
    advanceVaultSessionEpoch(); runtime.clear(); release({ markdown: "- Too late\n" });
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("restores encrypted pending work after refresh and UPSERTs duplicate usage events", async () => {
    const first = create().runtime;
    await first.registerSnapshot({ conversationId: "chat", messages: [source("a")] });
    await first.recordUsage({ requestId: "r1", inputTokens: 30 });
    await first.recordUsage({ requestId: "r1", inputTokens: 50 });
    expect(durable).toMatchObject({ requests: [{ requestId: "r1", inputTokens: 50 }] });
    first.clear();
    const { runtime, rewrite } = create();
    expect(await runtime.trigger("switch")).toBe(true);
    expect(rewrite.mock.calls[0]![0].messages).toHaveLength(1);
    await runtime.recordUsage({ requestId: "r1", inputTokens: 80 });
    expect(durable).toMatchObject({ requests: [] });
  });

  it("drains bounded source prefixes without losing later messages", async () => {
    const { runtime, rewrite } = create();
    await runtime.registerSnapshot({ conversationId: "chat", messages: [source("a", "A".repeat(120_000)), source("b", "B".repeat(120_000))] });
    expect(await runtime.trigger("remember")).toBe(true);
    expect(rewrite).toHaveBeenCalledTimes(2);
    expect(rewrite.mock.calls.map(call => call[0].messages.map((message: ChatMemoryMessage) => message.id))).toEqual([["a"], ["b"]]);
    expect(memory.chatMemoryCheckpoint.conversations.chat).toEqual(["a", "b"]);
  });

  it("processes an oversized single prompt as exact ordered parts and never replays committed parts", async () => {
    const content = `${"a".repeat(191_999)}🦊${"b".repeat(20_000)}`;
    const { runtime, rewrite } = create();
    await runtime.registerSnapshot({ conversationId: "chat", messages: [source("large", content)] });
    expect(await runtime.trigger("remember")).toBe(true);
    const parts = rewrite.mock.calls.flatMap(call => call[0].messages);
    expect(parts.map(part => part.content).join("")).toBe(content);
    expect(parts.map(part => part.id)).toEqual(["large:part:1/2", "large:part:2/2"]);
    expect(parts.every(part => part.content.length <= 192_000 && part.role === "user" && part.conversationId === "chat")).toBe(true);
    expect(parts[1]!.content.startsWith("🦊")).toBe(true);
    await runtime.registerSnapshot({ conversationId: "chat", messages: [source("large", content)] });
    expect(await runtime.trigger("new_chat")).toBe(false);
    expect(rewrite).toHaveBeenCalledTimes(2);
  });

  it("flushes on the idle timer and coalesces simultaneous triggers", async () => {
    vi.useFakeTimers();
    const { runtime, rewrite } = create();
    await runtime.registerSnapshot({ conversationId: "chat", messages: [source("a")] });
    await vi.advanceTimersByTimeAsync(150_000);
    await runtime.registerSnapshot({ conversationId: "chat", messages: [source("a")] });
    await vi.advanceTimersByTimeAsync(150_000);
    expect(rewrite).toHaveBeenCalledOnce();
    await runtime.trigger("switch");
    expect(rewrite).toHaveBeenCalledOnce();
  });

  it("retains accounting after a failed explicit rewrite and retries on the idle trigger", async () => {
    vi.useFakeTimers();
    const { runtime, rewrite } = create();
    rewrite.mockRejectedValueOnce(new Error("Provider unavailable"));
    await runtime.registerSnapshot({ conversationId: "chat", messages: [source("retry")] });
    await runtime.recordUsage({ requestId: "retry-request", inputTokens: 500 });
    await expect(runtime.trigger("remember")).rejects.toThrow("Provider unavailable");
    expect(memory.chatMemoryCheckpoint.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(rewrite).toHaveBeenCalledTimes(2);
    expect(memory.chatMemoryCheckpoint.requests).toEqual(["retry-request"]);
  });

  it("waits for an available source when request usage crossed the threshold first", async () => {
    const { runtime, rewrite } = create();
    await runtime.recordUsage({ requestId: "r1", inputTokens: 12_000 });
    await runtime.trigger("tokens");
    expect(rewrite).not.toHaveBeenCalled();
    await runtime.registerSnapshot({ conversationId: "chat", messages: [source("a")] });
    await vi.waitFor(() => expect(memory.chatMemoryCheckpoint.requests).toEqual(["r1"]));
    expect(rewrite).toHaveBeenCalledOnce();
  });

  it("reloads and merges another tab's durable window after a CAS conflict", async () => {
    const { runtime } = create();
    await runtime.registerSnapshot({ conversationId: "chat", messages: [source("a")] });
    const remote = structuredClone(durable) as { messages: ChatMemoryMessage[] };
    remote.messages.push(source("b"));
    mocks.write.mockImplementationOnce(async () => {
      durable = remote; revision += 1;
      throw new DurableResourceError("stale_version", "commit", "Concurrent tab changed the checkpoint");
    });
    await runtime.registerSnapshot({ conversationId: "chat", messages: [source("a"), source("c")] });
    expect((durable as { messages: ChatMemoryMessage[] }).messages.map(message => message.id)).toEqual(["a", "b", "c"]);
  });

  it("retains sources and tokens when a model returns an empty replacement", async () => {
    const { runtime } = create(vi.fn(async () => ({ markdown: "  " })));
    await runtime.registerSnapshot({ conversationId: "chat", messages: [source("a")] });
    await runtime.recordUsage({ requestId: "r1", inputTokens: 50 });
    await expect(runtime.trigger("remember")).rejects.toThrow("no document");
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(durable).toMatchObject({ messages: [{ id: "a" }], requests: [{ requestId: "r1", inputTokens: 50 }] });
  });
});
