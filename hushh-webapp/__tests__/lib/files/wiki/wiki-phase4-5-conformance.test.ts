import { beforeEach, describe, expect, it, vi } from "vitest";

const sharedRequest = vi.hoisted(() => vi.fn());

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: sharedRequest,
  },
}));

import { SharedFilesAdapter } from "@/lib/files/shared/adapter";
import {
  SharedWikiLibrary,
  SharedWikiMaintenanceRunner,
  SharedWikiOwnerMigrator,
  SharedWikiProjectionEngine,
  WIKI_HOT_MAX_CHARS,
  WikiRefusedError,
  normalizeStatementFingerprint,
} from "@/lib/files/wiki";

function createSharedHarness(
  owner = "fixture-phase4-owner",
  vaultKey = "d".repeat(64),
) {
  vi.stubGlobal("btoa", (value: string) =>
    Buffer.from(value, "binary").toString("base64"),
  );
  vi.stubGlobal("atob", (value: string) =>
    Buffer.from(value, "base64").toString("binary"),
  );

  const storage = new Map<string, { ciphertext: string; generation: string }>();
  let generation = 0;
  let unlocked = true;

  sharedRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = new URL(path, "https://fixture.invalid");
    const key = url.pathname;

    if (key.endsWith("/storage") && method === "POST") {
      return Response.json({ status: "accepted" });
    }
    if (key.endsWith("/storage") && method === "GET") {
      return Response.json({
        libraryId: "00000000-0000-4000-8000-000000000777",
        retention: {
          retentionLocked: false,
          softDeleteSeconds: 0,
          versioning: false,
          physicalDeletion: "not_requested_by_trash",
        },
      });
    }
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const currentGen = storage.get(key)?.generation ?? "";
      if (currentGen !== body.expectedGeneration) {
        return Response.json(
          { detail: { code: "FILES_REVISION_CONFLICT" } },
          { status: 409 },
        );
      }
      const next = {
        ciphertext: String(body.ciphertext),
        generation: String(++generation),
      };
      storage.set(key, next);
      return Response.json({ generation: next.generation });
    }
    const segments = key.split("/");
    if (segments.length === 6) {
      const prefix = `${key}/`;
      const keys = [...storage.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
        .sort();
      return Response.json({ keys, cursor: "" });
    }
    return Response.json(
      storage.get(key) ?? { ciphertext: null, generation: "" },
    );
  });

  const access = {
    owner,
    vaultKey,
    ownerToken: "fixture-owner-token",
    check: () => {
      if (!unlocked) {
        throw new WikiRefusedError("WIKI_VAULT_LOCKED", 403);
      }
    },
  };

  return {
    access,
    storage,
    setUnlocked: (value: boolean) => {
      unlocked = value;
    },
    library: new SharedWikiLibrary(access),
    adapter: new SharedFilesAdapter(access),
  };
}

describe("SharedWikiOwnerMigrator, Maintenance, and Adapter Conformance (Phase 4 & 5 #9370)", () => {
  beforeEach(() => {
    sharedRequest.mockReset();
  });

  it("compiles V1 markdown with tombstone non-resurrection, enforces 4-plane cold recovery, propagates 5-outcome Forget, and rolls back cleanly", async () => {
    const { library, storage } = createSharedHarness();
    const migrator = new SharedWikiOwnerMigrator(library);
    const projections = new SharedWikiProjectionEngine(library);

    const compileRes = await migrator.compileLegacySources({
      v1Markdown:
        "# memory.md\n\n## Travel\n- Prefers window seats on red-eye flights.\n- Uses TSA PreCheck.\n",
      idempotencyKey: "shared-mig-1",
    });
    expect(compileRes.state).toBe("dual_read_shadow_compile");
    expect(compileRes.compiled_claim_count).toBe(2);

    // Raw hub storage contains zero plaintext snippets
    const allCipher = [...storage.values()].map((v) => v.ciphertext).join("");
    expect(allCipher).not.toContain("window seats");

    const pages = await library.listPages();
    const travelId = pages.find((p) => p.title === "Travel")!.page_id;
    const travelDoc = await library.readPage(travelId);
    const windowClaim = travelDoc.claims.find((c) =>
      c.statement.includes("window seats"),
    )!;

    await projections.deriveProjection({
      pageId: travelId,
      claimId: windowClaim.claim_id,
      targetDomain: "travel",
      jsonPath: "preferences.seating",
      idempotencyKey: "shared-proj-1",
      ownerConfirmed: true,
    });

    const parity = await migrator.verifyDualReadParity({
      v1Markdown:
        "# memory.md\n\n## Travel\n- Prefers window seats on red-eye flights.\n- Uses TSA PreCheck.\n",
      expectedScopedDomains: ["travel"],
    });
    expect(parity.qualified).toBe(true);

    const step2 = await migrator.advanceMigrationState({
      targetState: "wiki_primary_with_v1_rollback",
      expectedMigrationRevision: parity.migration_revision,
    });
    expect(step2.state).toBe("wiki_primary_with_v1_rollback");

    // Negative control: missing chat-key session recovery blocks graduation
    const coldIncomplete = await migrator.verifyColdReconstruction({
      chatSessionVerifier: async () => false,
    });
    expect(coldIncomplete.qualified).toBe(false);
    await expect(
      migrator.advanceMigrationState({
        targetState: "wiki_primary",
        expectedMigrationRevision: coldIncomplete.migration_revision,
      }),
    ).rejects.toMatchObject({ code: "WIKI_MIGRATION_RECOVERY_REQUIRED" });

    // Forget propagates across wiki, projection receipts, and key rotation
    const forgetRes = await migrator.propagateForgetAndCorrection({
      pageId: travelId,
      claimId: windowClaim.claim_id,
      idempotencyKey: "shared-forget-1",
      destroyPageKey: true,
    });
    expect(forgetRes.outcomes).toEqual({
      logical_deletion: true,
      revoked_future_access: true,
      key_destroyed: true,
      provider_operation_acknowledged: false,
      physical_erasure_under_retention: false,
    });

    // Rollback to V1 Markdown never resurrects the forgotten claim
    const rolled = await migrator.rollbackToV1Markdown({
      priorV1Markdown:
        "# memory.md\n\n## Travel\n- Prefers window seats on red-eye flights.\n- Uses TSA PreCheck.\n",
    });
    expect(rolled.state).toBe("v1_markdown_only");
    expect(rolled.v1_markdown).not.toContain("window seats");
    expect(rolled.v1_markdown).toContain("Uses TSA PreCheck.");
    const fp = await normalizeStatementFingerprint(
      "Prefers window seats on red-eye flights.",
    );
    expect(fp).toHaveLength(64);
  });

  it("runs bounded foreground maintenance with AbortSignal / lock fencing and serves SharedFilesAdapter /wiki routes", async () => {
    const { library, adapter, setUnlocked } = createSharedHarness();
    await library.registerSource(
      {
        source_id: "wsr_1111222233334444",
        kind: "chat_turn",
        locator: "chat:c1/m1",
        content_sha256: "a".repeat(64),
        observed_at: "2026-01-10T00:00:00Z",
        consent_derived: false,
      },
      "seed-src-m1",
    );
    await library.createPage({
      page_id: "wpg_2222333344445555",
      title: "Routine",
      folder: "topics",
      tldr: "Daily routine",
      status_as_of: "2026-01-10",
      body: "See [[wpg_9999999999999999|Missing]].",
      claims: [
        {
          claim_id: "wcl_1111111111111111",
          statement: "Morning standup starts at 9am",
          status: "active",
          confidence: 1,
          source_ids: ["wsr_1111222233334444"],
          observed_at: "2026-01-10",
        },
        {
          claim_id: "wcl_2222222222222222",
          statement: "morning   standup starts at 9am",
          status: "active",
          confidence: 0.9,
          source_ids: ["wsr_1111222233334444"],
          observed_at: "2026-01-11",
        },
        {
          claim_id: "wcl_3333333333333333",
          statement: "Temporary pass expires soon",
          status: "active",
          confidence: 1,
          source_ids: ["wsr_1111222233334444"],
          observed_at: "2026-01-10",
          valid_until: "2026-02-01",
        },
      ],
      links: [],
      source_ids: ["wsr_1111222233334444"],
      idempotency_key: "create-routine",
    });

    const runner = new SharedWikiMaintenanceRunner(library);
    const report = await runner.runTick({
      idempotencyKey: "shared-maint-1",
      referenceDate: "2026-06-01",
      maxPagesPerTick: 4,
    });
    expect(report.deduplicated_claim_count).toBe(1);
    expect(report.expired_claim_count).toBe(1);
    expect(report.broken_links).toEqual([
      {
        source_page_id: "wpg_2222333344445555",
        target_page_id: "wpg_9999999999999999",
      },
    ]);
    expect(report.hot_digest_chars).toBeLessThanOrEqual(WIKI_HOT_MAX_CHARS);

    // SharedFilesAdapter `/wiki/*` browser WebCrypto endpoints
    const optRes = await (
      await adapter.request("wiki/opt-in", {
        method: "POST",
        body: JSON.stringify({ enabled: true }),
      })
    ).json();
    expect(optRes.captureOptIn).toBe(true);

    const ovRes = await (await adapter.request("wiki/overview")).json();
    expect(ovRes.captureOptIn).toBe(true);
    expect(ovRes.pages).toHaveLength(1);

    // Locking vault immediately fences SharedFilesAdapter `/wiki/*` reads
    setUnlocked(false);
    await expect(adapter.request("wiki/overview")).rejects.toMatchObject({
      code: "WIKI_VAULT_LOCKED",
    });
  });

  it("bridges Shared browser chat consolidation into opted-in SharedWikiLibrary and projections", async () => {
    const { bindActiveSharedWiki, peekActiveSharedWiki } = await import(
      "@/lib/files/wiki/active-shared-wiki"
    );
    const { SharedWikiKnowledgeWriter, SharedWikiProjectionEngine } = await import(
      "@/lib/files/wiki"
    );

    const { library } = createSharedHarness();
    const release = bindActiveSharedWiki(library);
    try {
      expect(peekActiveSharedWiki()).toBe(library);
      const writer = new SharedWikiKnowledgeWriter(library);
      await writer.setCaptureOptIn(true);

      let consolidatedMirrorCount = 0;
      const onConsolidated = async ({
        messages,
      }: {
        messages: readonly {
          conversationId: string;
          id: string;
          role: "user" | "assistant";
          content: string;
          consentDerived?: boolean;
        }[];
      }) => {
        const active = peekActiveSharedWiki();
        if (!active) return;
        const res = await new SharedWikiKnowledgeWriter(active).captureEvents(
          messages.map((m) => ({
            conversationId: m.conversationId,
            eventId: m.id,
            role: m.role,
            content: m.content,
            consentDerived: m.consentDerived,
          })),
        );
        if (res.status === "saved") {
          consolidatedMirrorCount += 1;
          const proj = new SharedWikiProjectionEngine(active);
          for (const pid of res.saved_page_ids) {
            await proj.syncPageLifecycle(pid);
          }
        }
      };

      await onConsolidated({
        messages: [
          {
            conversationId: "conv_shared_1",
            id: "msg_1",
            role: "user",
            content: "I prefer window seats on evening flights.",
          },
        ],
      });
      expect(consolidatedMirrorCount).toBe(1);
      const hits = await library.search("window seats");
      expect(hits).toHaveLength(1);
      const hot = await library.readHotDigest();
      expect(hot).toContain("Working Memory");
    } finally {
      release();
    }
    expect(peekActiveSharedWiki()).toBeNull();
  });
});
