from __future__ import annotations

import inspect
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from hushh_mcp.services.one_location_agent_service import (
    LOCATION_EXPIRED_REQUEST_RETENTION_HOURS,
    LOCATION_REQUEST_EXPIRY_HOURS,
    OneLocationAgentError,
    OneLocationAgentService,
)
from tests.services.test_one_location_agent_service import FourUserMemoryService


def _service() -> FourUserMemoryService:
    service = FourUserMemoryService()
    for user_id in ("user_a", "user_b"):
        service.register_recipient_key(
            user_id=user_id,
            key_id=f"key-{user_id}",
            public_key_jwk={"kty": "EC", "crv": "P-256", "x": user_id, "y": user_id},
        )
    return service


def _ask(service: FourUserMemoryService) -> dict:
    return service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
        requested_duration_hours=1,
        requested_duration_mode="timed",
    )


def _make_stale(service: FourUserMemoryService, request_id: str) -> None:
    request = service.requests[request_id]
    request["requested_at"] = datetime.now(timezone.utc) - timedelta(
        hours=LOCATION_REQUEST_EXPIRY_HOURS,
        minutes=1,
    )
    request["expires_at"] = datetime.now(timezone.utc) - timedelta(minutes=1)


def _attach_public_parent(service: FourUserMemoryService, request_id: str) -> None:
    submission_id = f"linked-submission-{len(service.public_submissions) + 1}"
    service.public_submissions[submission_id] = {
        "id": submission_id,
        "request_id": request_id,
    }


def test_direct_ask_gets_a_server_owned_one_day_deadline() -> None:
    service = _service()
    before = datetime.now(timezone.utc)

    request = _ask(service)

    expires_at = datetime.fromisoformat(request["expiresAt"])
    assert before + timedelta(hours=LOCATION_REQUEST_EXPIRY_HOURS - 0.01) < expires_at
    assert expires_at < datetime.now(timezone.utc) + timedelta(
        hours=LOCATION_REQUEST_EXPIRY_HOURS + 0.01
    )


def test_exact_retry_before_expiry_remains_idempotent() -> None:
    service = _service()
    first = _ask(service)
    notifications_before = len(
        [
            item
            for item in service.notifications
            if item["notification_type"] == "location_access_request"
        ]
    )

    again = _ask(service)

    assert again["id"] == first["id"]
    assert (
        len(
            [
                item
                for item in service.notifications
                if item["notification_type"] == "location_access_request"
            ]
        )
        == notifications_before
    )


def test_ask_again_after_expiry_creates_a_new_request_and_notification() -> None:
    service = _service()
    first = _ask(service)
    _make_stale(service, first["id"])

    again = _ask(service)

    assert again["id"] != first["id"]
    assert service.requests[first["id"]]["status"] == "expired"
    assert again["status"] == "pending"
    notifications = [
        item
        for item in service.notifications
        if item["notification_type"] == "location_access_request"
    ]
    assert len(notifications) == 2
    assert notifications[-1]["data"]["request_id"] == again["id"]


def test_read_projection_and_pending_lists_drop_a_stale_row_without_waiting_for_cleanup() -> None:
    service = _service()
    request = _ask(service)
    _make_stale(service, request["id"])

    projected = OneLocationAgentService._request_payload(service.requests[request["id"]])

    assert projected is not None
    assert projected["status"] == "expired"
    assert projected["resolvedAt"] == projected["expiresAt"]
    assert service.list_pending_owner_requests(owner_user_id="user_a") == []
    assert service.list_pending_requester_requests(requester_user_id="user_b") == []


@pytest.mark.parametrize("action", ["approve", "deny", "withdraw"])
def test_stale_request_actions_return_gone(action: str) -> None:
    service = _service()
    request = _ask(service)
    _make_stale(service, request["id"])

    with pytest.raises(OneLocationAgentError) as raised:
        if action == "approve":
            service.approve_request(
                owner_user_id="user_a",
                request_id=request["id"],
                approval_mode="manual",
                duration_hours=None,
            )
        elif action == "deny":
            service.deny_request(owner_user_id="user_a", request_id=request["id"])
        else:
            service.withdraw_request(requester_user_id="user_b", request_id=request["id"])

    assert raised.value.code == "LOCATION_REQUEST_EXPIRED"
    assert raised.value.status_code == 410


@pytest.mark.parametrize("action", ["approve", "deny", "withdraw"])
def test_mixed_version_orphan_is_repaired_before_any_consent_action(action: str) -> None:
    service = _service()
    request = service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
        requested_duration_hours=1,
        requested_duration_mode="timed",
        _expires_after_hours=None,
    )
    request_row = service.requests[request["id"]]
    request_row["requested_at"] = datetime.now(timezone.utc) - timedelta(hours=25)

    with pytest.raises(OneLocationAgentError) as raised:
        if action == "approve":
            service.approve_request(
                owner_user_id="user_a",
                request_id=request["id"],
                approval_mode="manual",
                duration_hours=None,
            )
        elif action == "deny":
            service.deny_request(owner_user_id="user_a", request_id=request["id"])
        else:
            service.withdraw_request(requester_user_id="user_b", request_id=request["id"])

    assert raised.value.code == "LOCATION_REQUEST_EXPIRED"
    assert request_row["status"] == "expired"


def test_linked_workflow_can_explicitly_keep_its_parent_owned_lifetime() -> None:
    service = _service()

    request = service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
        _expires_after_hours=None,
    )
    _attach_public_parent(service, request["id"])
    service.requests[request["id"]]["requested_at"] = datetime.now(timezone.utc) - timedelta(
        days=30
    )

    assert request["expiresAt"] is None
    assert service.list_pending_owner_requests(owner_user_id="user_a")[0]["id"] == request["id"]


@pytest.mark.parametrize("first_policy", ["direct", "parent_owned"])
def test_direct_and_parent_owned_requests_never_reuse_each_other(first_policy: str) -> None:
    service = _service()

    def create(policy: str) -> dict:
        if policy == "direct":
            return _ask(service)
        request = service.request_access(
            requester_user_id="user_b",
            owner_user_id="user_a",
            requested_duration_hours=1,
            requested_duration_mode="timed",
            _expires_after_hours=None,
        )
        _attach_public_parent(service, request["id"])
        return request

    second_policy = "parent_owned" if first_policy == "direct" else "direct"
    first = create(first_policy)
    second = create(second_policy)

    assert first["id"] != second["id"]
    assert len(service.requests) == 2
    by_policy = {first_policy: first, second_policy: second}
    assert by_policy["direct"]["expiresAt"] is not None
    assert by_policy["parent_owned"]["expiresAt"] is None


def test_mixed_version_orphaned_direct_request_is_adopted_and_expires() -> None:
    service = _service()
    legacy = service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
        requested_duration_hours=1,
        requested_duration_mode="timed",
        _expires_after_hours=None,
    )
    legacy_row = service.requests[legacy["id"]]
    legacy_row["requested_at"] = datetime.now(timezone.utc) - timedelta(hours=25)

    fresh = _ask(service)

    assert fresh["id"] != legacy["id"]
    assert legacy_row["status"] == "expired"
    assert legacy_row["expires_at"] == legacy_row["requested_at"] + timedelta(
        hours=LOCATION_REQUEST_EXPIRY_HOURS
    )


def test_read_only_state_projects_mixed_version_direct_expiry_without_writing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = _service()
    legacy = service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
        _expires_after_hours=None,
    )
    legacy_row = service.requests[legacy["id"]]
    legacy_row["requested_at"] = datetime.now(timezone.utc) - timedelta(days=3)
    monkeypatch.setenv("ONE_LOCATION_READ_ONLY_STATE_ENABLED", "true")

    state = service.list_state(user_id="user_b")
    projected = next(item for item in state["requests"] if item["id"] == legacy["id"])

    assert projected["status"] == "expired"
    assert projected["expiresAt"] is not None
    assert legacy_row["status"] == "pending"
    assert legacy_row["expires_at"] is None


def test_read_only_state_does_not_invent_expiry_for_linked_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = _service()
    linked = service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
        _expires_after_hours=None,
    )
    _attach_public_parent(service, linked["id"])
    linked_row = service.requests[linked["id"]]
    linked_row["requested_at"] = datetime.now(timezone.utc) - timedelta(days=30)
    monkeypatch.setenv("ONE_LOCATION_READ_ONLY_STATE_ENABLED", "true")

    state = service.list_state(user_id="user_b")
    projected = next(item for item in state["requests"] if item["id"] == linked["id"])

    assert projected["status"] == "pending"
    assert projected["expiresAt"] is None


def test_request_deadline_actions_use_the_database_wall_clock() -> None:
    # PostgreSQL NOW() is frozen at transaction start. A consent deadline must
    # keep advancing while a transaction waits on a lock or performs approval.
    for method in (
        OneLocationAgentService.request_access,
        OneLocationAgentService.approve_request,
        OneLocationAgentService.deny_request,
        OneLocationAgentService.withdraw_request,
        OneLocationAgentService._repair_legacy_direct_request_deadlines,
        OneLocationAgentService._expire_stale_requests,
    ):
        assert "clock_timestamp()" in inspect.getsource(method)


def test_expired_request_does_not_remain_a_needs_action_recommendation() -> None:
    service = _service()
    service._seed_connection("user_a", "user_b")
    request = _ask(service)
    _make_stale(service, request["id"])

    recipients = service.list_verified_recipients(owner_user_id="user_a")
    user_b = next(recipient for recipient in recipients if recipient["userId"] == "user_b")

    assert user_b["recommendationCategory"] != "needs_action"
    assert all(
        reason["code"] != "pending_location_request" for reason in user_b["recommendationReasons"]
    )


def test_hourly_maintenance_settles_expired_requests() -> None:
    service = _service()
    request = _ask(service)
    _make_stale(service, request["id"])

    service.purge_terminal_work(older_than_hours=12)

    assert service.requests[request["id"]]["status"] == "expired"


def test_three_day_return_keeps_expired_outcome_for_ask_again() -> None:
    service = _service()
    request = _ask(service)
    request_row = service.requests[request["id"]]
    request_row["requested_at"] = datetime.now(timezone.utc) - timedelta(days=3)
    request_row["expires_at"] = request_row["requested_at"] + timedelta(
        hours=LOCATION_REQUEST_EXPIRY_HOURS
    )

    service.purge_terminal_work(older_than_hours=12)

    assert request["id"] in service.requests
    assert request_row["status"] == "expired"
    projected = OneLocationAgentService._request_payload(request_row)
    assert projected is not None
    assert projected["status"] == "expired"


def test_expired_outcome_is_removed_after_bounded_tombstone_window() -> None:
    service = _service()
    request = _ask(service)
    request_row = service.requests[request["id"]]
    request_row["requested_at"] = datetime.now(timezone.utc) - timedelta(
        hours=LOCATION_EXPIRED_REQUEST_RETENTION_HOURS + LOCATION_REQUEST_EXPIRY_HOURS + 1
    )
    request_row["expires_at"] = request_row["requested_at"] + timedelta(
        hours=LOCATION_REQUEST_EXPIRY_HOURS
    )

    service.purge_terminal_work(older_than_hours=12)

    assert request["id"] not in service.requests


def test_migration_scopes_backfill_away_from_linked_workflows() -> None:
    root = Path(__file__).resolve().parents[1]
    migration = (root / "db/migrations/191_one_location_access_request_expiry.sql").read_text(
        encoding="utf-8"
    )
    rollback = (
        root / "db/migrations/rollback/191_one_location_access_request_expiry.rollback.sql"
    ).read_text(encoding="utf-8")

    assert "'expired'" in migration
    assert "expires_at" in migration
    assert "INTERVAL '24 hours'" in migration
    assert "one_location_referrals" in migration
    assert "one_location_public_invite_submissions" in migration
    expiry_constraint = "chk_one_location_access_request_expiry_after_send"
    assert migration.index(f"DROP CONSTRAINT IF EXISTS {expiry_constraint}") < migration.index(
        f"ADD CONSTRAINT {expiry_constraint}"
    )
    assert "status = 'cancelled'" in rollback
    assert "status = 'pending' AND expires_at IS NOT NULL" in rollback
    assert rollback.index("status = 'pending' AND expires_at IS NOT NULL") < rollback.index(
        "DROP COLUMN IF EXISTS expires_at"
    )

    manifest = json.loads((root / "db/release_migration_manifest.json").read_text(encoding="utf-8"))
    migration_name = "191_one_location_access_request_expiry.sql"
    assert migration_name in manifest["ordered_migrations"]
    assert manifest["ordered_migrations"].index(migration_name) > manifest[
        "ordered_migrations"
    ].index("190_one_location_place_ratings.sql")
    assert migration_name in manifest["groups"]["iam"]
    expected_version = int(migration_name.split("_", 1)[0])
    for contract_name in (
        "dev_minimum_schema.json",
        "prod_core_schema.json",
        "uat_integrated_schema.json",
    ):
        contract = json.loads((root / "db/contracts" / contract_name).read_text(encoding="utf-8"))
        assert contract["expected_migration_version"] >= expected_version
