"""The PKM engine conformance oracle: behaviour, pinned exactly, engine-agnostic.

Every assertion here was DISCOVERED by running the real stored procedures on a
real Postgres 16 (see ``postgres_harness``), not written from hope:

* a fresh domain commits from expected revision 0 to 1;
* a wrong expected revision RETURNS ``{"success": false, "conflict": true}`` and
  writes nothing -- it does not raise;
* replaying the same ``p_commit_id`` with the same fingerprint is idempotent
  (``idempotent_replay: true``) and never double-applies;
* the same ``p_commit_id`` with a DIFFERENT fingerprint RAISES
  ``pkm_commit_id_binding_mismatch`` -- an idempotency key must never bind two
  different payloads;
* the snapshot returns the committed ciphertext by segment id, with the
  revision;
* ``merge_domain_summary`` patches the domain's summary projection;
* delete with a wrong revision returns a conflict and PRESERVES the domain;
  delete with the right revision tombstones it (revision advances, snapshot
  goes empty) -- losing either half silently converts conflicts into
  last-write-wins data loss, which is precisely what the optimistic-concurrency
  contract exists to prevent.

The oracle runs against any ``PkmWriteEngine`` through a small peer:

    class ConformancePeer(Protocol):
        engine: PkmWriteEngine
        async def create_user(self, user_id: str) -> None
        async def read_domain_summary(self, user_id: str, domain: str) -> dict | None

``run_all`` executes every scenario and returns their names, so a caller can
assert the COUNT -- a scenario that silently stopped running is a hole in the
oracle, and holes are how ports lose user data politely.
"""

from __future__ import annotations

import uuid
from typing import Any, Optional, Protocol

from hushh_mcp.services.pkm_write_engine import PkmWriteEngine

DOMAIN = "financial"
FINGERPRINT_A = "2" * 64
FINGERPRINT_B = "9" * 64


class ConformancePeer(Protocol):
    engine: PkmWriteEngine

    async def create_user(self, user_id: str) -> None: ...

    async def read_domain_summary(self, user_id: str, domain: str) -> Optional[dict]: ...


def unwrap(result: Any, fn: str) -> Any:
    """Mirror of the service's ``_unwrap_rpc_payload`` normalization."""
    payload = getattr(result, "data", result)
    if isinstance(payload, list):
        payload = payload[0] if payload else None
    if isinstance(payload, dict) and len(payload) == 1 and fn in payload:
        payload = payload[fn]
    return payload


def _segments(version: int) -> list[dict]:
    return [
        {
            "segment_id": "root",
            "ciphertext": f"cipher-root-v{version}",
            "iv": f"iv-root-v{version}",
            "tag": f"tag-root-v{version}",
            "algorithm": "aes-256-gcm",
            "manifest_revision": version,
            "size_bytes": 14,
        }
    ]


def _manifest(version: int) -> dict:
    return {
        "manifest_version": version,
        "domain_contract_version": 4,
        "readable_summary_version": 1,
        "pkm_contract_version": "6.0.0",
        "readable_projection_version": "6.0.0",
        "structure_decision": {},
        "summary_projection": {
            "pkm_contract_version": "6.0.0",
            "readable_projection_version": "6.0.0",
        },
        "top_level_scope_paths": ["portfolio"],
        "externalizable_paths": [],
        "segment_ids": ["root"],
        "path_count": 1,
        "externalizable_path_count": 0,
        "last_structured_at": "2026-01-01T00:00:00+00:00",
        "last_content_at": "2026-01-01T00:00:00+00:00",
    }


def _commit_params(
    user_id: str,
    *,
    expected: int,
    next_revision: int,
    commit_id: str,
    fingerprint: str = FINGERPRINT_A,
) -> dict:
    return {
        "p_user_id": user_id,
        "p_domain": DOMAIN,
        "p_expected_content_revision": expected,
        "p_next_content_revision": next_revision,
        "p_segment_rows": _segments(next_revision),
        "p_manifest_row": _manifest(next_revision),
        "p_path_rows": [],
        "p_scope_rows": [],
        "p_summary_patch": {},
        "p_event_rows": [],
        "p_legacy_blob_present": False,
        "p_refresh_tokens": [],
        "p_trigger_paths": [],
        "p_commit_id": commit_id,
        "p_commit_kind": "mutation",
        "p_upgrade_claim": None,
        "p_preservation_receipt": {},
        "p_request_fingerprint": fingerprint,
    }


async def _snapshot(peer: ConformancePeer, user_id: str) -> Any:
    raw = await peer.engine.get_domain_snapshot(
        {"p_user_id": user_id, "p_domain": DOMAIN, "p_segment_ids": []}
    )
    return unwrap(raw, "get_pkm_domain_snapshot_v1")


async def _fresh_committed_user(peer: ConformancePeer, tag: str) -> tuple[str, str]:
    user_id = f"oracle-{tag}-{uuid.uuid4().hex[:10]}"
    commit_id = str(uuid.uuid4())
    await peer.create_user(user_id)
    raw = await peer.engine.commit_domain_mutation(
        _commit_params(user_id, expected=0, next_revision=1, commit_id=commit_id)
    )
    payload = unwrap(raw, "commit_pkm_domain_mutation_v4")
    assert payload["success"] is True and payload["conflict"] is False
    assert int(payload["data_version"]) == 1
    return user_id, commit_id


# --- scenarios ------------------------------------------------------------------------


async def scenario_fresh_commit_creates_revision_one(peer: ConformancePeer) -> None:
    await _fresh_committed_user(peer, "fresh")


async def scenario_snapshot_returns_the_committed_ciphertext(peer: ConformancePeer) -> None:
    user_id, _ = await _fresh_committed_user(peer, "snap")
    snapshot = await _snapshot(peer, user_id)
    assert int(snapshot["content_revision"]) == 1
    assert snapshot["segments"]["root"]["ciphertext"] == "cipher-root-v1"
    assert snapshot["segments"]["root"]["algorithm"] == "aes-256-gcm"


async def scenario_wrong_expected_revision_conflicts_and_writes_nothing(
    peer: ConformancePeer,
) -> None:
    user_id, _ = await _fresh_committed_user(peer, "conflict")
    raw = await peer.engine.commit_domain_mutation(
        _commit_params(user_id, expected=5, next_revision=6, commit_id=str(uuid.uuid4()))
    )
    payload = unwrap(raw, "commit_pkm_domain_mutation_v4")
    assert payload["success"] is False and payload["conflict"] is True
    assert int(payload["data_version"]) == 1
    snapshot = await _snapshot(peer, user_id)
    assert int(snapshot["content_revision"]) == 1
    assert snapshot["segments"]["root"]["ciphertext"] == "cipher-root-v1"


async def scenario_exact_replay_is_idempotent(peer: ConformancePeer) -> None:
    user_id, commit_id = await _fresh_committed_user(peer, "replay")
    raw = await peer.engine.commit_domain_mutation(
        _commit_params(user_id, expected=0, next_revision=1, commit_id=commit_id)
    )
    payload = unwrap(raw, "commit_pkm_domain_mutation_v4")
    assert payload["success"] is True
    assert payload["idempotent_replay"] is True
    assert int(payload["data_version"]) == 1


async def scenario_commit_id_never_binds_two_payloads(peer: ConformancePeer) -> None:
    user_id, commit_id = await _fresh_committed_user(peer, "binding")
    raised: Optional[BaseException] = None
    try:
        await peer.engine.commit_domain_mutation(
            _commit_params(
                user_id,
                expected=0,
                next_revision=1,
                commit_id=commit_id,
                fingerprint=FINGERPRINT_B,
            )
        )
    except Exception as exc:  # noqa: BLE001 - the assertion is on the message
        raised = exc
    assert raised is not None, "a reused commit id with a different payload was accepted"
    assert "pkm_commit_id_binding_mismatch" in str(raised)


async def scenario_merge_summary_patches_the_projection(peer: ConformancePeer) -> None:
    user_id, _ = await _fresh_committed_user(peer, "merge")
    await peer.engine.merge_domain_summary(
        {
            "p_user_id": user_id,
            "p_domain": DOMAIN,
            "p_patch": {"readable_summary": "hello"},
            "p_domains_list": [DOMAIN],
        }
    )
    summary = await peer.read_domain_summary(user_id, DOMAIN)
    assert summary is not None and summary.get("readable_summary") == "hello"


async def scenario_delete_with_wrong_revision_preserves_the_domain(
    peer: ConformancePeer,
) -> None:
    user_id, _ = await _fresh_committed_user(peer, "delwrong")
    raw = await peer.engine.delete_domain(
        {
            "p_user_id": user_id,
            "p_domain": DOMAIN,
            "p_expected_content_revision": 9,
            "p_refresh_tokens": [],
            "p_trigger_paths": [],
        }
    )
    payload = unwrap(raw, "delete_pkm_domain_v3")
    assert payload["deleted"] is False and payload["conflict"] is True
    snapshot = await _snapshot(peer, user_id)
    assert snapshot["segments"]["root"]["ciphertext"] == "cipher-root-v1"


async def scenario_delete_with_right_revision_tombstones(peer: ConformancePeer) -> None:
    user_id, _ = await _fresh_committed_user(peer, "delok")
    raw = await peer.engine.delete_domain(
        {
            "p_user_id": user_id,
            "p_domain": DOMAIN,
            "p_expected_content_revision": 1,
            "p_refresh_tokens": [],
            "p_trigger_paths": [],
        }
    )
    payload = unwrap(raw, "delete_pkm_domain_v3")
    assert payload["deleted"] is True and payload["success"] is True
    assert int(payload["data_version"]) == 2  # a delete is a revision, not an erasure of history
    snapshot = await _snapshot(peer, user_id)
    assert not (snapshot or {}).get("segments")
    assert (snapshot or {}).get("content_revision") in (None, "")


async def scenario_legacy_delete_still_answers(peer: ConformancePeer) -> None:
    user_id, _ = await _fresh_committed_user(peer, "dellegacy")
    raw = await peer.engine.delete_domain_legacy({"p_user_id": user_id, "p_domain": DOMAIN})
    payload = unwrap(raw, "delete_pkm_domain_v2")
    assert bool(payload) is True
    snapshot = await _snapshot(peer, user_id)
    assert not (snapshot or {}).get("segments")


SCENARIOS = [
    scenario_fresh_commit_creates_revision_one,
    scenario_snapshot_returns_the_committed_ciphertext,
    scenario_wrong_expected_revision_conflicts_and_writes_nothing,
    scenario_exact_replay_is_idempotent,
    scenario_commit_id_never_binds_two_payloads,
    scenario_merge_summary_patches_the_projection,
    scenario_delete_with_wrong_revision_preserves_the_domain,
    scenario_delete_with_right_revision_tombstones,
    scenario_legacy_delete_still_answers,
]


async def run_all(peer: ConformancePeer) -> list[str]:
    executed: list[str] = []
    for scenario in SCENARIOS:
        await scenario(peer)
        executed.append(scenario.__name__)
    return executed
