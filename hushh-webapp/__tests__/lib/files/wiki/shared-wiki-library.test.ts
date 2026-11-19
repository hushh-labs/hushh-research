import { beforeEach, describe, expect, it, vi } from "vitest";

const sharedRequest = vi.hoisted(() => vi.fn());

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: sharedRequest,
  },
}));

import { bindFilesConnection } from "@/lib/files/connection";
import { FilesService } from "@/lib/files/service";
import { SharedWikiLibrary, WikiRefusedError } from "@/lib/files/wiki";

interface WireHarness {
  storage: Map<string, { ciphertext: string; generation: string }>;
  wireUrls: string[];
  wireBodies: string[];
  setLocked: (next: boolean) => void;
  wiki: SharedWikiLibrary;
}

function createHarness(
  owner = "fixture-wiki-owner",
  vaultKey = "a".repeat(64),
): WireHarness {
  vi.stubGlobal("btoa", (value: string) =>
    Buffer.from(value, "binary").toString("base64"),
  );
  vi.stubGlobal("atob", (value: string) =>
    Buffer.from(value, "base64").toString("binary"),
  );

  const storage = new Map<string, { ciphertext: string; generation: string }>();
  const wireUrls: string[] = [];
  const wireBodies: string[] = [];
  let generation = 0;
  let locked = false;

  sharedRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    wireUrls.push(path);
    const method = init?.method ?? "GET";
    const url = new URL(path, "https://fixture.invalid");
    const key = url.pathname;

    if (init?.body !== undefined) {
      wireBodies.push(String(init.body));
    }

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
    // /api/one/files/objects/<64hex> -> list namespace keys
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

  const wiki = new SharedWikiLibrary({
    owner,
    vaultKey,
    ownerToken: "fixture-owner-token",
    check: () => {
      if (locked) {
        throw new Error("VAULT_LOCKED");
      }
    },
  });

  return {
    storage,
    wireUrls,
    wireBodies,
    setLocked: (next: boolean) => {
      locked = next;
    },
    wiki,
  };
}

describe("SharedWikiLibrary (Phase 1 #8814 encrypted personal wiki)", () => {
  beforeEach(() => {
    sharedRequest.mockReset();
  });

  it("enforces opaque wire storage, source custody, section edits, stable identity across rename/move, backlinks, search, and key-free export", async () => {
    const { wiki, wireUrls, wireBodies } = createHarness();

    await expect(
      wiki.registerSource(
        {
          source_id: "wsr_0000000000000001",
          kind: "pkm_record",
          locator: "consent:external_grant",
          content_sha256: "1".repeat(64),
          observed_at: "2026-11-14",
          consent_derived: true,
        },
        "idem-src-refused",
      ),
    ).rejects.toMatchObject({ code: "WIKI_SOURCE_INELIGIBLE", status: 403 });

    const src = await wiki.registerSource(
      {
        source_id: "wsr_0000000000000002",
        kind: "chat_turn",
        locator: "chat:turn_42",
        content_sha256: "2".repeat(64),
        observed_at: "2026-11-14",
      },
      "idem-src-ok",
    );
    expect(src.consent_derived).toBe(false);

    const cardio = await wiki.createPage({
      page_id: "wpg_00000000000000a1",
      title: "Marathon Base Training",
      folder: "health/running",
      tldr: "Aerobic base block targeting sub-3h15 marathon.",
      status_as_of: "2026-11-14",
      body: "## Weekly Cadence\n\nRun 55 km easy Zone 2.\n\n## Recovery\n\nSleep 8 hours.",
      claims: [
        {
          claim_id: "wcl_00000000000000c1",
          statement: "Resting heart rate averages 49 bpm in November.",
          status: "active",
          confidence: 0.95,
          source_ids: [src.source_id],
          observed_at: "2026-11-14",
        },
      ],
      source_ids: [src.source_id],
      idempotency_key: "idem-create-cardio",
    });
    expect(cardio.revision).toBe(1);

    const keyBeforeMove = await wiki.exportNarrowPageKey(cardio.page_id);

    const nutrition = await wiki.createPage({
      page_id: "wpg_00000000000000b2",
      title: "Endurance Fueling Plan",
      folder: "health/nutrition",
      tldr: "65g carbs per hour on long runs.",
      status_as_of: "2026-11-14",
      body: "## Long Run Intake\n\nPairs with [[wpg_00000000000000a1#wcl_00000000000000c1|Zone 2 cadence]].",
      claims: [
        {
          claim_id: "wcl_00000000000000c2",
          statement: "Legacy 30g gel protocol caused bonking.",
          status: "superseded",
          superseded_by: "wcl_00000000000000c3",
          observed_at: "2026-09-01",
        },
        {
          claim_id: "wcl_00000000000000c3",
          statement: "Dual-source maltodextrin fructose hydrogel prevents GI distress.",
          status: "active",
          source_ids: [src.source_id],
          observed_at: "2026-11-14",
        },
      ],
      links: [
        {
          target_page_id: cardio.page_id,
          relation: "supports",
          anchor_claim_id: "wcl_00000000000000c1",
          note: "Sustains aerobic volume",
        },
      ],
      source_ids: [src.source_id],
      idempotency_key: "idem-create-nutrition",
    });
    expect(nutrition.revision).toBe(1);

    await expect(
      wiki.editSection(cardio.page_id, {
        heading: "Claims",
        content: "Not allowed",
        expected_revision: 1,
        idempotency_key: "idem-reserved-heading",
      }),
    ).rejects.toMatchObject({ code: "WIKI_SECTION_RESERVED" });

    const editedCardio = await wiki.editSection(cardio.page_id, {
      heading: "Weekly Cadence",
      content: "Run 64 km easy Zone 2 plus strides.",
      expected_revision: 1,
      idempotency_key: "idem-section-cardio",
    });
    expect(editedCardio.revision).toBe(2);
    expect(editedCardio.body).toContain("Run 64 km easy Zone 2 plus strides.");
    expect(editedCardio.body).toContain("## Recovery\n\nSleep 8 hours.");

    const rev1 = await wiki.readPage(cardio.page_id, { revision: 1 });
    expect(rev1.body).toContain("Run 55 km easy Zone 2.");

    const renamed = await wiki.renamePage(cardio.page_id, {
      title: "Spring Marathon Aerobic Block",
      expected_revision: 2,
      idempotency_key: "idem-rename-cardio",
    });
    expect(renamed.revision).toBe(3);
    const moved = await wiki.movePage(cardio.page_id, {
      folder: "athletics/marathon",
      expected_revision: 3,
      idempotency_key: "idem-move-cardio",
    });
    expect(moved.page_id).toBe("wpg_00000000000000a1");
    expect(moved.revision).toBe(4);
    expect(moved.title).toBe("Spring Marathon Aerobic Block");
    expect(moved.folder).toBe("athletics/marathon");
    expect(moved.claims[0]?.claim_id).toBe("wcl_00000000000000c1");

    const keyAfterMove = await wiki.exportNarrowPageKey(cardio.page_id);
    expect(keyAfterMove.contentKeyHex).toBe(keyBeforeMove.contentKeyHex);

    const graph = await wiki.backlinks(cardio.page_id);
    expect(graph.inbound.length).toBeGreaterThanOrEqual(1);
    expect(graph.inbound.map((item) => item.source_page_id)).toContain(
      nutrition.page_id,
    );

    const activeHits = await wiki.search("hydrogel maltodextrin");
    expect(activeHits.map((r) => r.page_id)).toEqual([nutrition.page_id]);

    const supersededHits = await wiki.search("bonking");
    expect(supersededHits).toEqual([]);

    const exported = await wiki.exportWiki();
    expect(exported.schema).toBe("hussh.personal_wiki.export.v1");
    expect(exported.pages).toHaveLength(2);
    expect(JSON.stringify(exported)).not.toContain(keyAfterMove.contentKeyHex);

    const objectPaths = wireUrls.filter((u) => u.includes("/objects/"));
    expect(objectPaths.length).toBeGreaterThan(0);
    for (const p of objectPaths) {
      expect(p).toMatch(
        /^\/api\/one\/files\/objects\/[0-9a-f]{64}(?:\/[0-9a-f]{64}|\?cursor=[0-9a-f]*)?$/,
      );
    }
    const serializedWire = `${wireUrls.join("\n")}\n${wireBodies.join("\n")}`;
    expect(serializedWire).not.toContain("Spring Marathon Aerobic Block");
    expect(serializedWire).not.toContain("athletics/marathon");
    expect(serializedWire).not.toContain("hydrogel");
    expect(serializedWire).not.toContain(keyAfterMove.contentKeyHex);
  });

  it("enforces stale expected_revision CAS and lost-ack idempotency replay", async () => {
    const { wiki } = createHarness();
    const page = await wiki.createPage({
      title: "Tax Residency Notes",
      body: "## California\n\nTrack physical presence days.",
      idempotency_key: "idem-tax-create",
    });

    const replayCreate = await wiki.createPage({
      title: "Tax Residency Notes",
      body: "## California\n\nTrack physical presence days.",
      idempotency_key: "idem-tax-create",
    });
    expect(replayCreate.page_id).toBe(page.page_id);
    expect(replayCreate.revision).toBe(1);

    const updated = await wiki.editPage(page.page_id, {
      expected_revision: 1,
      tldr: "Updated physical presence log.",
      idempotency_key: "idem-tax-edit-1",
    });
    expect(updated.revision).toBe(2);

    const replayedEdit = await wiki.editPage(page.page_id, {
      expected_revision: 1,
      tldr: "Updated physical presence log.",
      idempotency_key: "idem-tax-edit-1",
    });
    expect(replayedEdit.revision).toBe(2);
    expect(replayedEdit.content_sha256).toBe(updated.content_sha256);

    await expect(
      wiki.editPage(page.page_id, {
        expected_revision: 1,
        tldr: "Different mutation reusing key",
        idempotency_key: "idem-tax-edit-1",
      }),
    ).rejects.toMatchObject({ code: "WIKI_IDEMPOTENCY_CONFLICT" });

    await expect(
      wiki.editPage(page.page_id, {
        expected_revision: 1,
        tldr: "Stale writer",
        idempotency_key: "idem-tax-stale",
      }),
    ).rejects.toMatchObject({ code: "WIKI_REVISION_CONFLICT" });
  });

  it("prevents mixed partial synthesis visibility across staging, race abort, and post-commit recovery", async () => {
    const { wiki } = createHarness();
    const p1 = await wiki.createPage({
      page_id: "wpg_0000000000000101",
      title: "Sleep Architecture",
      tldr: "v1",
      idempotency_key: "idem-p1",
    });
    const p2 = await wiki.createPage({
      page_id: "wpg_0000000000000102",
      title: "Caffeine Cutoff",
      tldr: "v1",
      idempotency_key: "idem-p2",
    });

    await expect(
      wiki.commitSynthesisBatch({
        idempotency_key: "idem-batch-interrupt-stage",
        _failAfterStagedCount: 1,
        items: [
          { page_id: p1.page_id, expected_revision: 1, tldr: "v2-synth" },
          { page_id: p2.page_id, expected_revision: 1, tldr: "v2-synth" },
        ],
      }),
    ).rejects.toThrow("simulated_synthesis_interruption_during_staging");

    const pending = await wiki.incompleteBatches();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.complete).toBe(false);

    const readP1During = await wiki.readPage(p1.page_id);
    const readP2During = await wiki.readPage(p2.page_id);
    expect(readP1During.revision).toBe(1);
    expect(readP1During.tldr).toBe("v1");
    expect(readP1During.pending_batch_id).toBe(pending[0]?.batch_id);
    expect(readP2During.revision).toBe(1);

    await expect(
      wiki.readPage(p1.page_id, { requireSettled: true }),
    ).rejects.toMatchObject({ code: "WIKI_BATCH_INCOMPLETE" });

    const recovered = await wiki.recoverBatch(pending[0]!.batch_id);
    expect(recovered.state).toBe("finalized");
    expect(recovered.complete).toBe(true);
    expect((await wiki.readPage(p1.page_id)).tldr).toBe("v2-synth");
    expect((await wiki.readPage(p2.page_id)).tldr).toBe("v2-synth");

    // Second scenario: interrupted staging + concurrent unstaged edit -> clean abort
    await expect(
      wiki.commitSynthesisBatch({
        idempotency_key: "idem-batch-race-abort",
        _failAfterStagedCount: 1,
        items: [
          { page_id: p1.page_id, expected_revision: 2, tldr: "v3-aborted" },
          { page_id: p2.page_id, expected_revision: 2, tldr: "v3-aborted" },
        ],
      }),
    ).rejects.toThrow("simulated_synthesis_interruption_during_staging");

    const racedBatch = (await wiki.incompleteBatches())[0]!;
    await wiki.editPage(p2.page_id, {
      expected_revision: 2,
      tldr: "v3-direct-owner-edit",
      idempotency_key: "race-edit-two",
    });

    const abortedReceipt = await wiki.recoverBatch(racedBatch.batch_id);
    expect(abortedReceipt.state).toBe("aborted");
    expect(abortedReceipt.complete).toBe(false);
    expect((await wiki.readPage(p1.page_id)).revision).toBe(2);
    expect((await wiki.readPage(p1.page_id)).tldr).toBe("v2-synth");
    expect((await wiki.readPage(p2.page_id)).revision).toBe(3);
    expect((await wiki.readPage(p2.page_id)).tldr).toBe(
      "v3-direct-owner-edit",
    );

    // Third scenario: interruption immediately after commit flip -> consistent new revisions
    await expect(
      wiki.commitSynthesisBatch({
        idempotency_key: "idem-batch-post-flip",
        _failAfterCommitFlip: true,
        items: [
          { page_id: p1.page_id, expected_revision: 2, tldr: "v3-committed" },
          { page_id: p2.page_id, expected_revision: 3, tldr: "v4-committed" },
        ],
      }),
    ).rejects.toThrow("simulated_synthesis_interruption_after_commit");

    expect((await wiki.readPage(p1.page_id)).tldr).toBe("v3-committed");
    expect((await wiki.readPage(p2.page_id)).tldr).toBe("v4-committed");

    const committedPending = (await wiki.incompleteBatches())[0]!;
    const finalized = await wiki.recoverBatch(committedPending.batch_id);
    expect(finalized.state).toBe("finalized");
    expect(await wiki.incompleteBatches()).toHaveLength(0);
  });

  it("enforces narrow per-page key isolation, tamper refusal, lock fence, and cold index rebuild equivalence", async () => {
    const { wiki, storage, wireUrls, setLocked } = createHarness();
    const pageA = await wiki.createPage({
      page_id: "wpg_0000000000000201",
      title: "Blood Panel Markers",
      body: "## Lipids\n\nApoB measured at 68 mg/dL.",
      links: [{ target_page_id: "wpg_0000000000000202", relation: "related" }],
      idempotency_key: "idem-iso-a",
    });
    const pageB = await wiki.createPage({
      page_id: "wpg_0000000000000202",
      title: "Dietary Fiber Log",
      body: "## Soluble Fiber\n\nOats and psyllium daily.",
      idempotency_key: "idem-iso-b",
    });

    const narrowA = await wiki.exportNarrowPageKey(pageA.page_id);
    const narrowB = await wiki.exportNarrowPageKey(pageB.page_id);
    expect(narrowA.contentKeyHex).not.toBe(narrowB.contentKeyHex);

    const beforeReadCount = wireUrls.length;
    const openedA = await wiki.readRevisionWithKey(
      narrowA.revisionId,
      narrowA.contentKeyHex,
    );
    expect(openedA.title).toBe("Blood Panel Markers");
    const pageARevWireKey = new URL(
      wireUrls.slice(beforeReadCount).find((u) => u.includes("/objects/"))!,
      "https://fixture.invalid",
    ).pathname;

    await expect(
      wiki.readRevisionWithKey(narrowB.revisionId, narrowA.contentKeyHex),
    ).rejects.toMatchObject({ code: "WIKI_INTEGRITY_FAILURE" });

    // Cold index rebuild equivalence after deleting index objects from storage
    const beforeRebuildUrls = wireUrls.length;
    const baseline = await wiki.rebuildIndexes();
    const indexKeys = [
      ...new Set(
        wireUrls
          .slice(beforeRebuildUrls)
          .map((u) => new URL(u, "https://fixture.invalid").pathname)
          .filter((p) => p.split("/").length === 7),
      ),
    ];
    // The last two object paths touched in rebuildIndexes are backlinks & lexical indexes
    const writtenIndexKeys = indexKeys.slice(-2);
    expect(writtenIndexKeys).toHaveLength(2);
    for (const k of writtenIndexKeys) {
      storage.delete(k);
    }
    const rebuilt = await wiki.rebuildIndexes();
    expect(rebuilt).toEqual(baseline);
    expect((await wiki.search("psyllium")).map((r) => r.page_id)).toEqual([
      pageB.page_id,
    ]);
    expect(
      (await wiki.backlinks(pageB.page_id)).inbound.map(
        (i) => i.source_page_id,
      ),
    ).toEqual([pageA.page_id]);

    // Lock fence
    setLocked(true);
    await expect(wiki.readPage(pageA.page_id)).rejects.toThrow("VAULT_LOCKED");
    await expect(wiki.exportWiki()).rejects.toThrow("VAULT_LOCKED");
    setLocked(false);

    // Ciphertext tamper refusal on pageA's revision object
    const entry = storage.get(pageARevWireKey)!;
    expect(entry).toBeDefined();
    const flipped =
      entry.ciphertext.slice(0, -4) +
      (entry.ciphertext.endsWith("AAAA") ? "BBBB" : "AAAA");
    storage.set(pageARevWireKey, {
      ciphertext: flipped,
      generation: entry.generation,
    });
    await expect(wiki.readPage(pageA.page_id)).rejects.toBeInstanceOf(
      WikiRefusedError,
    );
    await expect(wiki.readPage(pageA.page_id)).rejects.toMatchObject({
      code: "WIKI_INTEGRITY_FAILURE",
    });
  });

  it("attaches SharedWikiLibrary cleanly to FilesService.sharedWiki() and fences on release or pod mode", async () => {
    createHarness();
    expect(() => FilesService.sharedWiki()).toThrow("FILES_UNLOCK_REQUIRED");

    const releaseShared = bindFilesConnection(
      {
        owner: "fixture-bound-owner",
        vaultKey: "b".repeat(64),
        ownerToken: "fixture-bound-token",
        check: () => undefined,
      },
      true,
    );
    const boundWiki = FilesService.sharedWiki();
    const created = await boundWiki.createPage({
      title: "Bound Runtime Attach Check",
      idempotency_key: "idem-bound-runtime",
    });
    expect(created.revision).toBe(1);
    releaseShared();
    expect(() => FilesService.sharedWiki()).toThrow("FILES_UNLOCK_REQUIRED");

    const releasePod = bindFilesConnection(
      {
        owner: "fixture-pod-owner",
        vaultKey: "c".repeat(64),
        ownerToken: "fixture-pod-token",
        check: () => undefined,
      },
      false,
    );
    expect(() => FilesService.sharedWiki()).toThrow(WikiRefusedError);
    releasePod();
  });
});
