# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Phase 4 per-owner wiki migration, 4-plane cold recovery, 5-outcome Forget, rollback, and lint."""

from __future__ import annotations

from typing import Any

import pytest

from hushh_mcp.services.pod_object_version import ABSENT, ObjectVersion
from hushh_mcp.services.wiki_memory import (
    WIKI_HOT_MAX_CHARS,
    WikiKnowledgeWriter,
    WikiLibrary,
    WikiMaintenanceRunner,
    WikiOwnerMigrator,
    WikiProjectionEngine,
    WikiRefused,
    WikiTombstone,
    normalize_statement_fingerprint,
)


class _CasStore:
    def __init__(self, *, supports_delete: bool = True) -> None:
        self.objects: dict[str, tuple[bytes, int]] = {}
        self._seq = 1
        if not supports_delete:
            self.delete = None  # type: ignore[assignment]

    async def verify_bucket(self, _ref: str) -> None:
        return None

    async def get_with_generation(self, path: str) -> tuple[bytes | None, ObjectVersion]:
        item = self.objects.get(path)
        if item is None:
            return None, ABSENT
        return item[0], ObjectVersion(str(item[1]))

    async def put_if_generation(
        self, path: str, payload: bytes, expected: ObjectVersion
    ) -> ObjectVersion | None:
        cur = self.objects.get(path)
        if expected == ABSENT:
            if cur is not None:
                return None
        elif cur is None or str(cur[1]) != str(expected):
            return None
        gen = self._seq
        self._seq += 1
        self.objects[path] = (bytes(payload), gen)
        return ObjectVersion(str(gen))

    async def list_page(
        self, prefix: str, cursor: str = "", limit: int = 100
    ) -> tuple[list[str], str]:
        clean = prefix.rstrip("/") + "/"
        keys = sorted(k for k in self.objects if k.startswith(clean))
        start = int(cursor) if cursor.isdigit() else 0
        sliced = keys[start : start + limit]
        nxt = str(start + limit) if (start + limit) < len(keys) else ""
        return sliced, nxt

    async def delete(self, path: str) -> bool:
        return self.objects.pop(path, None) is not None


class _ProviderMemoryDouble:
    def __init__(self, *, acknowledged: bool) -> None:
        self.acknowledged = acknowledged
        self.recorded: list[tuple[str, str]] = []

    async def record_wiki_tombstone(
        self,
        *,
        tombstone_id: str,
        target_kind: str,
        target_id: str,
        reason_code: str = "owner_request",
        revoked_text: str = "",
    ) -> int:
        _ = (target_kind, reason_code, revoked_text)
        self.recorded.append((tombstone_id, target_id))
        return 1

    async def status(self) -> dict[str, Any]:
        return {
            "provider": {
                "rebuildSemantics": "suppressed_stale" if self.acknowledged else "unrebuilt"
            }
        }


async def _noop_check() -> None:
    return None


@pytest.mark.asyncio
async def test_phase4_migration_state_machine_four_plane_recovery_and_non_resurrection() -> None:
    store = _CasStore(supports_delete=True)
    lib = WikiLibrary(
        owner="usr_phase4_alpha",
        key=b"\x11" * 32,
        store=store,
        check=_noop_check,
        account_generation=1,
    )
    migrator = WikiOwnerMigrator(lib)

    initial = await migrator.get_migration_status()
    assert initial["state"] == "v1_markdown_only"

    # Pre-seed a tombstoned legacy statement so migration must NEVER resurrect it
    retired_stmt = "Old retired airline number 998811."
    await lib.put_tombstone(
        WikiTombstone(
            tombstone_id="wtb_0000000000000099",
            target_kind="claim",
            target_id="wcl_0000000000000099",
            reason_code="owner_request",
            created_at=1_760_000_000_000,
        ),
        idempotency_key="seed_tb_99",
    )
    await migrator._record_tombstoned_fingerprint(normalize_statement_fingerprint(retired_stmt))

    v1_doc = (
        "# memory.md\n\n"
        "## Travel\n"
        "- Prefers window seats on red-eye flights.\n"
        f"- {retired_stmt}\n"
        "- Bearer sk-live-secret1234567890abcdef should never persist raw.\n"
    )
    compiled = await migrator.compile_legacy_sources(
        v1_markdown=v1_doc,
        pod_schema2_facts=[{"seq": 4, "text": "Works in Pacific Time."}],
        idempotency_key="mig_compile_1",
        specialist_snapshot={"financial": {"net_worth": "250000"}},
    )
    assert compiled["state"] == "dual_read_shadow_compile"
    assert compiled["skipped_tombstoned_count"] == 1
    assert compiled["compiled_claim_count"] == 3

    # Raw ciphertext must never contain raw secret or plaintext statements
    blob_bytes = b"".join(data for data, _ in store.objects.values())
    assert b"sk-live-secret1234567890abcdef" not in blob_bytes
    assert b"window seats" not in blob_bytes

    # Negative control: cannot jump to wiki_primary_with_v1_rollback before parity passes
    with pytest.raises(WikiRefused) as pre_err:
        await migrator.advance_migration_state(
            "wiki_primary_with_v1_rollback",
            expected_migration_revision=compiled["migration_revision"],
        )
    assert pre_err.value.code == "WIKI_MIGRATION_PARITY_REQUIRED"

    # Materialize travel projection so scoped-domain parity also verifies
    pages = await lib.list_pages()
    travel_page = await lib.read_page(next(p["page_id"] for p in pages if p["title"] == "Travel"))
    await WikiProjectionEngine(lib).derive_projection(
        page_id=travel_page["page_id"],
        claim_id=travel_page["claims"][0]["claim_id"],
        target_domain="travel",
        json_path="preferences.seating",
        idempotency_key="proj_travel_1",
        owner_confirmed=True,
    )

    parity = await migrator.verify_dual_read_parity(
        v1_markdown="# memory.md\n\n## Travel\n- Prefers window seats on red-eye flights.\n",
        expected_scoped_domains=["travel"],
    )
    assert parity["qualified"] is True
    assert parity["unexpected_resurrection_count"] == 0

    step2 = await migrator.advance_migration_state(
        "wiki_primary_with_v1_rollback",
        expected_migration_revision=parity["migration_revision"],
    )
    assert step2["state"] == "wiki_primary_with_v1_rollback"

    # Negative control for 4-plane cold recovery: commit-log head pass WITHOUT chat-key session
    # recovery (`chat_session_verifier=False`) MUST refuse qualification!
    async def _ok() -> bool:
        return True

    async def _fail() -> bool:
        return False

    cold_incomplete = await migrator.verify_cold_reconstruction(
        commit_log_verifier=_ok,
        chat_session_verifier=_fail,
    )
    assert cold_incomplete["commit_log_head_verified"] is True
    assert cold_incomplete["wiki_chunks_readable"] is True
    assert cold_incomplete["nested_memory_ciphertext_readable"] is True
    assert cold_incomplete["chat_key_session_recovery_verified"] is False
    assert cold_incomplete["qualified"] is False

    with pytest.raises(WikiRefused) as rec_err:
        await migrator.advance_migration_state(
            "wiki_primary",
            expected_migration_revision=cold_incomplete["migration_revision"],
        )
    assert rec_err.value.code == "WIKI_MIGRATION_RECOVERY_REQUIRED"

    # All 4 planes verified -> qualifies graduation to `wiki_primary`
    cold_ok = await migrator.verify_cold_reconstruction(
        commit_log_verifier=_ok,
        chat_session_verifier=_ok,
    )
    assert cold_ok["qualified"] is True
    graduated = await migrator.advance_migration_state(
        "wiki_primary",
        expected_migration_revision=cold_ok["migration_revision"],
    )
    assert graduated["state"] == "wiki_primary"


@pytest.mark.asyncio
async def test_phase4_five_distinct_forget_outcomes_and_rollback_without_resurrection() -> None:
    # Case A: Shared-style store (no physical delete, no provider MemoryBank)
    shared_store = _CasStore(supports_delete=False)
    shared_lib = WikiLibrary(
        owner="usr_phase4_shared",
        key=b"\x22" * 32,
        store=shared_store,
        check=_noop_check,
    )
    shared_writer = WikiKnowledgeWriter(
        shared_lib, pod_memory_service=_ProviderMemoryDouble(acknowledged=False)
    )
    shared_mig = WikiOwnerMigrator(shared_lib, writer=shared_writer)
    await shared_mig.compile_legacy_sources(
        v1_markdown="# memory.md\n\n## Food\n- Drinks oat flat whites.\n- Avoids peanuts.\n",
        idempotency_key="shared_compile",
    )
    food_pid = (await shared_lib.list_pages())[0]["page_id"]
    food_doc = await shared_lib.read_page(food_pid)
    oat_claim_id = next(c["claim_id"] for c in food_doc["claims"] if "oat" in c["statement"])
    await WikiProjectionEngine(shared_lib).derive_projection(
        page_id=food_pid,
        claim_id=oat_claim_id,
        target_domain="food",
        json_path="preferences.coffee",
        idempotency_key="food_proj_1",
        owner_confirmed=True,
    )

    res_shared = await shared_mig.propagate_forget_and_correction(
        page_id=food_pid,
        claim_id=oat_claim_id,
        idempotency_key="forget_shared_1",
        destroy_page_key=True,
        delete_retired_blobs=True,
        v1_markdown_snapshot="# memory.md\n\n## Food\n- Drinks oat flat whites.\n- Avoids peanuts.\n",
        stm_entries=["User drinks oat flat whites", "User avoids peanuts"],
    )
    assert res_shared["outcomes"] == {
        "logical_deletion": True,
        "revoked_future_access": True,
        "key_destroyed": True,
        "provider_operation_acknowledged": False,
        "physical_erasure_under_retention": False,
    }
    assert "oat flat whites" not in (res_shared["scrubbed_v1_markdown"] or "")
    assert res_shared["scrubbed_stm_entries"] == ["User avoids peanuts"]

    # Rollback to V1 Markdown must NEVER resurrect the forgotten oat claim
    rolled = await shared_mig.rollback_to_v1_markdown(
        prior_v1_markdown="# memory.md\n\n## Food\n- Drinks oat flat whites.\n- Avoids peanuts.\n"
    )
    assert rolled["state"] == "v1_markdown_only"
    assert "oat flat whites" not in rolled["v1_markdown"]
    assert "Avoids peanuts." in rolled["v1_markdown"]

    # Case B: GCP Pod with physical blob delete + provider MemoryBank acknowledgement
    pod_store = _CasStore(supports_delete=True)
    pod_lib = WikiLibrary(
        owner="usr_phase4_pod",
        key=b"\x33" * 32,
        store=pod_store,
        check=_noop_check,
    )
    pod_writer = WikiKnowledgeWriter(
        pod_lib, pod_memory_service=_ProviderMemoryDouble(acknowledged=True)
    )
    pod_mig = WikiOwnerMigrator(pod_lib, writer=pod_writer)
    await pod_mig.compile_legacy_sources(
        v1_markdown="# memory.md\n\n## Work\n- Based in Seattle.\n",
        idempotency_key="pod_compile",
    )
    work_pid = (await pod_lib.list_pages())[0]["page_id"]
    work_doc = await pod_lib.read_page(work_pid)
    res_pod = await pod_mig.propagate_forget_and_correction(
        page_id=work_pid,
        claim_id=work_doc["claims"][0]["claim_id"],
        replacement_statement="Based in San Francisco.",
        idempotency_key="corr_pod_1",
        destroy_page_key=True,
        delete_retired_blobs=True,
    )
    assert res_pod["outcomes"] == {
        "logical_deletion": True,
        "revoked_future_access": True,
        "key_destroyed": True,
        "provider_operation_acknowledged": True,
        "physical_erasure_under_retention": True,
    }


@pytest.mark.asyncio
async def test_phase4_bounded_maintenance_dedup_expiry_contradiction_and_hot_budget() -> None:
    store = _CasStore(supports_delete=True)
    lib = WikiLibrary(
        owner="usr_phase4_maint",
        key=b"\x44" * 32,
        store=store,
        check=_noop_check,
    )
    await lib.register_source(
        {
            "source_id": "wsr_0000000000000001",
            "kind": "owner_direct",
            "locator": "direct:1",
            "content_sha256": "a" * 64,
            "observed_at": "2026-01-01T00:00:00Z",
            "consent_derived": False,
        },
        idempotency_key="src_1",
    )
    await lib.create_page(
        page_id="wpg_0000000000000010",
        title="Schedule",
        folder="topics",
        tldr="Schedule notes",
        status_as_of="2026-01-01",
        body="See [[wpg_9999999999999999|Missing target]].",
        claims=[
            {
                "claim_id": "wcl_0000000000000011",
                "statement": "Morning meetings start at 9am",
                "status": "active",
                "confidence": 1.0,
                "source_ids": ["wsr_0000000000000001"],
                "observed_at": "2026-01-01",
            },
            {
                "claim_id": "wcl_0000000000000012",
                "statement": "morning   meetings start at 9am",
                "status": "active",
                "confidence": 0.9,
                "source_ids": ["wsr_0000000000000001"],
                "observed_at": "2026-01-02",
            },
            {
                "claim_id": "wcl_0000000000000013",
                "statement": "Temporary conference hotel pass",
                "status": "active",
                "confidence": 1.0,
                "source_ids": ["wsr_0000000000000001"],
                "observed_at": "2026-01-01",
                "valid_until": "2026-02-01",
            },
            {
                "claim_id": "wcl_0000000000000014",
                "statement": "Never schedule morning meetings",
                "status": "active",
                "confidence": 1.0,
                "source_ids": ["wsr_0000000000000001"],
                "observed_at": "2026-01-03",
            },
        ],
        links=[],
        source_ids=["wsr_0000000000000001"],
        idempotency_key="create_sched",
    )

    runner = WikiMaintenanceRunner(lib)
    report = await runner.run_tick(
        idempotency_key="maint_tick_1",
        reference_date="2026-06-01",
        max_pages_per_tick=1,
    )
    assert report["inspected_page_count"] == 1
    assert report["deduplicated_claim_count"] == 1
    assert report["expired_claim_count"] == 1
    assert len(report["contradictions"]) == 1
    assert report["broken_links"] == [
        {
            "source_page_id": "wpg_0000000000000010",
            "target_page_id": "wpg_9999999999999999",
        }
    ]
    assert report["orphan_page_ids"] == ["wpg_0000000000000010"]
    assert report["hot_digest_chars"] <= WIKI_HOT_MAX_CHARS
    assert report["hot_digest_within_budget"] is True
