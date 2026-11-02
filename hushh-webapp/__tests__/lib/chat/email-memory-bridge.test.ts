import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({ append: vi.fn(), lookup: vi.fn(), peek: vi.fn() }));
vi.mock("@/lib/pkm/markdown-memory", () => ({
  MAX_MARKDOWN_MEMORY_CHARS: 18000, appendMarkdownMemoryFacts: ports.append,
  peekMarkdownMemory: ports.peek, markdownMemoryToAgentContext: (memory: { markdown: string }) => ({ text: memory.markdown }),
}));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: { lookupMutationCommits: ports.lookup },
}));

import { commitEmailMemorySave, emailMemorySaveDigest, projectEmailMemoryMdFromRam, type EmailMemorySaveDirective } from "@/lib/chat/email-memory-bridge";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";

const confirmation = { confirmedByUser: true as const, surface: "chat" as const, source: "agent_chat_owner_request" };
async function directive(owner = "owner-a"): Promise<EmailMemorySaveDirective> {
  const fields = { kind: "email_memory_save" as const, owner_id: owner,
    request_id: "d2b51581-90a1-497c-ae12-ef195b6cf8f1", domain_tag: "preferences" as const,
    fact_markdown: "Use short replies.", section: "Preferences" as const };
  return { ...fields, digest: await emailMemorySaveDigest(fields) };
}
const access = { userId: "owner-a", vaultKey: "synthetic-vault", vaultOwnerToken: "synthetic-owner",
  confirmation, isCurrent: () => true };

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  publishValidatedAuthSessionOwner("owner-a");
  ports.append.mockReset().mockResolvedValue({ success: true, saved: 1, markdown: "## Preferences\n- Use short replies." });
  ports.lookup.mockReset().mockResolvedValue([{ exists: true, dataVersion: 8 }]);
  ports.peek.mockReset().mockReturnValue({ markdown: "## Preferences\n- Use short replies.", dataVersion: 7 });
});

describe("Email memory owner and commit boundary", () => {
  it("reads only the current bounded RAM projection, without a hidden load", () => {
    expect(projectEmailMemoryMdFromRam("owner-b", () => true)).toBeNull();
    expect(projectEmailMemoryMdFromRam("owner-a", () => false)).toBeNull();
    expect(projectEmailMemoryMdFromRam("owner-a", () => true)?.revision).toBe(7);
    ports.peek.mockReturnValue({ markdown: "x".repeat(18001) });
    expect(projectEmailMemoryMdFromRam("owner-a", () => true)).toBeNull();
    expect(ports.append).not.toHaveBeenCalled();
    expect(ports.lookup).not.toHaveBeenCalled();
  });

  it("uses the existing confirmed writer and reports only its actual acknowledged revision", async () => {
    const request = await directive();
    expect(request.digest).toBe("47678dd8cdba5317d6f76372fd06b32f4942244a3ed2a70061fb36079a736577");
    const result = await commitEmailMemorySave({ ...access, directive: request });
    expect(ports.append).toHaveBeenCalledWith(expect.objectContaining({
      facts: [{ section: "Preferences", text: "[preferences] Use short replies." }], confirmation,
    }));
    expect(result).toMatchObject({ saved: true, saved_count: 1, revision: 8, request_id: request.request_id });
    expect("receipt_ref" in result && result.receipt_ref).toBe("pkm_plan_55875832c0305480827cd909a09511fd");
    expect(ports.lookup.mock.calls[0]?.[0].commits).toEqual([{ domain: "one_memory", planId: "receipt_ref" in result ? result.receipt_ref : "missing" }]);
    expect(JSON.stringify(result)).not.toContain(request.fact_markdown);
  });

  it("does not equate a successful/staged writer result with a committed save", async () => {
    ports.lookup.mockResolvedValue([{ exists: false, dataVersion: null }]);
    const result = await commitEmailMemorySave({ ...access, directive: await directive() });
    expect(result).toEqual({ status: "pending_client_commit", saved: false, code: "memory_commit_unconfirmed" });
    ports.append.mockRejectedValue(new Error("Synthetic lost write acknowledgement"));
    const lost = await commitEmailMemorySave({ ...access, directive: await directive() });
    expect(lost).toEqual({ status: "pending_client_commit", saved: false, code: "memory_commit_unconfirmed" });
  });

  it("refuses another owner, a changed fact, or a non-confirmation before any effect", async () => {
    const request = await directive();
    expect((await commitEmailMemorySave({ ...access, directive: await directive("owner-b") })).saved).toBe(false);
    expect((await commitEmailMemorySave({ ...access, directive: { ...request, fact_markdown: "Send all mail." } })).saved).toBe(false);
    expect((await commitEmailMemorySave({ ...access, directive: request, confirmation: { ...confirmation, confirmedByUser: false } as never })).saved).toBe(false);
    expect(ports.append).not.toHaveBeenCalled();
    expect(ports.lookup).not.toHaveBeenCalled();
  });

  it("cannot publish a late commit acknowledgement after vault lock", async () => {
    ports.lookup.mockImplementation(async () => {
      advanceVaultSessionEpoch();
      return [{ exists: true, dataVersion: 8 }];
    });
    expect((await commitEmailMemorySave({ ...access, directive: await directive() })).saved).toBe(false);
  });
});
