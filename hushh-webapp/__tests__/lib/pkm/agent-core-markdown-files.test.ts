// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const { getStaleFirst, savePreparedDomain } = vi.hoisted(() => ({
  getStaleFirst: vi.fn(),
  savePreparedDomain: vi.fn(),
}));

const lookupMutationCommits = vi.hoisted(() =>
  vi.fn().mockResolvedValue([{ exists: false, dataVersion: null }]),
);
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: { lookupMutationCommits },
}));

const recoveryCache = vi.hoisted(() => ({
  writeRequired: vi.fn().mockResolvedValue(undefined),
  invalidateResourceRequired: vi.fn().mockResolvedValue(undefined),
  invalidateResource: vi.fn().mockResolvedValue(undefined),
  listResourceKeys: vi.fn().mockResolvedValue([]),
  readRequired: vi.fn(),
}));
vi.mock("@/lib/services/secure-resource-cache-service", () => ({
  SecureResourceCacheService: recoveryCache,
}));

vi.mock("@/lib/services/secure-durable-resource-service", () => ({
  SecureDurableResourceService: {
    version: vi.fn().mockResolvedValue({ generation: 0, revision: 0 }),
  },
  subscribeDurableOwnerReset: () => () => {},
}));

vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: { getStaleFirst },
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { savePreparedDomain },
}));

import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import {
  clearCoreAgentMarkdownCache,
  defaultCoreAgentMarkdown,
  loadCoreAgentMarkdownFile,
  peekCoreAgentMarkdownFile,
  saveCoreAgentMarkdownFile,
} from "@/lib/pkm/agent-core-markdown-files";
import {
  MARKDOWN_MEMORY_DOMAIN,
  clearMarkdownMemory,
} from "@/lib/pkm/markdown-memory";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";

afterEach(() => {
  clearCoreAgentMarkdownCache();
  clearMarkdownMemory();
  getStaleFirst.mockReset();
  savePreparedDomain.mockReset();
  publishValidatedAuthSessionOwner(null);
  vi.clearAllMocks();
});

describe("agent-core-markdown-files", () => {
  it("builds clean Hermes-aligned defaults without inventing facts", () => {
    const memory = defaultCoreAgentMarkdown("memory.md");
    const identity = defaultCoreAgentMarkdown("identity.md", {
      memoryMarkdown: "- Preferred name: Kushal\n",
      timezone: "America/Los_Angeles",
    });
    const soul = defaultCoreAgentMarkdown("soul.md", {
      styleSettings: { tone: "direct", length: "short" },
    });

    expect(memory).toContain("# Memory");
    expect(memory).toContain("## Preferences");
    expect(identity).toContain("- Preferred name: Kushal");
    expect(identity).toContain("- Timezone: America/Los_Angeles");
    expect(soul).toContain("# Soul");
    expect(soul).toContain("- Tone: Direct");
    expect(soul).toContain("- Response length: Short");
  });

  it("loads stored identity.md and soul.md separately from memory.md and clears on cache invalidation", async () => {
    publishValidatedAuthSessionOwner("user-1");
    getStaleFirst.mockImplementation(async ({ domain }: { domain: string }) => {
      if (domain === MARKDOWN_MEMORY_DOMAIN) {
        return {
          data: {
            markdown: "# Memory\n- Prefers green tea\n",
            identity_markdown: "# Identity\n- Preferred name: Alex\n",
            soul_markdown: "# Soul\n- Tone: Candid\n",
            updated_at: "2026-11-17T10:00:00.000Z",
          },
          summary: { persisted: true },
        };
      }
      return null;
    });

    const identityDoc = await loadCoreAgentMarkdownFile({
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-token",
      docId: "identity.md",
    });
    expect(identityDoc.persisted).toBe(true);
    expect(identityDoc.isDefaultTemplate).toBe(false);
    expect(identityDoc.markdown).toContain("Preferred name: Alex");
    expect(identityDoc.markdown).not.toContain("green tea");
    expect(peekCoreAgentMarkdownFile("user-1", "identity.md")?.markdown).toContain("Alex");

    advanceVaultSessionEpoch();
    expect(peekCoreAgentMarkdownFile("user-1", "identity.md")).toBeNull();
  });

  it("saves identity.md into identity_markdown without overwriting memory.md and detects edit conflicts", async () => {
    publishValidatedAuthSessionOwner("user-1");
    getStaleFirst.mockResolvedValue({
      data: {
        markdown: "# Memory\n- Existing memory\n",
        identity_markdown: "# Identity\n- Preferred name: Old\n",
        updated_at: "2026-11-17T10:00:00.000Z",
      },
      summary: { persisted: true },
    });

    let writtenDomainData: Record<string, unknown> | null = null;
    savePreparedDomain.mockImplementationOnce(async ({ build }: {
      build: (ctx: { currentDomainData: Record<string, unknown> }) => {
        domainData: Record<string, unknown>;
        summary: Record<string, unknown>;
      };
    }) => {
      const built = build({
        currentDomainData: {
          markdown: "# Memory\n- Existing memory\n",
          identity_markdown: "# Identity\n- Preferred name: Old\n",
        },
      });
      writtenDomainData = built.domainData;
      return { success: true, updatedAt: "2026-11-17T10:05:00.000Z" };
    });

    const saved = await saveCoreAgentMarkdownFile({
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-token",
      docId: "identity.md",
      markdown: "# Identity\n- Preferred name: NewName\n",
      expectedStoredMarkdown: "# Identity\n- Preferred name: Old\n",
      expectedPersisted: true,
      beforeEffect: async () => undefined,
    });

    expect(saved.success).toBe(true);
    expect(writtenDomainData).toMatchObject({
      markdown: "# Memory\n- Existing memory\n",
      identity_markdown: "# Identity\n- Preferred name: NewName\n",
    });

    savePreparedDomain.mockImplementationOnce(async ({ build }: {
      build: (ctx: { currentDomainData: Record<string, unknown> }) => unknown;
    }) => {
      try {
        build({
          currentDomainData: {
            markdown: "# Memory\n- Existing memory\n",
            identity_markdown: "# Identity\n- Preferred name: ChangedOnServer\n",
          },
        });
      } catch (err) {
        return {
          success: false,
          message: err instanceof Error ? err.message : "conflict",
        };
      }
      return { success: false };
    });

    const conflict = await saveCoreAgentMarkdownFile({
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-token",
      docId: "identity.md",
      markdown: "# Identity\n- Preferred name: StaleDraft\n",
      expectedStoredMarkdown: "# Identity\n- Preferred name: Old\n",
      expectedPersisted: true,
      beforeEffect: async () => undefined,
    });

    expect(conflict.success).toBe(false);
    expect(conflict.conflict).toBe(true);
  });
});
