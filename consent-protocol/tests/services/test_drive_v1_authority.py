"""A V1 flag alone cannot authorize payment for an agent-selected file set."""

from copy import deepcopy
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_owner_allowed import (
    automatic_recipient_current,
    owner_allowed_marker,
    package_allow_marker,
)
from hushh_mcp.services.drive_request_review_policy import request_requires_owner_review
from hushh_mcp.services.drive_sharing_store import DriveSharingStore
from hushh_mcp.services.drive_v1_authority import v1_package_allowed


def authority():
    future = datetime.now(UTC) + timedelta(hours=1)
    bound = {
        "position": 1,
        "file_digest": "a" * 64,
        "source_version": "7",
        "content_fingerprint": "b" * 64,
        "evidence_digest": "c" * 64,
    }
    marker = {
        "v": 1,
        "amount_cents": 100,
        "allowed_at": datetime.now(UTC).isoformat(),
        "package_revision": 2,
        "request_revision": 3,
        "connection_generation": 4,
        "search_job_id": "job",
        "package_digest": "d" * 64,
        "selected_positions": [1],
        "package_selected_count": 1,
        "selected_sources": [bound],
    }
    request = {
        "request_id": "request",
        "user_id": "owner",
        "recipient_user_id": "buyer",
        "revision": 3,
        "status": "pending",
        "expires_at": future,
        "v1_live_request": True,
        "owner_allowed_at": datetime.now(UTC),
        "access_stop_requested_at": None,
        "request_envelope": {
            "agent_package_required": True,
            "trusted_auto": True,
            "owner_allowed": marker,
        },
    }
    search = {
        "status": "completed",
        "connection_generation": 4,
        "incomplete_search": False,
        "expires_at": future,
    }
    rows = [
        {
            "source_position": 1,
            "file_digest": "a" * 64,
            "share_id": "share",
            "file_count": 1,
            "connection_generation": 4,
            "search_job_id": "job",
            "origin_request_revision": 3,
            "progressive_batch": True,
            "recipient_count": 1,
            "approval_source": None,
            "approved_at": None,
            "status": "review_ready",
            "expires_at": future,
            "recipient_user_id": "buyer",
            "metadata_envelope": {
                "id": "source",
                "sourceVersion": "7",
                "contentFingerprint": "b" * 64,
                "evidenceDigest": "c" * 64,
                "packageDigest": "d" * 64,
            },
        }
    ]

    def execute(sql, params):
        if "FROM drive_owner_search_jobs" in str(sql):
            assert params == {"job": "job", "owner": "owner"}
            return SimpleNamespace(mappings=lambda: SimpleNamespace(first=lambda: search))
        assert params == {"request": "request", "owner": "owner", "revision": 3}
        return SimpleNamespace(mappings=lambda: rows)

    return (
        request,
        search,
        rows,
        SimpleNamespace(execute=execute),
        SimpleNamespace(open=lambda x, **_: x),
    )


def test_exact_owner_allow_admits_checkout_before_paid_bulk_approval():
    request, _, rows, connection, cipher = authority()
    assert v1_package_allowed(connection, request, cipher=cipher)
    rows[0].update(status="queued", approved_at=datetime.now(UTC), approval_source="trusted_auto")
    assert v1_package_allowed(connection, request, cipher=cipher, share_id="share")
    assert not v1_package_allowed(connection, request, cipher=cipher, share_id="other-share")


@pytest.mark.parametrize(
    "field,value",
    [
        ("v1_live_request", False),
        ("owner_allowed_at", None),
        ("access_stop_requested_at", datetime.now(UTC)),
        ("revision", 4),
        ("status", "cancelled"),
        ("expires_at", datetime.now(UTC) - timedelta(seconds=1)),
    ],
)
def test_request_marker_never_substitutes_current_owner_authority(field, value):
    request, _, _, connection, cipher = authority()
    request[field] = value
    assert not v1_package_allowed(connection, request, cipher=cipher)


@pytest.mark.parametrize(
    "change",
    [
        {"recipient_user_id": "another-buyer"},
        {"connection_generation": 5},
        {"search_job_id": "other-job"},
        {"file_digest": "e" * 64},
        {"source_position": 2},
        {"recipient_count": 2},
        {"progressive_batch": False},
        {"status": "queued", "approved_at": None, "approval_source": "trusted_auto"},
    ],
)
def test_frozen_source_and_buyer_must_equal_exact_allowed_manifest(change):
    request, _, rows, connection, cipher = authority()
    rows[0].update(change)
    assert not v1_package_allowed(connection, request, cipher=cipher)


@pytest.mark.parametrize(
    "field", ["sourceVersion", "contentFingerprint", "evidenceDigest", "packageDigest"]
)
def test_changed_extracted_source_evidence_cannot_charge(field):
    request, _, rows, connection, cipher = authority()
    rows[0]["metadata_envelope"][field] = "changed"
    assert not v1_package_allowed(connection, request, cipher=cipher)


def test_incomplete_search_partial_manifest_and_duplicated_rows_fail_closed():
    request, search, rows, connection, cipher = authority()
    search["incomplete_search"] = True
    assert not v1_package_allowed(connection, request, cipher=cipher)
    search["incomplete_search"] = False
    saved = deepcopy(rows[0])
    rows.clear()
    assert not v1_package_allowed(connection, request, cipher=cipher)
    rows.extend([saved, deepcopy(saved)])
    assert not v1_package_allowed(connection, request, cipher=cipher)


def test_unreadable_sealed_owner_allow_never_authorizes_checkout():
    request, _, _, connection, _ = authority()
    assert not v1_package_allowed(
        connection, request, cipher=SimpleNamespace(open=Mock(side_effect=ValueError))
    )


def test_approved_v1_provenance_survives_for_reconciliation_and_notifications():
    """Revocation prevents new grants, but must not strand a dispatched POST."""
    store = object.__new__(DriveBulkShareStore)
    store._row = Mock(return_value={"approval_source": "trusted_auto"})
    assert store._v1_approved_share(object(), user_id="owner", share_id="share")
    sql = store._row.call_args.args[1]
    assert "b.v1_statement_search=TRUE" in sql
    assert "b.approved_at IS NOT NULL" in sql
    assert "b.recipient_count=1" in sql
    store._row.assert_called_once()
    store._row.return_value = None
    assert not store._v1_approved_share(object(), user_id="owner", share_id="unapproved")


def trusted_authority():
    request, search, rows, connection, cipher = authority()
    private = request["request_envelope"]
    selected = private.pop("owner_allowed")
    selected["selected_at"] = selected.pop("allowed_at")
    private.update(v1_live_request=True, trusted_selection=selected)
    request["owner_allowed_at"] = None
    return request, search, rows, connection, cipher


def test_trusted_exact_selection_never_fabricates_owner_allow_and_requires_current_trust(
    monkeypatch,
):
    request, _, _, connection, cipher = trusted_authority()
    private = request["request_envelope"]
    assert owner_allowed_marker(private) is None
    assert package_allow_marker(private) is not None
    trusted = Mock(return_value=True)
    monkeypatch.setattr(DriveSharingStore, "_trusted_recipient_current", trusted)
    assert v1_package_allowed(connection, request, cipher=cipher)
    assert request["owner_allowed_at"] is None
    trusted.return_value = False
    assert not v1_package_allowed(connection, request, cipher=cipher)
    assert not automatic_recipient_current(
        connection, "owner", "buyer", private, request_id="request"
    )


@pytest.mark.parametrize(
    "change",
    [
        {"v1_live_request": False},
        {"trusted_auto": False},
        {"agent_package_required": False},
        {"reusable_packet": {}},
        {"owner_allowed": {"v": 1, "amount_cents": 100}},
    ],
)
def test_trusted_manifest_cannot_be_reused_outside_its_request_lane(change):
    request, _, _, _, _ = trusted_authority()
    private = request["request_envelope"]
    private.update(change)
    assert package_allow_marker(private) is None


def test_trusted_review_policy_requires_current_relationship_and_exact_sealed_selection(
    monkeypatch,
):
    request, _, _, _, cipher = trusted_authority()
    marker = request["request_envelope"]["trusted_selection"]
    checkpoint = {
        "agent_package_required": True,
        "request_origin_id": "request",
        "request_revision": 3,
        "agent_package": {
            "digest": marker["package_digest"],
            "revision": marker["package_revision"],
            "connection_generation": 4,
            "selected_positions": [1],
        },
    }

    def execute(sql, _):
        row = (
            {"job_id": "job", "checkpoint_envelope": checkpoint}
            if "drive_owner_search_jobs" in str(sql)
            else request
        )
        return SimpleNamespace(mappings=lambda: SimpleNamespace(first=lambda: row))

    connection = SimpleNamespace(execute=execute)
    trusted = Mock(return_value=True)
    monkeypatch.setattr(DriveSharingStore, "_trusted_recipient_current", trusted)

    def requires_review():
        return request_requires_owner_review(
            connection, user_id="owner", request_id="request", revision=3, cipher=cipher
        )

    assert not requires_review()
    trusted.return_value = False
    assert requires_review()
    trusted.return_value = True
    checkpoint["agent_package"]["digest"] = "f" * 64
    assert requires_review()
