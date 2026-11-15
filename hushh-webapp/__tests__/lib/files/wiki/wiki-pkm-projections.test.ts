import { beforeEach, describe, expect, it, vi } from "vitest";

const sharedRequest = vi.hoisted(() => vi.fn());

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: sharedRequest,
  },
}));

import {
  blockedManifestPaths,
  externalizableManifestLeaves,
} from "@/lib/consent/manifest-exposure";
import {
  SharedWikiLibrary,
  SharedWikiProjectionEngine,
  WIKI_CLAIM_PROJECTION_PROFILE,
} from "@/lib/files/wiki";
import { buildPersonalKnowledgeModelStructureArtifacts } from "@/lib/personal-knowledge-model/manifest";

function createHarness(owner = "fixture-phase3-owner", vaultKey = "c".repeat(64)) {
  vi.stubGlobal("btoa", (value: string) =>
    Buffer.from(value, "binary").toString("base64"),
  );
  vi.stubGlobal("atob", (value: string) =>
    Buffer.from(value, "base64").toString("binary"),
  );

  const storage = new Map<string, { ciphertext: string; generation: string }>();
  let generation = 0;

  sharedRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = new URL(path, "https://fixture.invalid");
    const key = url.pathname;

    if (key.endsWith("/storage") && method === "POST") {
      return Response.json({ status: "accepted" });
    }
    if (key.endsWith("/storage") && method === "GET") {
      return Response.json({
        libraryId: "00000000-0000-4000-8000-000000000999",
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

  return new SharedWikiLibrary({
    owner,
    vaultKey,
    ownerToken: "fixture-owner-token",
    check: () => undefined,
  });
}

describe("SharedWikiProjectionEngine & Manifest Anti-Broadening (Phase 3 #9370)", () => {
  beforeEach(() => {
    sharedRequest.mockReset();
  });

  it("enforces explicit domain mapping, specialist disagreement detection, active-grant anti-broadening, and tombstone staleness", async () => {
    const wiki = createHarness();
    const engine = new SharedWikiProjectionEngine(wiki);

    const src = await wiki.registerSource(
      {
        source_id: "wsr_1234123412341234",
        kind: "chat_turn",
        locator: "chat:c20/m1",
        content_sha256: "f".repeat(64),
        observed_at: "2026-11-14",
        consent_derived: false,
      },
      "seed-src",
    );

    const page = await wiki.createPage({
      page_id: "wpg_1111222233334444",
      title: "Work & Banking Notes",
      folder: "career/notes",
      status_as_of: "2026-11-14",
      body: "Cited career and banking statements.",
      claims: [
        {
          claim_id: "wcl_aaaa1111aaaa1111",
          statement: "Leads distributed systems architecture.",
          status: "active",
          confidence: 0.95,
          source_ids: [src.source_id],
          observed_at: "2026-11-14",
        },
        {
          claim_id: "wcl_bbbb2222bbbb2222",
          statement: "Brokerage balance is $2,000,000.",
          status: "active",
          confidence: 0.7,
          source_ids: [src.source_id],
          observed_at: "2026-11-14",
        },
      ],
      idempotency_key: "seed-page",
    });

    // Reject implicit folder-to-attr.* conversion and forbidden domains
    await expect(
      engine.deriveProjection({
        pageId: page.page_id,
        claimId: "wcl_aaaa1111aaaa1111",
        targetDomain: null,
        jsonPath: null,
        idempotencyKey: "no-map",
      }),
    ).rejects.toMatchObject({ code: "WIKI_PROJECTION_MAPPING_REQUIRED" });

    for (const badDomain of [
      "one_memory",
      "one_wiki",
      "financial",
      "identity",
      "consent",
      "secrets",
      "career/notes",
    ]) {
      await expect(
        engine.deriveProjection({
          pageId: page.page_id,
          claimId: "wcl_aaaa1111aaaa1111",
          targetDomain: badDomain,
          jsonPath: "summary.role",
          idempotencyKey: `bad-${badDomain}`,
        }),
      ).rejects.toMatchObject({ code: "WIKI_PROJECTION_DOMAIN_FORBIDDEN" });
    }

    // Active recipient grant holds newly derived leaf in private_candidate until owner confirms
    const candidate = await engine.deriveProjection({
      pageId: page.page_id,
      claimId: "wcl_aaaa1111aaaa1111",
      targetDomain: "professional",
      jsonPath: "career.specialty",
      activeRecipientCount: 1,
      idempotencyKey: "cand-1",
    });
    expect(candidate.state).toBe("private_candidate");
    expect(candidate.exposure_eligibility).toBe(false);

    // Specialist disagreement marks conflicted without exposing specialist values
    const conflicted = await engine.deriveProjection({
      pageId: page.page_id,
      claimId: "wcl_bbbb2222bbbb2222",
      targetDomain: "lifestyle",
      jsonPath: "wealth.brokerage_balance",
      proposedValue: "$2,000,000",
      specialistSnapshot: {
        financial: { brokerage_balance: "$48,500" },
      },
      idempotencyKey: "conflict-1",
    });
    expect(conflicted.state).toBe("conflicted");
    expect(conflicted.exposure_eligibility).toBe(false);
    expect(JSON.stringify(conflicted)).not.toContain("$48,500");

    // Wire into PKM manifest builder & exposure admission: private_candidate and conflicted are NEVER externalizable!
    const { manifest: candidateManifest } =
      buildPersonalKnowledgeModelStructureArtifacts({
        domain: "professional",
        domainData: {
          career: {
            title: "Staff Engineer",
            specialty: "Leads distributed systems architecture.",
          },
          draft_notes: {
            summary: "Unconfirmed wiki note",
          },
        },
        wikiProjectionStates: {
          "career.specialty": {
            state: candidate.state,
            receipt_id: candidate.receipt_id,
          },
          "draft_notes.summary": {
            state: "private_candidate",
            receipt_id: "wpr_0000000000000001",
          },
        },
      });

    // Even if someone forged externalizable_paths to include career.specialty, externalizableManifestLeaves strips it!
    const forgedManifest = {
      ...candidateManifest,
      externalizable_paths: [
        "career.title",
        "career.specialty",
        "draft_notes.summary",
      ],
    };
    expect(externalizableManifestLeaves(forgedManifest)).toEqual([
      "career.title",
    ]);
    expect(
      blockedManifestPaths(forgedManifest, ["career.title"]),
    ).toContain("career.specialty");
    expect(
      (
        candidateManifest.summary_projection.scope_materialization as Record<
          string,
          { state: string; materialized_leaf_count: number }
        >
      ).draft_notes,
    ).toEqual({
      state: "private_candidate",
      materialized_leaf_count: 0,
    });

    // Confirming promotes to materialized; subsequent tombstone transitions to stale and rejects stale retry!
    const confirmed = await engine.confirmCandidateProjection(
      candidate.receipt_id,
      { idempotencyKey: "confirm-1" },
    );
    expect(confirmed.state).toBe("materialized");
    expect(confirmed.exposure_eligibility).toBe(true);

    await wiki.putTombstone(
      {
        tombstone_id: "wtb_abcdabcdabcdabcd",
        target_kind: "claim",
        target_id: "wcl_aaaa1111aaaa1111",
        reason_code: "retracted",
        created_at: Date.now(),
        page_id: page.page_id,
      },
      "tb-1",
    );
    const synced = await engine.syncPageLifecycle(page.page_id);
    expect(synced[0]?.state).toBe("stale");
    expect(synced[0]?.exposure_eligibility).toBe(false);

    await expect(
      wiki.putProjectionReceipt(
        {
          ...confirmed,
          page_revision: 1,
          source_revision: 1,
          state: "materialized",
          exposure_eligibility: true,
        },
        "stale-retry",
      ),
    ).rejects.toMatchObject({ code: "WIKI_PROJECTION_STALE_REVISION" });

    // Agent Lab claim payload excludes tombstoned claims
    const labPayload = await engine.buildAgentLabClaimPayload("professional");
    expect(labPayload.memory_profile).toBe(WIKI_CLAIM_PROJECTION_PROFILE);
    expect(
      labPayload.simulated_state.memories.map((m) => m.entity_id),
    ).toEqual(["wcl_bbbb2222bbbb2222"]);
  });
});

