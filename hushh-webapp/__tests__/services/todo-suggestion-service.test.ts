import { beforeEach, describe, expect, it, vi } from "vitest";
import { suggestTodoTasks } from "@/lib/services/todo-suggestion-service";
import { apiJson } from "@/lib/services/api-client";
import { ownerContentIsPrivate } from "@/lib/services/private-agent-specialist-chat";

vi.mock("@/lib/services/api-client", () => ({ apiJson: vi.fn() }));
vi.mock("@/lib/services/private-agent-specialist-chat", () => ({ ownerContentIsPrivate: vi.fn() }));
const sources = [{ key: "opaque-local-handle", capability: "calendar" as const, summary: "An upcoming meeting", href: "/one/calendar" }];
const input = () => ({ vaultOwnerToken: "fixture-owner-token", sources, allowModelProcessing: true as const, isCurrent: () => true });
describe("One task suggestion boundary", () => {
  beforeEach(() => {
    vi.mocked(ownerContentIsPrivate).mockResolvedValue(false);
    vi.mocked(apiJson).mockReset().mockResolvedValue({ items: [{ source_ref: "s1", title: "Prepare notes", reason: "Prepare for the upcoming meeting." }] });
  });
  it("sends only approved summary fields and resolves navigation locally", async () => {
    const result = await suggestTodoTasks(input());
    expect(result[0]).toEqual({ key: sources[0].key, capability: "calendar", href: "/one/calendar", title: "Prepare notes", reason: "Prepare for the upcoming meeting." });
    const body = JSON.parse(vi.mocked(apiJson).mock.calls[0][1]!.body as string);
    expect(body).toEqual({ allow_model_processing: true, sources: [{ ref: "s1", capability: "calendar", summary: "An upcoming meeting", already_pending: false }] });
    expect(JSON.stringify(body)).not.toContain("opaque-local-handle");
    expect(JSON.stringify(body)).not.toContain("fixture-owner-token");
    expect(JSON.stringify(body)).not.toContain("/one/calendar");
  });
  it("keeps all represented capabilities inside the bounded model input even with a large Wallet queue", async () => {
    const capabilities = ["messages", "finance", "wallet", "location", "ria", "gmail", "calendar", "pkm", "consent"] as const;
    const largeQueue = Array.from({ length: 150 }, (_, index) => ({ ...sources[0], key: `wallet:${index}`, capability: "wallet" as const }));
    await suggestTodoTasks({ ...input(), sources: [...largeQueue, ...capabilities.map(capability => ({ ...sources[0], key: capability, capability }))] });
    const body = JSON.parse(vi.mocked(apiJson).mock.calls[0][1]!.body as string);
    expect(body.sources).toHaveLength(100);
    expect(new Set(body.sources.map((source: { capability: string }) => source.capability))).toEqual(new Set(capabilities));
  });
  it("refuses empty input instead of presenting an unexecuted model stage as an empty answer", async () => {
    await expect(suggestTodoTasks({ ...input(), sources: [] })).rejects.toThrow("No task summaries");
    expect(apiJson).not.toHaveBeenCalled();
  });
  it("never forwards private placement summaries to the hub", async () => {
    vi.mocked(ownerContentIsPrivate).mockResolvedValue(true);
    await expect(suggestTodoTasks(input())).rejects.toThrow(/private agent/);
    expect(apiJson).not.toHaveBeenCalled();
  });
  it("drops results after owner or vault authority changes", async () => {
    let current = true;
    vi.mocked(apiJson).mockImplementation(async () => { current = false; return { items: [] }; });
    await expect(suggestTodoTasks({ ...input(), isCurrent: () => current })).rejects.toThrow("Session changed");
  });
  it.each([["other"], ["s1", "s1"]])("rejects ungrounded or duplicate model refs %j", async (...refs) => {
    vi.mocked(apiJson).mockResolvedValue({ items: refs.map(ref => ({ source_ref: ref, title: "Title", reason: "Reason" })) });
    await expect(suggestTodoTasks(input())).rejects.toThrow("could not be verified");
  });
});
