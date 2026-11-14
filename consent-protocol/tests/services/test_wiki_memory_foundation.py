"""Phase 1 (#8814) conformance, recovery, and custody boundary tests for WikiLibrary."""

from __future__ import annotations

import json

import pytest

from hushh_mcp.services.pod_files.storage import FilesLocalStore
from hushh_mcp.services.wiki_memory import (
    WikiLibrary,
    WikiRefused,
    open_revision_with_page_key,
)


async def _allowed() -> None:
    return None


@pytest.fixture
def wiki(tmp_path) -> WikiLibrary:
    return WikiLibrary(
        owner="owner-alpha",
        key=b"W" * 32,
        store=FilesLocalStore(str(tmp_path)),
        check=_allowed,
        account_generation=3,
        library_id="lib-001",
    )


@pytest.mark.asyncio
async def test_wiki_lifecycle_revisions_sections_links_search_and_export(
    wiki: WikiLibrary, tmp_path
) -> None:
    source = await wiki.register_source(
        {
            "source_id": "wsr_0123456789abcdef",
            "kind": "chat_turn",
            "locator": "turn:conv_01:msg_02",
            "content_sha256": "a" * 64,
            "observed_at": "2026-11-14T10:00:00Z",
            "consent_derived": False,
        },
        idempotency_key="register-src-1",
    )
    assert await wiki.get_source(source["source_id"]) == source

    # Consent-derived invocations must be refused as durable wiki provenance.
    with pytest.raises(WikiRefused, match="WIKI_SOURCE_INELIGIBLE"):
        await wiki.register_source(
            {
                "source_id": "wsr_fedcba9876543210",
                "kind": "chat_turn",
                "locator": "turn:grant_01:msg_01",
                "content_sha256": "b" * 64,
                "observed_at": "2026-11-14T10:01:00Z",
                "consent_derived": True,
            },
            idempotency_key="register-src-ineligible",
        )

    person_page = await wiki.create_page(
        title="Dr. Maya Lin",
        folder="people",
        tldr="Primary cardiologist at Stanford Clinic.",
        status_as_of="2026-11-14",
        body="## Appointments\n\nAnnual cardiology checkup scheduled in Palo Alto.",
        claims=[
            {
                "claim_id": "wcl_1111222233334444",
                "statement": "Morning cardiology appointments before 10am are preferred.",
                "status": "active",
                "confidence": 0.95,
                "source_ids": ["wsr_0123456789abcdef"],
                "observed_at": "2026-11-14",
            }
        ],
        idempotency_key="create-person-maya",
    )
    person_id = person_page["page_id"]
    assert person_id.startswith("wpg_")
    assert person_page["revision"] == 1

    project_page = await wiki.create_page(
        title="2026 Preventative Health Plan",
        folder="projects/health",
        tldr="Annual lipid panel and exercise cadence.",
        status_as_of="2026-11-14",
        body=f"## Care Team\n\nCoordinates follow-up with [[{person_id}#wcl_1111222233334444|Dr. Lin]].",
        links=[
            {
                "target_page_id": person_id,
                "relation": "supports",
                "anchor_claim_id": "wcl_1111222233334444",
                "note": "Primary care specialist",
            }
        ],
        source_ids=["wsr_0123456789abcdef"],
        idempotency_key="create-project-health",
    )
    project_id = project_page["page_id"]

    # Storage paths and raw ciphertexts never leak human titles, slugs, or content keys.
    bin_files = list(tmp_path.rglob("*.bin"))
    assert bin_files
    for blob_path in bin_files:
        assert len(blob_path.stem) == 64
        raw = blob_path.read_bytes()
        assert b"Maya Lin" not in raw
        assert b"Preventative Health" not in raw
        assert b"content_key_b64" not in raw

    # Section edit preserves untouched sections and writes immutable revision 2.
    section_edited = await wiki.edit_section(
        person_id,
        heading="Appointments",
        content="Moved annual checkup to Tuesday 9:00am in Palo Alto.",
        expected_revision=1,
        idempotency_key="section-edit-person-1",
    )
    assert section_edited["revision"] == 2
    assert "Tuesday 9:00am" in section_edited["body"]

    # Reserved generated sections cannot be overwritten via body section patch.
    with pytest.raises(WikiRefused, match="WIKI_SECTION_RESERVED"):
        await wiki.edit_section(
            person_id,
            heading="Claims",
            content="forged claims",
            expected_revision=2,
            idempotency_key="reserved-section-attempt",
        )

    # Rename and move preserve page_id, claim_id, content_key, and backlink edges.
    key_before, _ = await wiki.export_narrow_page_key(person_id)
    renamed = await wiki.rename_page(
        person_id,
        title="Maya Lin, MD",
        expected_revision=2,
        idempotency_key="rename-person-2",
    )
    assert renamed["revision"] == 3
    moved = await wiki.move_page(
        person_id,
        folder="people/physicians",
        expected_revision=3,
        idempotency_key="move-person-3",
    )
    key_after, _ = await wiki.export_narrow_page_key(person_id)
    assert moved["page_id"] == person_id
    assert moved["revision"] == 4
    assert moved["title"] == "Maya Lin, MD"
    assert moved["folder"] == "people/physicians"
    assert moved["claims"][0]["claim_id"] == "wcl_1111222233334444"
    assert key_after == key_before

    # Historical revision 1 remains exact and readable.
    rev1 = await wiki.read_page(person_id, revision=1)
    assert rev1["title"] == "Dr. Maya Lin"
    assert rev1["folder"] == "people"
    assert "Annual cardiology checkup" in rev1["body"]

    # Bidirectional backlinks reflect the renamed/moved live target without relinking.
    inbound_person = await wiki.backlinks(person_id)
    assert any(
        edge["source_page_id"] == project_id and edge["relation"] == "supports"
        for edge in inbound_person["inbound"]
    )
    outbound_project = await wiki.backlinks(project_id)
    assert any(
        edge["target_page_id"] == person_id
        and edge["target_title"] == "Maya Lin, MD"
        and edge["target_folder"] == "people/physicians"
        for edge in outbound_project["outbound"]
    )

    # BM25 lexical search finds the renamed/updated page and suppresses superseded claims.
    hits = await wiki.search("cardiology morning appointments")
    assert hits and hits[0]["page_id"] == person_id
    assert hits[0]["source_ids"] == ["wsr_0123456789abcdef"]

    superseded_update = await wiki.edit_page(
        person_id,
        expected_revision=4,
        idempotency_key="supersede-claim-4",
        claims=[
            {
                "claim_id": "wcl_1111222233334444",
                "statement": "Morning cardiology appointments before 10am are preferred.",
                "status": "superseded",
                "superseded_by": "wcl_5555666677778888",
                "confidence": 0.95,
                "source_ids": ["wsr_0123456789abcdef"],
                "observed_at": "2026-11-14",
                "valid_until": "2026-11-15",
            },
            {
                "claim_id": "wcl_5555666677778888",
                "statement": "Afternoon telehealth consultations after 2pm are preferred.",
                "status": "active",
                "confidence": 0.98,
                "source_ids": ["wsr_0123456789abcdef"],
                "observed_at": "2026-11-15",
            },
        ],
    )
    assert superseded_update["revision"] == 5
    telehealth_hits = await wiki.search("afternoon telehealth consultations")
    assert telehealth_hits and telehealth_hits[0]["page_id"] == person_id
    stale_hits = await wiki.search("before 10am")
    assert stale_hits == []

    # Export bundle is deterministic and never includes raw content keys.
    exported_first = await wiki.export_wiki()
    exported_second = await wiki.export_wiki()
    assert exported_first == exported_second
    serialized_export = json.dumps(exported_first)
    assert "content_key" not in serialized_export
    assert exported_first["owner"] == "owner-alpha"
    assert len(exported_first["pages"]) == 2


@pytest.mark.asyncio
async def test_stale_revision_conflict_and_lost_ack_idempotency(wiki: WikiLibrary) -> None:
    created = await wiki.create_page(
        title="Travel Preferences",
        folder="topics",
        body="## Seating\n\nPrefers aisle seats on long-haul flights.",
        idempotency_key="travel-create-1",
    )
    # Lost-ack retry of create_page returns exact revision 1 without conflict.
    replayed_create = await wiki.create_page(
        title="Travel Preferences",
        folder="topics",
        body="## Seating\n\nPrefers aisle seats on long-haul flights.",
        idempotency_key="travel-create-1",
    )
    assert replayed_create == created

    # Reusing create idempotency_key with altered payload fails closed.
    with pytest.raises(WikiRefused, match="WIKI_IDEMPOTENCY_CONFLICT"):
        await wiki.create_page(
            title="Different Title",
            folder="topics",
            body="## Seating\n\nWindow seats.",
            idempotency_key="travel-create-1",
        )

    # Writer A advances revision 1 -> 2.
    rev2 = await wiki.edit_section(
        created["page_id"],
        heading="Seating",
        content="Prefers bulkhead aisle seats on flights over 4 hours.",
        expected_revision=1,
        idempotency_key="writer-a-rev2",
    )
    assert rev2["revision"] == 2

    # Lost-ack retry of edit_section with same idempotency_key returns rev 2 idempotently.
    replayed_rev2 = await wiki.edit_section(
        created["page_id"],
        heading="Seating",
        content="Prefers bulkhead aisle seats on flights over 4 hours.",
        expected_revision=1,
        idempotency_key="writer-a-rev2",
    )
    assert replayed_rev2 == rev2

    # Same idempotency_key with mutated content fails closed.
    with pytest.raises(WikiRefused, match="WIKI_IDEMPOTENCY_CONFLICT"):
        await wiki.edit_section(
            created["page_id"],
            heading="Seating",
            content="Changed payload under same idempotency key.",
            expected_revision=1,
            idempotency_key="writer-a-rev2",
        )

    # Stale Writer B attempting edit against expected_revision=1 fails closed without data loss.
    with pytest.raises(WikiRefused, match="WIKI_REVISION_CONFLICT"):
        await wiki.edit_page(
            created["page_id"],
            expected_revision=1,
            idempotency_key="writer-b-stale",
            body="## Seating\n\nStale overwrite attempt.",
        )
    live = await wiki.read_page(created["page_id"])
    assert live["revision"] == 2
    assert "bulkhead aisle" in live["body"]


@pytest.mark.asyncio
async def test_interrupted_multipage_synthesis_never_exposes_mixed_state_and_recovers(
    wiki: WikiLibrary,
) -> None:
    anchor = await wiki.create_page(
        title="Q4 Nutrition Notes",
        folder="topics",
        body="Initial baseline notes.",
        idempotency_key="batch-anchor-create",
    )
    second = await wiki.create_page(
        title="Training Log",
        folder="topics",
        body="Initial training cadence.",
        idempotency_key="batch-second-create",
    )

    batch_items = [
        {
            "page_id": anchor["page_id"],
            "expected_revision": 1,
            "body": "Synthesized nutrition update linked to training.",
            "links": [{"target_page_id": second["page_id"], "relation": "related"}],
        },
        {
            "page_id": second["page_id"],
            "expected_revision": 1,
            "body": "Synthesized training cadence update.",
        },
        {
            "expected_revision": 0,
            "title": "Recovery Summary",
            "folder": "topics",
            "body": "Brand-new synthesized summary page.",
        },
    ]

    with pytest.raises(RuntimeError, match="simulated_synthesis_interruption_during_staging"):
        await wiki.commit_synthesis_batch(
            items=batch_items,
            idempotency_key="synth-batch-001",
            _fail_after_staged_count=1,
        )

    incomplete = await wiki.incomplete_batches()
    assert len(incomplete) == 1
    batch_id = incomplete[0]["batch_id"]
    assert incomplete[0]["complete"] is False
    assert incomplete[0]["state"] == "committing"

    # Before recovery: NO mixed partial synthesis is presented as committed!
    read_anchor = await wiki.read_page(anchor["page_id"])
    read_second = await wiki.read_page(second["page_id"])
    assert read_anchor["revision"] == 1
    assert read_anchor["body"] == "Initial baseline notes."
    assert read_anchor["pending_batch_id"] == batch_id
    assert read_second["revision"] == 1
    assert read_second["body"] == "Initial training cadence."

    with pytest.raises(WikiRefused, match="WIKI_BATCH_INCOMPLETE"):
        await wiki.read_page(anchor["page_id"], require_settled=True)

    new_page_id = incomplete[0]["pages"][2]["page_id"]
    with pytest.raises(WikiRefused, match="WIKI_NOT_FOUND"):
        await wiki.read_page(new_page_id)

    # Recovery deterministically finishes staging, commits, and updates all 3 pages together.
    recovered = await wiki.recover_batch(batch_id)
    assert recovered["complete"] is True
    assert recovered["state"] == "finalized"
    assert await wiki.incomplete_batches() == []

    assert (await wiki.read_page(anchor["page_id"]))["revision"] == 2
    assert (await wiki.read_page(second["page_id"]))["revision"] == 2
    created_third = await wiki.read_page(new_page_id)
    assert created_third["revision"] == 1
    assert created_third["title"] == "Recovery Summary"

    # Retrying the same synthesis batch idempotency_key returns finalized receipt idempotently.
    replayed_batch = await wiki.commit_synthesis_batch(
        items=batch_items,
        idempotency_key="synth-batch-001",
    )
    assert replayed_batch == recovered


@pytest.mark.asyncio
async def test_interrupted_synthesis_aborts_cleanly_if_unstaged_page_raced(
    wiki: WikiLibrary,
) -> None:
    p1 = await wiki.create_page(title="Page One", body="v1", idempotency_key="race-p1")
    p2 = await wiki.create_page(title="Page Two", body="v1", idempotency_key="race-p2")

    with pytest.raises(RuntimeError, match="simulated_synthesis_interruption_during_staging"):
        await wiki.commit_synthesis_batch(
            items=[
                {"page_id": p1["page_id"], "expected_revision": 1, "body": "batch-v2"},
                {"page_id": p2["page_id"], "expected_revision": 1, "body": "batch-v2"},
            ],
            idempotency_key="race-batch",
            _fail_after_staged_count=1,
        )

    batch_id = (await wiki.incomplete_batches())[0]["batch_id"]
    # Concurrent single-page edit wins on unstaged p2 before batch recovery runs.
    await wiki.edit_page(
        p2["page_id"],
        expected_revision=1,
        idempotency_key="concurrent-p2-edit",
        body="concurrent-winner-v2",
    )

    aborted = await wiki.recover_batch(batch_id)
    assert aborted["state"] == "aborted"
    assert aborted["complete"] is False
    assert (await wiki.read_page(p1["page_id"], require_settled=True))["body"] == "v1"
    assert (await wiki.read_page(p2["page_id"], require_settled=True))["body"] == (
        "concurrent-winner-v2"
    )


@pytest.mark.asyncio
async def test_interruption_after_batch_commit_flip_serves_consistent_new_revisions(
    wiki: WikiLibrary,
) -> None:
    left = await wiki.create_page(title="Left Page", body="left-v1", idempotency_key="flip-left")
    right = await wiki.create_page(
        title="Right Page", body="right-v1", idempotency_key="flip-right"
    )

    with pytest.raises(RuntimeError, match="simulated_synthesis_interruption_after_commit"):
        await wiki.commit_synthesis_batch(
            items=[
                {"page_id": left["page_id"], "expected_revision": 1, "body": "left-v2"},
                {"page_id": right["page_id"], "expected_revision": 1, "body": "right-v2"},
            ],
            idempotency_key="flip-batch",
            _fail_after_commit_flip=True,
        )

    # Even before head cleanup runs, the committed batch marker exposes both new revisions atomically.
    assert (await wiki.read_page(left["page_id"], require_settled=True))["body"] == "left-v2"
    assert (await wiki.read_page(right["page_id"], require_settled=True))["body"] == "right-v2"

    pending = await wiki.incomplete_batches()
    assert len(pending) == 1 and pending[0]["state"] == "committed"
    finalized = await wiki.recover_batch(pending[0]["batch_id"])
    assert finalized["state"] == "finalized"
    assert await wiki.incomplete_batches() == []


@pytest.mark.asyncio
async def test_custody_isolation_tamper_refusal_fence_and_cold_index_rebuild(
    wiki: WikiLibrary, tmp_path
) -> None:
    page_a = await wiki.create_page(
        title="Tax Filing Notes",
        folder="topics",
        tldr="CPA contact and quarterly estimate schedule.",
        body="Quarterly estimated tax reminders.",
        idempotency_key="custody-page-a",
    )
    page_b = await wiki.create_page(
        title="Passport Renewal",
        folder="topics",
        tldr="Renewal timeline.",
        body=f"Linked reference to [[{page_a['page_id']}]].",
        idempotency_key="custody-page-b",
    )

    # 1. Per-page content_key narrow isolation + negative control:
    key_a, rev_path_a = await wiki.export_narrow_page_key(page_a["page_id"])
    _, rev_path_b = await wiki.export_narrow_page_key(page_b["page_id"])
    raw_a, _ = await wiki.store.get_with_generation(rev_path_a)
    raw_b, _ = await wiki.store.get_with_generation(rev_path_b)
    head_raw_a, _ = await wiki.store.get_with_generation(wiki._head_path(page_a["page_id"]))

    opened_a = open_revision_with_page_key(
        raw_a,
        page_content_key=key_a,
        owner="owner-alpha",
        account_generation=3,
        library_id="lib-001",
        path=rev_path_a,
    )
    assert opened_a.title == "Tax Filing Notes"

    # Negative controls: page_a's content_key CANNOT open page_b's revision OR page_a's head!
    with pytest.raises(WikiRefused, match="WIKI_INTEGRITY_FAILURE"):
        open_revision_with_page_key(
            raw_b,
            page_content_key=key_a,
            owner="owner-alpha",
            account_generation=3,
            library_id="lib-001",
            path=rev_path_b,
        )
    with pytest.raises(WikiRefused, match="WIKI_INTEGRITY_FAILURE"):
        open_revision_with_page_key(
            head_raw_a,
            page_content_key=key_a,
            owner="owner-alpha",
            account_generation=3,
            library_id="lib-001",
            path=wiki._head_path(page_a["page_id"]),
        )

    # 2. Foreign owner, retired account_generation, and wrong library_id fail closed:
    foreign_owner = WikiLibrary(
        owner="owner-bravo",
        key=b"W" * 32,
        store=wiki.store,
        check=_allowed,
        account_generation=3,
        library_id="lib-001",
    )
    retired_gen = WikiLibrary(
        owner="owner-alpha",
        key=b"W" * 32,
        store=wiki.store,
        check=_allowed,
        account_generation=4,
        library_id="lib-001",
    )
    for unauthorized in (foreign_owner, retired_gen):
        with pytest.raises(WikiRefused, match="WIKI_NOT_FOUND"):
            await unauthorized.read_page(page_a["page_id"])
        with pytest.raises(WikiRefused, match="WIKI_INTEGRITY_FAILURE"):
            unauthorized._open(rev_path_a, raw_a, key=key_a)

    # 3. Cold rebuild_indexes() produces identical digests, backlinks, and search results:
    search_before = await wiki.search("quarterly estimated tax")
    backlinks_before = await wiki.backlinks(page_a["page_id"])
    assert await wiki.store.delete(wiki._index_path("backlinks")) is True
    assert await wiki.store.delete(wiki._index_path("lexical")) is True
    rebuilt = await wiki.rebuild_indexes()
    rebuilt_again = await wiki.rebuild_indexes()
    assert rebuilt == rebuilt_again
    assert rebuilt["page_count"] == 2
    assert await wiki.search("quarterly estimated tax") == search_before
    assert await wiki.backlinks(page_a["page_id"]) == backlinks_before

    # 4. Ciphertext tamper fails closed with WIKI_INTEGRITY_FAILURE:
    rev_file_a = tmp_path / rev_path_a
    original_bytes = rev_file_a.read_bytes()
    rev_file_a.write_bytes(original_bytes[:-1] + bytes([original_bytes[-1] ^ 0x01]))
    with pytest.raises(WikiRefused, match="WIKI_INTEGRITY_FAILURE"):
        await wiki.read_page(page_a["page_id"])
    rev_file_a.write_bytes(original_bytes)

    # 5. Revoked owner fence refuses search, backlinks, read, and export even with warm indexes:
    async def _fenced() -> None:
        raise WikiRefused("WIKI_OWNER_FENCED", 403)

    wiki.check = _fenced
    for action in (
        lambda: wiki.read_page(page_a["page_id"]),
        lambda: wiki.search("quarterly"),
        lambda: wiki.backlinks(page_a["page_id"]),
        lambda: wiki.export_wiki(),
    ):
        with pytest.raises(WikiRefused, match="WIKI_OWNER_FENCED"):
            await action()


@pytest.mark.asyncio
async def test_pod_runtime_wiki_operation_attaches_under_single_worker_admission(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from hushh_mcp.services import byoc_key_custody
    from hushh_mcp.services.pod_files import runtime as pod_runtime
    from hushh_mcp.services.pod_files.library import FilesLibrary, FilesRefused

    store = FilesLocalStore(tmp_path)
    verified_refs: list[str] = []

    async def _verify_bucket(ref: str) -> None:
        verified_refs.append(ref)

    store.verify_bucket = _verify_bucket  # type: ignore[attr-defined]
    raw_key = b"\x55" * 32

    async def _allow() -> None:
        return None

    files_lib = FilesLibrary(owner="owner_pod_runtime", key=raw_key, store=store, check=_allow)
    monkeypatch.setenv("POD_FILES_ENABLED", "1")
    monkeypatch.setenv("POD_ACCOUNT_GENERATION", "2")
    monkeypatch.setenv("POD_WIKI_LIBRARY_ID", "pod-lib-02")
    monkeypatch.setenv(
        byoc_key_custody.KMS_KEY_ENV, "projects/p/locations/l/keyRings/r/cryptoKeys/k"
    )
    monkeypatch.setattr(pod_runtime, "_library", files_lib)
    monkeypatch.setattr(pod_runtime, "_wiki_library", None)
    monkeypatch.setattr(pod_runtime, "_draining", False)
    monkeypatch.setattr(byoc_key_custody, "resolve_pod_log_key", lambda: raw_key)

    # Without manage capability in files_access, mutation is refused with 403.
    with pytest.raises(FilesRefused, match="FILES_AUTHORITY_REQUIRED"):
        async with pod_runtime.wiki_operation(mutation=True):
            pass

    with pod_runtime.files_access(_allow, manage=_allow):
        async with pod_runtime.wiki_operation(mutation=True) as wiki:
            created = await wiki.create_page(
                title="Pod Runtime Wiki Attach",
                body="## Status\n\nPod single-worker fenced.",
                idempotency_key="idem-pod-runtime-1",
            )
            assert created["revision"] == 1

        async with pod_runtime.wiki_operation(mutation=False) as wiki_ro:
            fetched = await wiki_ro.read_page(created["page_id"])
            assert fetched["title"] == "Pod Runtime Wiki Attach"

    assert len(verified_refs) == 3
    assert all(ref.endswith("/cryptoKeys/k") for ref in verified_refs)
