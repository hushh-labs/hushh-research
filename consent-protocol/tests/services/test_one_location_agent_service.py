from __future__ import annotations

import json
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

import hushh_mcp.services.one_location_agent_service as one_location_agent_module
import hushh_mcp.services.one_location_agent_service as one_location_service_module
from hushh_mcp.operons.location.policy import normalize_duration_hours
from hushh_mcp.services.one_location_agent_service import (
    OneLocationAgentError,
    OneLocationAgentService,
    _contains_plaintext_location_key,
    _identity_notification_label,
    _json_param,
    _notification_safe_data,
    _redact_location_metadata,
)

PUBLIC_LOCATION_SNAPSHOT = {
    "latitude": 28.6139,
    "longitude": 77.209,
    "accuracyM": 18,
    "capturedAt": "2026-05-20T07:30:00.000Z",
    "sourcePlatform": "web",
}


def test_location_metadata_redaction_removes_coordinate_like_keys() -> None:
    payload = {
        "reason": "trusted person",
        "latitude": 47.1,
        "nested": {"map_url": "https://maps.example", "safe": "kept"},
        "trail": [{"longitude": -122.3}, {"status": "fresh"}],
    }

    redacted = _redact_location_metadata(payload)
    encoded = _json_param(payload)

    assert redacted == {
        "reason": "trusted person",
        "nested": {"safe": "kept"},
        "trail": [{}, {"status": "fresh"}],
    }
    assert "latitude" not in encoded
    assert "longitude" not in encoded
    assert "map_url" not in encoded


def test_plaintext_coordinate_key_detection_is_recursive() -> None:
    assert _contains_plaintext_location_key({"metadata": {"lat": 1}}) is True
    assert _contains_plaintext_location_key({"metadata": [{"address": "home"}]}) is True
    assert _contains_plaintext_location_key({"payload": "coordinate_envelope"}) is False


def test_notification_identity_label_never_falls_back_to_phone() -> None:
    assert (
        _identity_notification_label(
            {"display_name": "hushh Social", "phone_number": "+91 99999 98014"}
        )
        == "hushh Social"
    )
    assert (
        _identity_notification_label({"display_name": "", "phone_number": "+91 99999 98014"})
        == "A trusted person"
    )


def test_notification_transport_data_excludes_phone_fields() -> None:
    assert _notification_safe_data(
        {
            "grant_id": "grant-1",
            "owner_display_label": "hushh Social",
            "owner_masked_phone": "*******8014",
            "phone_number": "+91 99999 98014",
        }
    ) == {
        "grant_id": "grant-1",
        "owner_display_label": "hushh Social",
    }


def test_duration_bounds_are_v1_limited() -> None:
    assert normalize_duration_hours(0.25) == 0.25
    assert normalize_duration_hours(24) == 24.0

    with pytest.raises(ValueError):
        normalize_duration_hours(0.1)
    with pytest.raises(ValueError):
        normalize_duration_hours(25)


def test_create_grant_rejects_self_recipient_before_db() -> None:
    service = OneLocationAgentService()

    with pytest.raises(OneLocationAgentError) as exc:
        service.create_grant(
            owner_user_id="user_a",
            recipient_user_id="user_a",
            recipient_key_id=None,
            duration_hours=1,
        )

    assert exc.value.code == "LOCATION_RECIPIENT_SELF"


def test_store_envelope_rejects_plaintext_coordinate_metadata_before_db() -> None:
    service = OneLocationAgentService()

    with pytest.raises(OneLocationAgentError) as exc:
        service.store_encrypted_envelope(
            owner_user_id="user_a",
            grant_id="00000000-0000-0000-0000-000000000001",
            envelope={
                "ciphertext": "ciphertext",
                "iv": "iv",
                "senderEphemeralPublicKeyJwk": {"kty": "EC"},
                "recipientKeyId": "recipient-key",
                "metadata": {"latitude": 1.23},
            },
        )

    assert exc.value.code == "LOCATION_ENVELOPE_METADATA_INVALID"


class AtomicPrivateShareProbe(OneLocationAgentService):
    def __init__(
        self,
        *,
        replay: bool = False,
        fail_write: bool = False,
        stored_fingerprint: str | None = None,
        expired_replay: bool = False,
        recipient_key_active: bool = True,
    ) -> None:
        self.replay = replay
        self.fail_write = fail_write
        self.stored_fingerprint = stored_fingerprint
        self.expired_replay = expired_replay
        self.recipient_key_active = recipient_key_active
        self.atomic_sql: list[str] = []
        self.recipient_key_lock_keys: list[str] = []
        self.pair_lock_keys: list[str] = []
        self.notifications: list[dict] = []
        self.expiry_normalizations: list[str | None] = []

    def _is_active_connection(self, **_kwargs) -> bool:
        return True

    def _recipient_key_row(self, **_kwargs) -> dict:
        return {
            "key_id": "recipient-key",
            "display_name": "Recipient",
            "phone_number": "+15550100002",
        }

    def _mint_grant_capability_token(self, **_kwargs) -> dict[str, str]:
        return {"token": "signed-capability", "token_id": "signed-capability"}

    def _send_location_share_created_notification(self, **kwargs) -> None:
        self.notifications.append(kwargs)

    def _expire_stale_grants(self, user_id: str | None) -> None:
        self.expiry_normalizations.append(user_id)

    def _execute_atomic_private_share(
        self,
        *,
        recipient_key_lock_key: str,
        pair_lock_key: str,
        mutation_sql: str,
        params: dict,
    ) -> dict | None:
        values = params
        self.recipient_key_lock_keys.append(recipient_key_lock_key)
        self.pair_lock_keys.append(pair_lock_key)
        self.atomic_sql.append(mutation_sql)
        if self.fail_write:
            raise RuntimeError("transaction failed")
        if not self.replay and not values["freshness_valid"]:
            return None
        metadata = json.loads(values["metadata_json"])
        if self.stored_fingerprint is not None:
            metadata["client_operation_fingerprint"] = self.stored_fingerprint
        grant_id = values["grant_id"]
        envelope_id = values["envelope_id"]
        return {
            "grant_row": {
                "id": grant_id,
                "owner_user_id": values["owner_user_id"],
                "recipient_user_id": values["recipient_user_id"],
                "recipient_key_id": values["recipient_key_id"],
                "status": "active",
                "consent_scope": "cap.location.live.view",
                "capability_scopes": values["capability_scopes"],
                "duration_hours": values["duration_hours"],
                "expires_at": (
                    datetime.now(timezone.utc) - timedelta(seconds=1)
                    if self.expired_replay
                    else values["expires_at"]
                ),
                "created_at": datetime.now(timezone.utc),
                "updated_at": datetime.now(timezone.utc),
                "revoked_at": None,
                "latest_envelope_id": envelope_id,
                "metadata": metadata,
                "recipient_display_name": "Recipient",
                "recipient_phone_number": "+15550100002",
            },
            "envelope_row": {
                "id": envelope_id,
                "grant_id": grant_id,
                "owner_user_id": values["owner_user_id"],
                "recipient_user_id": values["recipient_user_id"],
                "recipient_key_id": values["recipient_key_id"],
                "algorithm": values["algorithm"],
                "ciphertext": values["ciphertext"],
                "iv": values["iv"],
                "sender_ephemeral_public_key_jwk": json.loads(values["sender_key"]),
                "captured_at": values["captured_at"],
                "source_platform": values["source_platform"],
                "publication_context": values["publication_context"],
                "created_at": datetime.now(timezone.utc),
                "metadata": json.loads(values["envelope_metadata_json"]),
            },
            "idempotent_replay": self.replay,
            "recipient_key_active": self.recipient_key_active,
        }


def test_atomic_private_share_lock_precedes_fresh_snapshot_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, dict]] = []
    state = {"exited": False}

    class Result:
        def __init__(self, row: dict | None = None) -> None:
            self.row = row

        def mappings(self):
            return self

        def first(self) -> dict | None:
            return self.row

    class Connection:
        def execute(self, statement, params: dict):
            calls.append((str(statement), params))
            return Result({"saved": True} if len(calls) == 3 else None)

    @contextmanager
    def fake_connection():
        try:
            yield Connection()
        finally:
            state["exited"] = True

    monkeypatch.setattr(
        one_location_service_module,
        "get_db_connection",
        fake_connection,
    )

    result = OneLocationAgentService()._execute_atomic_private_share(
        recipient_key_lock_key="one-location-recipient-key:recipient",
        pair_lock_key="one-location-grant:owner:recipient",
        mutation_sql="SELECT :value AS saved",
        params={"value": True},
    )

    assert result == {"saved": True}
    assert "pg_advisory_xact_lock" in calls[0][0]
    assert calls[0][1] == {"recipient_key_lock_key": "one-location-recipient-key:recipient"}
    assert "pg_advisory_xact_lock" in calls[1][0]
    assert calls[1][1] == {"pair_lock_key": "one-location-grant:owner:recipient"}
    assert calls[2] == ("SELECT :value AS saved", {"value": True})
    assert state["exited"] is True


def test_recipient_key_registration_locks_before_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, dict]] = []

    class Result:
        def __init__(self, row: dict | None = None) -> None:
            self.row = row

        def mappings(self):
            return self

        def first(self) -> dict | None:
            return self.row

    class Connection:
        def execute(self, statement, params: dict):
            calls.append((str(statement), params))
            return Result({"key_id": "new-key"} if len(calls) == 2 else None)

    @contextmanager
    def fake_connection():
        yield Connection()

    monkeypatch.setattr(
        one_location_service_module,
        "get_db_connection",
        fake_connection,
    )

    result = OneLocationAgentService()._execute_recipient_key_registration(
        recipient_key_lock_key="one-location-recipient-key:recipient",
        mutation_sql="SELECT :key_id AS key_id",
        params={"key_id": "new-key"},
    )

    assert result == {"key_id": "new-key"}
    assert "pg_advisory_xact_lock" in calls[0][0]
    assert calls[0][1] == {"recipient_key_lock_key": "one-location-recipient-key:recipient"}
    assert calls[1] == ("SELECT :key_id AS key_id", {"key_id": "new-key"})


def test_key_bound_writer_reuses_one_connection_for_nonreturning_statements(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    class Result:
        def __init__(self, row: dict | None = None, *, returns_rows: bool) -> None:
            self.row = row
            self.returns_rows = returns_rows

        def mappings(self):
            return self

        def first(self) -> dict | None:
            return self.row

    class Connection:
        def execute(self, statement, _params: dict):
            sql = str(statement)
            calls.append(sql)
            if sql == "SELECT :value AS value":
                return Result({"value": True}, returns_rows=True)
            return Result(returns_rows=False)

    connection = Connection()

    @contextmanager
    def fake_connection():
        yield connection

    monkeypatch.setattr(
        one_location_service_module,
        "get_db_connection",
        fake_connection,
    )
    service = OneLocationAgentService()

    with service._key_bound_writer_guard(
        owner_user_id="owner",
        recipient_user_id="recipient",
    ):
        assert service._execute_one("UPDATE example SET value = 1") is None
        assert service._execute_one(
            "SELECT :value AS value",
            {"value": True},
        ) == {"value": True}

    assert len([sql for sql in calls if "pg_advisory_xact_lock" in sql]) == 2
    assert not hasattr(service, "_key_writer_connection")


def test_atomic_private_share_commits_grant_envelope_and_events_together() -> None:
    service = AtomicPrivateShareProbe()
    confirmed_at = datetime.now(timezone.utc)

    result = service.create_grant_with_initial_envelope(
        owner_user_id="owner",
        recipient_user_id="recipient",
        recipient_key_id="recipient-key",
        duration_hours=1,
        client_operation_id="123e4567-e89b-12d3-a456-426614174000",
        confirmed_at=confirmed_at,
        envelope={
            **encrypted_envelope("recipient-key"),
            "capturedAt": confirmed_at.isoformat(),
        },
        reason="Made it safely",
        share_kind="check_in",
        enforce_connection=True,
    )

    assert result["grant"]["latestEnvelopeId"] == result["envelope"]["id"]
    assert result["idempotentReplay"] is False
    assert len(service.atomic_sql) == 1
    assert service.recipient_key_lock_keys == ["one-location-recipient-key:recipient"]
    assert service.pair_lock_keys == ["one-location-grant:owner:recipient"]
    sql = service.atomic_sql[0]
    assert "CAST(:grant_id AS UUID)" in sql
    assert "CAST(:envelope_id AS UUID)" in sql
    assert "FROM connections c" in sql
    assert "k.key_id = :recipient_key_id" in sql
    assert "NOW() - CAST(:confirmed_at AS TIMESTAMPTZ)" in sql
    assert "UPDATE one_location_share_grants" in sql
    assert "INSERT INTO one_location_share_grants" in sql
    assert "INSERT INTO one_location_envelopes" in sql
    assert sql.count("INSERT INTO one_location_events") == 2
    assert len(service.notifications) == 1
    assert service.notifications[0]["reason"] == "check_in"


def test_atomic_private_share_replay_does_not_notify_again() -> None:
    service = AtomicPrivateShareProbe(replay=True)
    confirmed_at = datetime.now(timezone.utc)

    result = service.create_grant_with_initial_envelope(
        owner_user_id="owner",
        recipient_user_id="recipient",
        recipient_key_id="recipient-key",
        duration_hours=1,
        client_operation_id="123e4567-e89b-12d3-a456-426614174001",
        confirmed_at=confirmed_at,
        envelope={
            **encrypted_envelope("recipient-key"),
            "capturedAt": confirmed_at.isoformat(),
        },
        share_kind="check_in",
        enforce_connection=True,
    )

    assert result["idempotentReplay"] is True
    assert service.notifications == []


def test_atomic_private_share_stale_committed_replay_still_succeeds() -> None:
    service = AtomicPrivateShareProbe(replay=True)
    confirmed_at = datetime.now(timezone.utc) - timedelta(minutes=11)

    result = service.create_grant_with_initial_envelope(
        owner_user_id="owner",
        recipient_user_id="recipient",
        recipient_key_id="recipient-key",
        duration_hours=1,
        client_operation_id="123e4567-e89b-12d3-a456-426614174003",
        confirmed_at=confirmed_at,
        envelope={
            **encrypted_envelope("recipient-key"),
            "capturedAt": confirmed_at.isoformat(),
        },
        share_kind="check_in",
        enforce_connection=True,
    )

    assert result["idempotentReplay"] is True
    assert service.notifications == []


def test_atomic_private_share_expired_replay_is_finalized() -> None:
    service = AtomicPrivateShareProbe(replay=True, expired_replay=True)
    confirmed_at = datetime.now(timezone.utc)

    with pytest.raises(OneLocationAgentError) as exc:
        service.create_grant_with_initial_envelope(
            owner_user_id="owner",
            recipient_user_id="recipient",
            recipient_key_id="recipient-key",
            duration_hours=1,
            client_operation_id="123e4567-e89b-12d3-a456-426614174006",
            confirmed_at=confirmed_at,
            envelope={
                **encrypted_envelope("recipient-key"),
                "capturedAt": confirmed_at.isoformat(),
            },
            share_kind="check_in",
            enforce_connection=True,
        )

    assert exc.value.code == "LOCATION_OPERATION_FINALIZED"
    assert service.expiry_normalizations == ["recipient"]
    assert service.notifications == []


def test_atomic_private_share_replay_rejects_rotated_recipient_key() -> None:
    service = AtomicPrivateShareProbe(replay=True, recipient_key_active=False)
    confirmed_at = datetime.now(timezone.utc)

    with pytest.raises(OneLocationAgentError) as exc:
        service.create_grant_with_initial_envelope(
            owner_user_id="owner",
            recipient_user_id="recipient",
            recipient_key_id="recipient-key",
            duration_hours=1,
            client_operation_id="123e4567-e89b-12d3-a456-426614174007",
            confirmed_at=confirmed_at,
            envelope={
                **encrypted_envelope("recipient-key"),
                "capturedAt": confirmed_at.isoformat(),
            },
            share_kind="check_in",
            enforce_connection=True,
        )

    assert exc.value.code == "LOCATION_OPERATION_FINALIZED"
    assert service.notifications == []


def test_atomic_private_share_reused_operation_with_changed_body_fails_closed() -> None:
    service = AtomicPrivateShareProbe(
        replay=True,
        stored_fingerprint="different-request",
    )
    confirmed_at = datetime.now(timezone.utc)

    with pytest.raises(OneLocationAgentError) as exc:
        service.create_grant_with_initial_envelope(
            owner_user_id="owner",
            recipient_user_id="recipient",
            recipient_key_id="recipient-key",
            duration_hours=1,
            client_operation_id="123e4567-e89b-12d3-a456-426614174005",
            confirmed_at=confirmed_at,
            envelope={
                **encrypted_envelope("recipient-key"),
                "capturedAt": confirmed_at.isoformat(),
            },
            share_kind="check_in",
            enforce_connection=True,
        )

    assert exc.value.code == "LOCATION_OPERATION_CONFLICT"
    assert service.notifications == []


def test_atomic_private_share_stale_first_attempt_is_rejected() -> None:
    service = AtomicPrivateShareProbe()
    confirmed_at = datetime.now(timezone.utc) - timedelta(minutes=11)

    with pytest.raises(OneLocationAgentError) as exc:
        service.create_grant_with_initial_envelope(
            owner_user_id="owner",
            recipient_user_id="recipient",
            recipient_key_id="recipient-key",
            duration_hours=1,
            client_operation_id="123e4567-e89b-12d3-a456-426614174004",
            confirmed_at=confirmed_at,
            envelope={
                **encrypted_envelope("recipient-key"),
                "capturedAt": confirmed_at.isoformat(),
            },
            share_kind="check_in",
            enforce_connection=True,
        )

    assert exc.value.code == "LOCATION_CONFIRMATION_EXPIRED"
    assert service.notifications == []


def test_atomic_private_share_failure_never_sends_notification() -> None:
    service = AtomicPrivateShareProbe(fail_write=True)
    confirmed_at = datetime.now(timezone.utc)

    with pytest.raises(RuntimeError, match="transaction failed"):
        service.create_grant_with_initial_envelope(
            owner_user_id="owner",
            recipient_user_id="recipient",
            recipient_key_id="recipient-key",
            duration_hours=1,
            client_operation_id="123e4567-e89b-12d3-a456-426614174002",
            confirmed_at=confirmed_at,
            envelope={
                **encrypted_envelope("recipient-key"),
                "capturedAt": confirmed_at.isoformat(),
            },
            share_kind="check_in",
            enforce_connection=True,
        )

    assert len(service.atomic_sql) == 1
    assert service.notifications == []


class RecipientDirectoryProbe(OneLocationAgentService):
    def __init__(self) -> None:
        self.sql = ""
        self.params = {}

    def _execute_many(self, sql: str, params: dict | None = None) -> list[dict]:
        self.sql = sql
        self.params = params or {}
        return []


def test_verified_recipient_directory_sources_from_connections_and_circles() -> None:
    service = RecipientDirectoryProbe()

    assert service.list_verified_recipients(owner_user_id="owner") == []
    assert "FROM connections c" in service.sql
    assert "c.status = 'active'" in service.sql
    assert "c.user_a_id = :owner_user_id" in service.sql
    assert "c.user_b_id = :owner_user_id" in service.sql
    assert "one_location_circle_memberships mine" in service.sql
    assert "one_location_circle_memberships theirs" in service.sql
    assert "one_location_recipient_keys" in service.sql
    assert "a.user_id <> :owner_user_id" in service.sql
    assert "ORDER BY COALESCE" in service.sql
    assert service.params["owner_user_id"] == "owner"


def test_list_verified_recipients_sources_from_connections(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    svc = OneLocationAgentService()
    captured: dict[str, object] = {}

    def fake_execute_many(sql: str, params: dict | None = None) -> list[dict]:
        captured["sql"] = sql
        captured["params"] = params
        return [
            {
                "user_id": "friend",
                "display_name": "Friend",
                "phone_number": None,
                "phone_verified": True,
                "key_id": "k1",
                "public_key_jwk": "{}",
                "algorithm": "ECDH-P256-AES256-GCM",
                "key_created_at": None,
            }
        ]

    monkeypatch.setattr(svc, "_execute_many", fake_execute_many)
    monkeypatch.setattr(svc, "_apply_kai_circle_recommendations", lambda **kw: kw["recipients"])
    out = svc.list_verified_recipients(owner_user_id="owner")
    assert "FROM connections c" in captured["sql"]
    assert "a.phone_verified = TRUE" not in captured["sql"]
    assert out and out[0]["userId"] == "friend"


class EnvelopeReadProbe(OneLocationAgentService):
    def __init__(self) -> None:
        self.calls: list[str] = []

    def _execute_many(self, sql: str, params: dict | None = None) -> list[dict]:
        self.calls.append(sql)
        return []

    def _execute_one(self, sql: str, params: dict | None = None) -> dict | None:
        self.calls.append(sql)
        if "FROM one_location_share_grants g" in sql:
            return {
                "id": "00000000-0000-0000-0000-000000000001",
                "owner_user_id": "user_a",
                "recipient_user_id": "user_b",
                "recipient_key_id": "key_b",
                "status": "active",
                "duration_hours": 1,
                "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
                "capability_scopes": json.dumps(["cap.location.live.view"]),
                "recipient_key_active": True,
            }
        if "FROM one_location_envelopes" in sql:
            return {
                "id": "00000000-0000-0000-0000-000000000002",
                "grant_id": "00000000-0000-0000-0000-000000000001",
                "owner_user_id": "user_a",
                "recipient_user_id": "user_b",
                "recipient_key_id": "key_b",
                "algorithm": "ECDH-P256-AES256-GCM",
                "ciphertext": "ciphertext-only",
                "iv": "iv",
                "sender_ephemeral_public_key_jwk": {"kty": "EC"},
                "captured_at": datetime.now(timezone.utc),
                "source_platform": "web",
                "metadata": {"plaintext": False},
            }
        return None


def test_view_latest_envelope_returns_ciphertext_only_payload() -> None:
    service = EnvelopeReadProbe()
    response = service.view_latest_envelope(
        recipient_user_id="user_b",
        grant_id="00000000-0000-0000-0000-000000000001",
    )

    stale_cleanup_sql = next(sql for sql in service.calls if "WITH stale AS" in sql)
    assert "UPDATE one_location_share_grants AS target_grant" in stale_cleanup_sql
    assert "RETURNING\n              target_grant.id" in stale_cleanup_sql
    assert response["grant"]["recipientUserId"] == "user_b"
    assert response["envelope"]["ciphertext"] == "ciphertext-only"
    assert "latitude" not in json.dumps(response)
    assert "longitude" not in json.dumps(response)


class FourUserMemoryService(OneLocationAgentService):
    def __init__(self) -> None:
        self.identities = {
            "user_a": {
                "user_id": "user_a",
                "display_name": "User A",
                "phone_number": "+15550100001",
                "phone_verified": True,
            },
            "user_b": {
                "user_id": "user_b",
                "display_name": "User B",
                "phone_number": "+15550100002",
                "phone_verified": True,
            },
            "user_c": {
                "user_id": "user_c",
                "display_name": "User C",
                "phone_number": "+15550100003",
                "phone_verified": True,
            },
            "user_d": {
                "user_id": "user_d",
                "display_name": "User D",
                "phone_number": "+15550100004",
                "phone_verified": True,
            },
        }
        self.keys: dict[tuple[str, str], dict] = {}
        self.grants: dict[str, dict] = {}
        self.envelopes: dict[str, dict] = {}
        self.requests: dict[str, dict] = {}
        self.referrals: dict[str, dict] = {}
        self.public_invites: dict[str, dict] = {}
        self.public_submissions: dict[str, dict] = {}
        self.circle_invites: dict[str, dict] = {}
        self.network_connections: dict[str, dict] = {}
        self.trusted_connections: dict[str, dict] = {}
        self.connections: dict[str, dict] = {}
        self.connection_origins: dict[str, dict] = {}
        self.named_circle_memberships: set[tuple[str, str]] = set()
        self.sms_contacts: set[tuple[str, str]] = set()
        self.events: dict[str, dict] = {}
        self.notifications: list[dict] = []
        self.professional_relationships: list[dict] = []
        self.organization_memberships: list[dict] = []
        self.consent_audit_rows: list[dict] = []
        self.marketplace_profiles: dict[str, dict] = {}
        self.persona_states: dict[str, dict] = {}

    def _seed_connection(self, owner: str, other: str, *, status: str = "active") -> None:
        a, b = sorted((owner, other))
        pair_key = f"{a}:{b}"
        connection = self.connections.setdefault(
            pair_key,
            {
                "id": f"conn-{a}-{b}",
                "user_a_id": a,
                "user_b_id": b,
                "status": status,
            },
        )
        connection["status"] = status
        origin_key = f"{connection['id']}:direct_request"
        self.connection_origins[origin_key] = {
            "id": f"origin-{a}-{b}-direct",
            "connection_id": connection["id"],
            "origin_kind": "direct_request",
            "origin_key": "direct_request",
            "source_circle_id": None,
            "status": status,
        }

    def _seed_named_circle(self, circle_id: str, *user_ids: str) -> None:
        members = sorted(set(user_ids))
        for user_id in members:
            self.named_circle_memberships.add((circle_id, user_id))
        for index, owner in enumerate(members):
            for other in members[index + 1 :]:
                a, b = sorted((owner, other))
                pair_key = f"{a}:{b}"
                connection = self.connections.setdefault(
                    pair_key,
                    {
                        "id": f"conn-{a}-{b}",
                        "user_a_id": a,
                        "user_b_id": b,
                        "status": "active",
                    },
                )
                connection["status"] = "active"
                origin_key = f"{connection['id']}:named_circle:{circle_id}"
                self.connection_origins[origin_key] = {
                    "id": f"origin-{a}-{b}-{circle_id}",
                    "connection_id": connection["id"],
                    "origin_kind": "named_circle",
                    "origin_key": f"named_circle:{circle_id}",
                    "source_circle_id": circle_id,
                    "status": "active",
                }

    def _revoke_connection_origin(
        self,
        owner: str,
        other: str,
        *,
        origin_kind: str,
        source_circle_id: str | None = None,
    ) -> None:
        a, b = sorted((owner, other))
        connection = self.connections[f"{a}:{b}"]
        expected_origin_key = (
            f"named_circle:{source_circle_id}" if origin_kind == "named_circle" else origin_kind
        )
        for origin in self.connection_origins.values():
            if (
                origin["connection_id"] == connection["id"]
                and origin["origin_kind"] == origin_kind
                and origin["origin_key"] == expected_origin_key
            ):
                origin["status"] = "revoked"
        connection["status"] = (
            "active"
            if any(
                origin["connection_id"] == connection["id"] and origin["status"] == "active"
                for origin in self.connection_origins.values()
            )
            else "revoked"
        )

    def _create_enforced_grant_row(
        self,
        *,
        owner_user_id: str,
        recipient_user_id: str,
        requested_circle_id: str | None,
        grant_params: dict,
    ) -> dict | None:
        """In-memory implementation of the production transaction seam."""
        eligible, relationship_circle_id = self._resolve_location_peer_eligibility(
            owner_user_id=owner_user_id,
            other_user_id=recipient_user_id,
            source_circle_id=requested_circle_id,
        )
        if not eligible:
            raise OneLocationAgentError(
                "LOCATION_RECIPIENT_NOT_CONNECTED",
                "You can only share live location with a connection or active Circle member.",
                status_code=403,
            )
        params = {
            **grant_params,
            "source_circle_id": (
                requested_circle_id if requested_circle_id is not None else relationship_circle_id
            ),
        }
        self._execute_many(
            """
            UPDATE one_location_share_grants
            SET status = 'revoked'
            WHERE owner_user_id = :owner_user_id
              AND recipient_user_id = :recipient_user_id
              AND status = 'active'
            """,
            params,
        )
        row = self._execute_one(
            "INSERT INTO one_location_share_grants VALUES (...) RETURNING *",
            params,
        )
        if row:
            self._execute_one(
                """
                INSERT INTO one_location_events (
                  owner_user_id, actor_user_id, recipient_user_id,
                  grant_id, event_type, metadata, created_at
                )
                VALUES (...)
                """,
                {
                    "owner_user_id": owner_user_id,
                    "actor_user_id": owner_user_id,
                    "recipient_user_id": recipient_user_id,
                    "grant_id": row["id"],
                    "envelope_id": None,
                    "request_id": None,
                    "referral_id": None,
                    "event_type": "location_share_created",
                    "metadata_json": json.dumps({"duration_hours": grant_params["duration_hours"]}),
                },
            )
        return row

    def _add_sms_contact_with_locked_eligibility(
        self,
        *,
        owner_user_id: str,
        contact_user_id: str,
    ) -> None:
        if not self._is_location_peer_eligible(
            owner_user_id=owner_user_id,
            other_user_id=contact_user_id,
        ):
            raise OneLocationAgentError(
                "LOCATION_SMS_CONTACT_NOT_CONNECTED",
                "Only an active connection or Circle member can be added as an SMS contact.",
                status_code=403,
            )
        self.sms_contacts.add((owner_user_id, contact_user_id))

    def _send_metadata_notification(self, **kwargs) -> None:
        assert _contains_plaintext_location_key(kwargs.get("data") or {}) is False
        kwargs["data"] = _notification_safe_data(kwargs.get("data") or {})
        self.notifications.append(kwargs)

    @contextmanager
    def _key_bound_writer_guard(
        self,
        *,
        owner_user_id: str,
        recipient_user_id: str,
    ):
        yield

    def _active_key(self, user_id: str, key_id: str | None = None) -> dict | None:
        matches = [
            key
            for (key_user_id, _), key in self.keys.items()
            if key_user_id == user_id and key["status"] == "active"
        ]
        if key_id:
            matches = [key for key in matches if key["key_id"] == key_id]
        return matches[-1] if matches else None

    def _execute_recipient_key_registration(
        self,
        *,
        recipient_key_lock_key: str,
        mutation_sql: str,
        params: dict,
    ) -> dict | None:
        assert recipient_key_lock_key == (f"one-location-recipient-key:{params['user_id']}")
        assert "revoked_grants AS" in mutation_sql
        user_id = params["user_id"]
        key_id = params["key_id"]
        now = datetime.now(timezone.utc)
        incoming_public_key = json.loads(params["public_key_jwk"])
        existing = self.keys.get((user_id, key_id))
        if existing is not None and existing.get("public_key_jwk") != incoming_public_key:
            return None
        for (key_user_id, existing_key_id), existing in self.keys.items():
            if (
                key_user_id == user_id
                and existing_key_id != key_id
                and existing["status"] == "active"
            ):
                existing["status"] = "rotated"
        for grant in self.grants.values():
            if (
                grant["recipient_user_id"] == user_id
                and grant["recipient_key_id"] != key_id
                and grant["status"] == "active"
            ):
                grant["status"] = "revoked"
                grant["revoked_at"] = now
                grant["updated_at"] = now
        new_blob = (
            json.loads(params["encrypted_private_key_jwk"])
            if params.get("encrypted_private_key_jwk")
            else None
        )
        existing = self.keys.get((user_id, key_id))
        if new_blob is None and existing is not None:
            new_blob = existing.get("encrypted_private_key_jwk")
        row = {
            "user_id": user_id,
            "key_id": key_id,
            "public_key_jwk": incoming_public_key,
            "algorithm": params["algorithm"],
            "status": "active",
            "encrypted_private_key_jwk": new_blob,
            "created_at": existing.get("created_at", now) if existing else now,
            "key_created_at": existing.get("created_at", now) if existing else now,
            "phone_verified": True,
        }
        self.keys[(user_id, key_id)] = row
        return row

    def _identity_key_row(
        self,
        user_id: str,
        key_id: str | None = None,
        *,
        require_phone_verified: bool = True,
    ) -> dict | None:
        identity = self.identities.get(user_id)
        key = self._active_key(user_id, key_id)
        if not identity or (require_phone_verified and not identity["phone_verified"]) or not key:
            return None
        return {
            **identity,
            "key_id": key["key_id"],
            "public_key_jwk": key["public_key_jwk"],
            "algorithm": key["algorithm"],
            "key_created_at": key["created_at"],
        }

    def _grant_row(self, grant: dict) -> dict:
        recipient = self.identities.get(grant["recipient_user_id"], {})
        return {
            **grant,
            "recipient_display_name": recipient.get("display_name"),
            "recipient_phone_number": recipient.get("phone_number"),
            "recipient_key_active": bool(
                self._active_key(
                    grant["recipient_user_id"],
                    grant["recipient_key_id"],
                )
            ),
        }

    def _execute_many(self, sql: str, params: dict | None = None) -> list[dict]:
        params = params or {}
        if "FROM one_location_sms_contacts sms" in sql:
            owner = params.get("owner_user_id") or params.get("user_id")
            active_connected_ids = {
                (
                    connection["user_b_id"]
                    if connection["user_a_id"] == owner
                    else connection["user_a_id"]
                )
                for connection in self.connections.values()
                if connection.get("status") == "active"
                and owner in {connection.get("user_a_id"), connection.get("user_b_id")}
            }
            return [
                {"contact_user_id": contact}
                for selected_owner, contact in sorted(self.sms_contacts)
                if selected_owner == owner and contact in active_connected_ids
            ]
        if "UPDATE one_location_share_grants" in sql and "expires_at <= NOW()" in sql:
            return []
        if "FROM one_location_recipient_keys" in sql and "encrypted_private_key_jwk" in sql:
            # list_state's own-key lookup (myRecipientKey).
            user_id = params.get("user_id")
            rows = [
                key
                for (key_user_id, _), key in self.keys.items()
                if key_user_id == user_id and key.get("status") == "active"
            ]
            rows.sort(key=lambda k: k.get("created_at"), reverse=True)
            return rows[:1]
        if "FROM actor_identity_cache a" in sql:
            owner = params["owner_user_id"]
            if "FROM connections c" in sql and "one_location_circle_memberships mine" in sql:
                eligible_ids = {
                    (
                        connection["user_b_id"]
                        if connection["user_a_id"] == owner
                        else connection["user_a_id"]
                    )
                    for connection in self.connections.values()
                    if connection.get("status") == "active"
                    and owner
                    in {
                        connection.get("user_a_id"),
                        connection.get("user_b_id"),
                    }
                }
                owner_circle_ids = {
                    circle_id
                    for circle_id, member_user_id in self.named_circle_memberships
                    if member_user_id == owner
                }
                eligible_ids.update(
                    member_user_id
                    for circle_id, member_user_id in self.named_circle_memberships
                    if circle_id in owner_circle_ids and member_user_id != owner
                )
                rows = []
                for user_id in sorted(eligible_ids):
                    identity = self.identities.get(user_id)
                    if not identity:
                        continue
                    key = self._active_key(user_id)
                    rows.append(
                        {
                            **identity,
                            "key_id": key["key_id"] if key else None,
                            "public_key_jwk": (key["public_key_jwk"] if key else None),
                            "algorithm": key["algorithm"] if key else None,
                            "key_created_at": (key["created_at"] if key else None),
                        }
                    )
                return rows[: int(params.get("limit") or 50)]
            rows = []
            connected_ids = {
                connection["user_b_id"]
                if connection["user_a_id"] == owner
                else connection["user_a_id"]
                for connection in self.network_connections.values()
                if connection["status"] == "active"
                and owner in {connection["user_a_id"], connection["user_b_id"]}
            } | {
                tc["trusted_user_id"]
                for tc in self.trusted_connections.values()
                if tc.get("status") == "active" and tc.get("owner_user_id") == owner
            }
            marketplace_connected_ids = set()
            for relationship in self.professional_relationships:
                if str(relationship.get("status") or "") != "approved":
                    continue
                investor_id = str(relationship.get("investor_user_id") or "")
                ria_id = str(relationship.get("ria_user_id") or "")
                if owner == investor_id and ria_id:
                    marketplace_connected_ids.add(ria_id)
                elif owner == ria_id and investor_id:
                    marketplace_connected_ids.add(investor_id)
            for user_id, identity in self.identities.items():
                if user_id == owner:
                    continue
                network_connected = user_id in connected_ids
                if not network_connected:
                    eligible = identity["phone_verified"] or user_id in marketplace_connected_ids
                    if not eligible:
                        continue
                    profile = self.marketplace_profiles.get(user_id)
                    if profile is not None and profile.get("is_discoverable") is False:
                        continue
                key = self._active_key(user_id)
                rows.append(
                    {
                        **identity,
                        "key_id": key["key_id"] if key else None,
                        "public_key_jwk": key["public_key_jwk"] if key else None,
                        "algorithm": key["algorithm"] if key else None,
                        "key_created_at": key["created_at"] if key else None,
                    }
                )
            return rows
        if "FROM connections c" in sql and "one_location_recipient_keys" in sql:
            owner = params["owner_user_id"]
            connected_ids = {
                (conn["user_b_id"] if conn["user_a_id"] == owner else conn["user_a_id"])
                for conn in self.connections.values()
                if conn.get("status") == "active"
                and owner in {conn["user_a_id"], conn["user_b_id"]}
            }
            rows = []
            for user_id in sorted(connected_ids):
                identity = self.identities.get(user_id)
                if not identity:
                    continue
                key = self._active_key(user_id)
                rows.append(
                    {
                        **identity,
                        "key_id": key["key_id"] if key else None,
                        "public_key_jwk": key["public_key_jwk"] if key else None,
                        "algorithm": key["algorithm"] if key else None,
                        "key_created_at": key["created_at"] if key else None,
                    }
                )
            return rows

        if (
            "FROM one_location_share_grants" in sql
            and "owner_user_id = :owner_user_id OR recipient_user_id = :owner_user_id" in sql
        ):
            owner = params["owner_user_id"]
            return [
                grant
                for grant in sorted(
                    self.grants.values(),
                    key=lambda item: item["created_at"],
                    reverse=True,
                )
                if grant["owner_user_id"] == owner or grant["recipient_user_id"] == owner
            ][:100]
        if (
            "FROM one_location_access_requests" in sql
            and "owner_user_id = :owner_user_id OR requester_user_id = :owner_user_id" in sql
        ):
            owner = params["owner_user_id"]
            return [
                request
                for request in sorted(
                    self.requests.values(),
                    key=lambda item: item["requested_at"],
                    reverse=True,
                )
                if request["owner_user_id"] == owner or request["requester_user_id"] == owner
            ][:100]
        if "FROM one_location_referrals" in sql and "owner_user_id = :owner_user_id" in sql:
            owner = params["owner_user_id"]
            return [
                referral
                for referral in sorted(
                    self.referrals.values(),
                    key=lambda item: item["created_at"],
                    reverse=True,
                )
                if owner
                in {
                    referral["owner_user_id"],
                    referral["referring_user_id"],
                    referral["referred_user_id"],
                }
            ][:100]
        if "FROM consent_audit" in sql:
            owner = params["owner_user_id"]
            return [
                row
                for row in sorted(
                    self.consent_audit_rows,
                    key=lambda item: item["issued_at"],
                    reverse=True,
                )
                if row.get("user_id") == owner or row.get("agent_id") == owner
            ][:100]
        if (
            "FROM advisor_investor_relationships rel" in sql
            and "LEFT JOIN relationship_share_grants share" in sql
        ):
            owner = params["owner_user_id"]
            return [
                row
                for row in self.professional_relationships
                if row.get("investor_user_id") == owner or row.get("ria_user_id") == owner
            ][:100]
        if "FROM advisor_investor_relationships rel" in sql:
            return self.professional_relationships[:500]
        if "FROM ria_profiles owner_rp" in sql:
            owner = params["owner_user_id"]
            return [
                row for row in self.organization_memberships if row.get("owner_user_id") == owner
            ][:100]
        if "FROM marketplace_public_profiles" in sql:
            return [
                profile
                for profile in sorted(
                    self.marketplace_profiles.values(),
                    key=lambda item: item["updated_at"],
                    reverse=True,
                )
                if profile.get("is_discoverable")
            ][:200]
        if "FROM runtime_persona_state" in sql:
            owner = params["owner_user_id"]
            return [
                state
                for state in sorted(
                    self.persona_states.values(),
                    key=lambda item: item["updated_at"],
                    reverse=True,
                )
                if state.get("user_id") != owner
            ][:200]
        if "FROM one_location_public_invites" in sql:
            return [
                invite
                for invite in sorted(
                    self.public_invites.values(),
                    key=lambda item: item["created_at"],
                    reverse=True,
                )
                if invite["owner_user_id"] == params["user_id"]
            ][:20]
        if "FROM one_location_circle_invites" in sql:
            return [
                invite
                for invite in sorted(
                    self.circle_invites.values(),
                    key=lambda item: item["created_at"],
                    reverse=True,
                )
                if invite["owner_user_id"] == params["user_id"]
                or invite.get("claimed_by_user_id") == params["user_id"]
            ][:20]
        if "FROM trusted_connections" in sql:
            # Serves both list_state (network_connections) and
            # _add_one_network_signals: active edges owned by the caller.
            owner = params.get("owner_user_id") or params.get("user_id")
            return [
                tc
                for tc in sorted(
                    self.trusted_connections.values(),
                    key=lambda item: item.get("created_at") or "",
                    reverse=True,
                )
                if tc.get("status") == "active" and tc.get("owner_user_id") == owner
            ][:200]
        if "FROM one_location_public_invite_submissions submission" in sql:
            rows = []
            for submission in sorted(
                self.public_submissions.values(),
                key=lambda item: item["submitted_at"],
                reverse=True,
            ):
                if (
                    submission["owner_user_id"] == params["user_id"]
                    or submission.get("matched_user_id") == params["user_id"]
                ):
                    request = self.requests.get(submission.get("request_id") or "")
                    rows.append(
                        {**submission, "request_status": request.get("status") if request else None}
                    )
            return rows[:50]
        if "FROM one_location_events e" in sql:
            user_id = params["user_id"]
            since_at = params.get("since_at")
            event_types = set(params.get("event_types") or [])
            rows = []
            for event in sorted(
                self.events.values(),
                key=lambda item: item["created_at"],
                reverse=True,
            ):
                if event_types and event.get("event_type") not in event_types:
                    continue
                if since_at and event.get("created_at") and event["created_at"] < since_at:
                    continue
                if user_id not in {
                    event.get("owner_user_id"),
                    event.get("actor_user_id"),
                    event.get("recipient_user_id"),
                }:
                    continue
                owner = self.identities.get(event.get("owner_user_id") or "", {})
                actor = self.identities.get(event.get("actor_user_id") or "", {})
                recipient = self.identities.get(event.get("recipient_user_id") or "", {})
                metadata = event.get("metadata") or {}
                submission = self.public_submissions.get(metadata.get("submission_id") or "")
                rows.append(
                    {
                        **event,
                        "owner_display_name": owner.get("display_name"),
                        "actor_display_name": actor.get("display_name"),
                        "recipient_display_name": recipient.get("display_name"),
                        "visitor_display_name": (submission or {}).get("visitor_display_name"),
                    }
                )
            return rows[: params.get("limit", 40)]
        if "UPDATE one_location_share_grants" in sql and "status = 'revoked'" in sql:
            revoked = []
            for grant in self.grants.values():
                if (
                    grant["owner_user_id"] == params["owner_user_id"]
                    and grant["recipient_user_id"] == params["recipient_user_id"]
                    and grant["status"] == "active"
                ):
                    grant["status"] = "revoked"
                    revoked.append({"id": grant["id"]})
            return revoked
        raise AssertionError(f"unexpected execute_many SQL: {sql}")

    def _execute_one(self, sql: str, params: dict | None = None) -> dict | None:
        params = params or {}
        if "AS active_connection" in sql and "AS eligible_circle_id" in sql:
            owner = str(params.get("owner_user_id") or "")
            other = str(params.get("other_user_id") or "")
            source_circle_id = params.get("source_circle_id")
            active_connection = any(
                connection.get("status") == "active"
                and {owner, other}
                == {
                    connection.get("user_a_id"),
                    connection.get("user_b_id"),
                }
                and any(
                    origin.get("connection_id") == connection.get("id")
                    and origin.get("status") == "active"
                    and origin.get("origin_kind") != "named_circle"
                    for origin in self.connection_origins.values()
                )
                for connection in self.connections.values()
            )
            shared_circle_ids = sorted(
                circle_id
                for circle_id, member_user_id in self.named_circle_memberships
                if member_user_id == owner
                and (circle_id, other) in self.named_circle_memberships
                and (source_circle_id is None or circle_id == source_circle_id)
            )
            return {
                "active_connection": active_connection and source_circle_id is None,
                "eligible_circle_id": (shared_circle_ids[0] if shared_circle_ids else None),
            }
        if "SELECT 1" in sql and "FROM one_location_sms_contacts" in sql:
            pair = (params["owner_user_id"], params["contact_user_id"])
            return {"exists": 1} if pair in self.sms_contacts else None
        if "INSERT INTO one_location_sms_contacts" in sql:
            pair = (params["owner_user_id"], params["contact_user_id"])
            self.sms_contacts.add(pair)
            return {"contact_user_id": params["contact_user_id"]}
        if "DELETE FROM one_location_sms_contacts" in sql:
            pair = (params["owner_user_id"], params["contact_user_id"])
            existed = pair in self.sms_contacts
            self.sms_contacts.discard(pair)
            return {"contact_user_id": params["contact_user_id"]} if existed else None
        if "SELECT 1" in sql and "FROM connections" in sql and "status = 'active'" in sql:
            a = params.get("a")
            b = params.get("b")
            for conn in self.connections.values():
                if conn.get("status") != "active":
                    continue
                pair = {conn["user_a_id"], conn["user_b_id"]}
                if pair == {a, b} and any(
                    origin.get("connection_id") == conn.get("id")
                    and origin.get("status") == "active"
                    and origin.get("origin_kind") != "named_circle"
                    for origin in self.connection_origins.values()
                ):
                    return {"exists": 1}
            return None
        if "WITH stale_grants AS" in sql and "deleted_grants" in sql:
            hours = float(params.get("hours") or 12)
            user_id = params.get("user_id")
            cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)

            def in_user_scope(row: dict, fields: tuple[str, ...]) -> bool:
                if not user_id:
                    return True
                return any(row.get(field) == user_id for field in fields)

            stale_grant_ids = {
                grant_id
                for grant_id, grant in self.grants.items()
                if in_user_scope(grant, ("owner_user_id", "recipient_user_id"))
                and (
                    (
                        grant["status"] == "expired"
                        and grant.get("expires_at")
                        and grant["expires_at"] <= cutoff
                    )
                    or (
                        grant["status"] == "revoked"
                        and (
                            grant.get("revoked_at")
                            or grant.get("updated_at")
                            or grant.get("expires_at")
                            or grant.get("created_at")
                        )
                        <= cutoff
                    )
                )
            }
            stale_request_ids = {
                request_id
                for request_id, request in self.requests.items()
                if in_user_scope(
                    request,
                    ("owner_user_id", "requester_user_id", "referred_by_user_id"),
                )
                and (
                    (
                        request["status"] in {"approved", "denied", "cancelled"}
                        and (request.get("resolved_at") or request.get("requested_at")) <= cutoff
                    )
                    or request.get("approved_grant_id") in stale_grant_ids
                )
            }
            stale_referral_ids = {
                referral_id
                for referral_id, referral in self.referrals.items()
                if in_user_scope(
                    referral,
                    ("owner_user_id", "referring_user_id", "referred_user_id"),
                )
                and (
                    (
                        referral["status"] in {"approved", "denied", "cancelled"}
                        and (referral.get("resolved_at") or referral.get("created_at")) <= cutoff
                    )
                    or referral.get("grant_id") in stale_grant_ids
                    or referral.get("request_id") in stale_request_ids
                )
            }
            stale_public_invite_ids = {
                invite_id
                for invite_id, invite in self.public_invites.items()
                if in_user_scope(invite, ("owner_user_id",))
                and (
                    invite["status"] == "expired"
                    and invite.get("expires_at")
                    and invite["expires_at"] <= cutoff
                    or invite["status"] == "revoked"
                    and (
                        invite.get("revoked_at")
                        or invite.get("updated_at")
                        or invite.get("expires_at")
                        or invite.get("created_at")
                    )
                    <= cutoff
                )
            }
            stale_public_submission_ids = {
                submission_id
                for submission_id, submission in self.public_submissions.items()
                if in_user_scope(submission, ("owner_user_id", "matched_user_id"))
                and (
                    (
                        submission["status"] in {"approved", "denied", "cancelled"}
                        and (submission.get("resolved_at") or submission.get("submitted_at"))
                        <= cutoff
                    )
                    or submission.get("invite_id") in stale_public_invite_ids
                    or submission.get("request_id") in stale_request_ids
                )
            }
            stale_circle_invite_ids = {
                invite_id
                for invite_id, invite in self.circle_invites.items()
                if in_user_scope(invite, ("owner_user_id", "claimed_by_user_id"))
                and (
                    invite["status"] in {"claimed", "expired", "revoked"}
                    and (
                        invite.get("revoked_at")
                        or invite.get("claimed_at")
                        or invite.get("updated_at")
                        or invite.get("expires_at")
                        or invite.get("created_at")
                    )
                    <= cutoff
                )
            }

            deleted_events = 0
            for event_id, event in list(self.events.items()):
                metadata = event.get("metadata") or {}
                if (
                    event.get("grant_id") in stale_grant_ids
                    or event.get("request_id") in stale_request_ids
                    or event.get("referral_id") in stale_referral_ids
                    or metadata.get("invite_id") in stale_public_invite_ids
                    or metadata.get("invite_id") in stale_circle_invite_ids
                    or metadata.get("submission_id") in stale_public_submission_ids
                ):
                    deleted_events += 1
                    del self.events[event_id]
            deleted_public_submissions = 0
            for submission_id in list(stale_public_submission_ids):
                if submission_id in self.public_submissions:
                    deleted_public_submissions += 1
                    del self.public_submissions[submission_id]
            deleted_envelopes = 0
            for envelope_id, envelope in list(self.envelopes.items()):
                if envelope.get("grant_id") in stale_grant_ids:
                    deleted_envelopes += 1
                    del self.envelopes[envelope_id]
            deleted_referrals = 0
            for referral_id, referral in list(self.referrals.items()):
                if (
                    referral_id in stale_referral_ids
                    or referral.get("grant_id") in stale_grant_ids
                    or referral.get("request_id") in stale_request_ids
                ):
                    deleted_referrals += 1
                    del self.referrals[referral_id]
            deleted_requests = 0
            for request_id in list(stale_request_ids):
                if request_id in self.requests:
                    deleted_requests += 1
                    del self.requests[request_id]
            deleted_grants = 0
            for grant_id in list(stale_grant_ids):
                if grant_id in self.grants:
                    deleted_grants += 1
                    del self.grants[grant_id]
            deleted_public_invites = 0
            for invite_id in list(stale_public_invite_ids):
                if invite_id in self.public_invites:
                    deleted_public_invites += 1
                    del self.public_invites[invite_id]
            deleted_circle_invites = 0
            for invite_id in list(stale_circle_invite_ids):
                if invite_id in self.circle_invites:
                    deleted_circle_invites += 1
                    del self.circle_invites[invite_id]
            return {
                "deleted_grants": deleted_grants,
                "deleted_envelopes": deleted_envelopes,
                "deleted_requests": deleted_requests,
                "deleted_referrals": deleted_referrals,
                "deleted_public_invites": deleted_public_invites,
                "deleted_circle_invites": deleted_circle_invites,
                "deleted_public_submissions": deleted_public_submissions,
                "deleted_events": deleted_events,
            }
        if "INSERT INTO one_location_events" in sql:
            event_id = str(uuid.uuid4())
            self.events[event_id] = {
                "id": event_id,
                "owner_user_id": params.get("owner_user_id"),
                "actor_user_id": params.get("actor_user_id"),
                "recipient_user_id": params.get("recipient_user_id"),
                "grant_id": params.get("grant_id"),
                "envelope_id": params.get("envelope_id"),
                "request_id": params.get("request_id"),
                "referral_id": params.get("referral_id"),
                "event_type": params.get("event_type"),
                "metadata": json.loads(params.get("metadata_json") or "{}"),
                "created_at": datetime.now(timezone.utc),
            }
            return None
        if "COUNT(*)::int AS active_share_count" in sql:
            return {
                "active_share_count": sum(
                    1
                    for grant in self.grants.values()
                    if grant["owner_user_id"] == params["user_id"] and grant["status"] == "active"
                )
            }
        if "UPDATE one_location_recipient_keys" in sql:
            return None
        if "FROM actor_identity_cache" in sql and "regexp_replace" in sql:
            phone_digits = params["phone_digits"]
            local_digits = params["local_digits"]
            for identity in self.identities.values():
                digits = "".join(ch for ch in identity["phone_number"] if ch.isdigit())
                if identity["phone_verified"] and (
                    digits == phone_digits or digits.endswith(local_digits)
                ):
                    return identity
            return None
        if "FROM actor_identity_cache" in sql and "WHERE user_id = :user_id" in sql:
            return self.identities.get(params["user_id"])
        if "INSERT INTO one_location_recipient_keys" in sql:
            user_id = params["user_id"]
            key_id = params["key_id"]
            new_blob = (
                json.loads(params["encrypted_private_key_jwk"])
                if params.get("encrypted_private_key_jwk")
                else None
            )
            # Mirror the real ON CONFLICT COALESCE: keep an existing blob when the
            # re-registration doesn't supply a new one.
            existing = self.keys.get((user_id, key_id))
            if new_blob is None and existing is not None:
                new_blob = existing.get("encrypted_private_key_jwk")
            row = {
                "user_id": user_id,
                "key_id": key_id,
                "public_key_jwk": json.loads(params["public_key_jwk"]),
                "algorithm": params["algorithm"],
                "status": "active",
                "encrypted_private_key_jwk": new_blob,
                "created_at": datetime.now(timezone.utc),
                "key_created_at": datetime.now(timezone.utc),
                "phone_verified": True,
            }
            self.keys[(user_id, key_id)] = row
            return row
        if "JOIN one_location_recipient_keys k" in sql:
            return self._identity_key_row(
                params["recipient_user_id"],
                params.get("recipient_key_id"),
                require_phone_verified=bool(params.get("require_phone_verified", True)),
            )
        if "INSERT INTO one_location_share_grants" in sql:
            grant_id = str(uuid.uuid4())
            row = {
                "id": grant_id,
                "owner_user_id": params["owner_user_id"],
                "recipient_user_id": params["recipient_user_id"],
                "recipient_key_id": params["recipient_key_id"],
                "status": "active",
                "consent_scope": "cap.location.live.view",
                "capability_scopes": params["capability_scopes"],
                "duration_hours": params["duration_hours"],
                "expires_at": params["expires_at"],
                "created_at": datetime.now(timezone.utc),
                "updated_at": datetime.now(timezone.utc),
                "revoked_at": None,
                "latest_envelope_id": None,
                "source_circle_id": params.get("source_circle_id"),
                "metadata": json.loads(params.get("metadata_json") or "{}"),
                "recipient_display_name": params.get("recipient_display_name"),
                "recipient_phone_number": params.get("recipient_phone_number"),
            }
            self.grants[grant_id] = row
            return row
        if "FROM one_location_share_grants" in sql and "owner_user_id = :owner_user_id" in sql:
            grant = self.grants.get(params["grant_id"])
            if (
                "recipient_user_id = :owner_user_id" in sql
                and grant
                and params["owner_user_id"] in {grant["owner_user_id"], grant["recipient_user_id"]}
            ):
                return grant
            if grant and grant["owner_user_id"] == params["owner_user_id"]:
                return grant
            return None
        if "INSERT INTO one_location_envelopes" in sql:
            envelope_id = str(uuid.uuid4())
            row = {
                "id": envelope_id,
                "grant_id": params["grant_id"],
                "owner_user_id": params["owner_user_id"],
                "recipient_user_id": params["recipient_user_id"],
                "recipient_key_id": params["recipient_key_id"],
                "algorithm": params["algorithm"],
                "ciphertext": params["ciphertext"],
                "iv": params["iv"],
                "sender_ephemeral_public_key_jwk": json.loads(params["sender_key"]),
                "captured_at": params["captured_at"],
                "source_platform": params["source_platform"],
                "created_at": datetime.now(timezone.utc),
                "metadata": json.loads(params["metadata_json"]),
            }
            self.envelopes[envelope_id] = row
            return row
        if "SET latest_envelope_id" in sql:
            self.grants[params["grant_id"]]["latest_envelope_id"] = params["envelope_id"]
            return None
        if "FROM one_location_share_grants g" in sql:
            grant = self.grants.get(params["grant_id"])
            if grant and grant["recipient_user_id"] == params["recipient_user_id"]:
                return self._grant_row(grant)
            return None
        if "FROM one_location_envelopes" in sql:
            matches = [
                envelope
                for envelope in self.envelopes.values()
                if envelope["grant_id"] == params["grant_id"]
                and envelope["recipient_user_id"] == params["recipient_user_id"]
            ]
            return matches[-1] if matches else None
        if (
            "FROM one_location_access_requests" in sql
            and "requester_user_id = :requester_user_id" in sql
        ):
            for request in sorted(
                self.requests.values(),
                key=lambda item: item["requested_at"],
                reverse=True,
            ):
                if (
                    request["owner_user_id"] == params["owner_user_id"]
                    and request["requester_user_id"] == params["requester_user_id"]
                    and request["status"] == "pending"
                    and request.get("referred_by_user_id") == params.get("referred_by_user_id")
                ):
                    return request
            return None
        if "INSERT INTO one_location_access_requests" in sql:
            request_id = str(uuid.uuid4())
            row = {
                "id": request_id,
                "owner_user_id": params["owner_user_id"],
                "requester_user_id": params["requester_user_id"],
                "referred_by_user_id": params.get("referred_by_user_id"),
                "status": "pending",
                "message": params.get("message"),
                "requested_at": datetime.now(timezone.utc),
                "resolved_at": None,
                "approved_grant_id": None,
            }
            self.requests[request_id] = row
            return row
        if "UPDATE one_location_access_requests" in sql and "SET message = :message" in sql:
            request = self.requests.get(params["request_id"])
            if request and request["status"] == "pending":
                request["message"] = params["message"]
                request["requested_at"] = datetime.now(timezone.utc)
                return request
            return None
        if "FROM one_location_access_requests" in sql:
            request = self.requests.get(params["request_id"])
            if (
                request
                and request["owner_user_id"] == params["owner_user_id"]
                and request["status"] == "pending"
            ):
                return request
            return None
        if "SET status = 'approved'" in sql:
            request = self.requests[params["request_id"]]
            request["status"] = "approved"
            request["approved_grant_id"] = params["grant_id"]
            request["resolved_at"] = datetime.now(timezone.utc)
            return request
        if (
            "WHERE id = CAST(:grant_id AS UUID)" in sql
            and "recipient_user_id = :referring_user_id" in sql
        ):
            grant = self.grants.get(params["grant_id"])
            if (
                grant
                and grant["recipient_user_id"] == params["referring_user_id"]
                and grant["status"] == "active"
                and grant["expires_at"] > datetime.now(timezone.utc)
            ):
                return grant
            return None
        if "INSERT INTO one_location_referrals" in sql:
            referral_id = str(uuid.uuid4())
            row = {
                "id": referral_id,
                "grant_id": params["grant_id"],
                "owner_user_id": params["owner_user_id"],
                "referring_user_id": params["referring_user_id"],
                "referred_user_id": params["referred_user_id"],
                "request_id": params["request_id"],
                "status": "pending_owner_approval",
                "created_at": datetime.now(timezone.utc),
                "resolved_at": None,
            }
            self.referrals[referral_id] = row
            return row
        if "INSERT INTO one_location_public_invites" in sql:
            invite_id = str(uuid.uuid4())
            row = {
                "id": invite_id,
                "owner_user_id": params["owner_user_id"],
                "public_code_hash": params["public_code_hash"],
                "status": "active",
                "duration_hours": params["duration_hours"],
                "expires_at": params["expires_at"],
                "created_at": datetime.now(timezone.utc),
                "updated_at": datetime.now(timezone.utc),
                "revoked_at": None,
                "metadata": json.loads(params.get("metadata_json") or "{}"),
            }
            self.public_invites[invite_id] = row
            return row
        if "FROM one_location_public_invites i" in sql:
            for invite in self.public_invites.values():
                if invite["public_code_hash"] == params["public_code_hash"]:
                    owner = self.identities.get(invite["owner_user_id"], {})
                    return {
                        **invite,
                        "owner_display_name": owner.get("display_name"),
                        "owner_phone_number": owner.get("phone_number"),
                    }
            return None
        if "UPDATE one_location_public_invites" in sql and "status = 'expired'" in sql:
            invite = self.public_invites.get(params["invite_id"])
            if invite and invite["status"] == "active":
                invite["status"] = "expired"
                return invite
            return None
        if "COUNT(*)::int AS total_submissions" in sql:
            invite_submissions = [
                submission
                for submission in self.public_submissions.values()
                if submission["invite_id"] == params["invite_id"]
            ]
            phone_submissions = [
                submission
                for submission in invite_submissions
                if submission["visitor_phone_hash"] == params["visitor_phone_hash"]
            ]
            fingerprint = params.get("submitter_fingerprint_hash")
            fingerprint_submissions = [
                submission
                for submission in invite_submissions
                if fingerprint
                and (submission.get("metadata") or {}).get("submitter_fingerprint_hash")
                == fingerprint
            ]
            return {
                "total_submissions": len(invite_submissions),
                "phone_submissions": len(phone_submissions),
                "recent_phone_submissions": len(phone_submissions),
                "recent_fingerprint_submissions": len(fingerprint_submissions),
            }
        if "INSERT INTO one_location_public_invite_submissions" in sql:
            submission_id = str(uuid.uuid4())
            row = {
                "id": submission_id,
                "invite_id": params["invite_id"],
                "owner_user_id": params["owner_user_id"],
                "visitor_display_name": params["visitor_display_name"],
                "visitor_phone_hash": params["visitor_phone_hash"],
                "visitor_phone_last4": params["visitor_phone_last4"],
                "matched_user_id": params.get("matched_user_id"),
                "request_id": params.get("request_id"),
                "status": params["status"],
                "message": params.get("message"),
                "submitted_at": datetime.now(timezone.utc),
                "resolved_at": None,
                "metadata": json.loads(params.get("metadata_json") or "{}"),
            }
            self.public_submissions[submission_id] = row
            return row
        if "UPDATE one_location_public_invites" in sql and "status = 'revoked'" in sql:
            invite = self.public_invites.get(params["invite_id"])
            if (
                invite
                and invite["owner_user_id"] == params["owner_user_id"]
                and invite["status"] == "active"
            ):
                invite["status"] = "revoked"
                invite["revoked_at"] = datetime.now(timezone.utc)
                return invite
            return None
        if "INSERT INTO one_location_circle_invites" in sql:
            invite_id = str(uuid.uuid4())
            row = {
                "id": invite_id,
                "owner_user_id": params["owner_user_id"],
                "invite_code_hash": params["invite_code_hash"],
                "status": "active",
                "duration_hours": params["duration_hours"],
                "expires_at": params["expires_at"],
                "claimed_by_user_id": None,
                "request_id": None,
                "message": params.get("message"),
                "claimed_at": None,
                "created_at": datetime.now(timezone.utc),
                "updated_at": datetime.now(timezone.utc),
                "revoked_at": None,
                "metadata": json.loads(params.get("metadata_json") or "{}"),
            }
            self.circle_invites[invite_id] = row
            return row
        if "FROM one_location_circle_invites i" in sql:
            for invite in self.circle_invites.values():
                if invite["invite_code_hash"] == params["invite_code_hash"]:
                    return invite
            return None
        if "UPDATE one_location_circle_invites" in sql and "status = 'expired'" in sql:
            invite = self.circle_invites.get(params["invite_id"])
            if invite and invite["status"] == "active":
                invite["status"] = "expired"
                return invite
            return None
        if "UPDATE one_location_circle_invites" in sql and "status = 'claimed'" in sql:
            invite = self.circle_invites.get(params["invite_id"])
            if (
                invite
                and invite["owner_user_id"] == params["owner_user_id"]
                and invite["status"] == "active"
            ):
                invite["status"] = "claimed"
                invite["claimed_by_user_id"] = params["claimant_user_id"]
                invite["claimed_at"] = datetime.now(timezone.utc)
                return invite
            return None
        if "UPDATE one_location_circle_invites" in sql and "status = 'revoked'" in sql:
            invite = self.circle_invites.get(params["invite_id"])
            if (
                invite
                and invite["owner_user_id"] == params["owner_user_id"]
                and invite["status"] == "active"
            ):
                invite["status"] = "revoked"
                invite["revoked_at"] = datetime.now(timezone.utc)
                return invite
            return None
        if "SET status = 'revoked'" in sql and "owner_user_id = :owner_user_id" in sql:
            grant = self.grants.get(params["grant_id"])
            if (
                grant
                and (
                    grant["owner_user_id"] == params["owner_user_id"]
                    or (
                        "recipient_user_id = :owner_user_id" in sql
                        and grant["recipient_user_id"] == params["owner_user_id"]
                    )
                )
                and grant["status"] == "active"
            ):
                grant["status"] = "revoked"
                grant["revoked_at"] = datetime.now(timezone.utc)
                return grant
            return None
        if "INSERT INTO trusted_connections" in sql:
            existing = next(
                (
                    tc
                    for tc in self.trusted_connections.values()
                    if tc["owner_user_id"] == params.get("owner_user_id")
                    and tc["trusted_user_id"] == params.get("trusted_user_id")
                ),
                None,
            )
            now = datetime.now(timezone.utc)
            if existing:
                existing.update(
                    {
                        "status": "active",
                        "updated_at": now,
                        "revoked_at": None,
                        "source": params.get("source", "circle_invite"),
                    }
                )
                return {
                    "id": existing["id"],
                    "owner_user_id": existing["owner_user_id"],
                    "trusted_user_id": existing["trusted_user_id"],
                    "status": existing["status"],
                    "created_at": existing.get("created_at"),
                    "updated_at": existing.get("updated_at"),
                    "revoked_at": existing.get("revoked_at"),
                }
            tc_id = str(uuid.uuid4())
            row = {
                "id": tc_id,
                "owner_user_id": params.get("owner_user_id"),
                "trusted_user_id": params.get("trusted_user_id"),
                "status": "active",
                "source": "circle_invite",
                "created_at": now,
                "updated_at": now,
                "revoked_at": None,
                "metadata": json.loads(params.get("metadata_json") or "{}"),
            }
            self.trusted_connections[tc_id] = row
            return {
                "id": tc_id,
                "owner_user_id": row["owner_user_id"],
                "trusted_user_id": row["trusted_user_id"],
                "status": row["status"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "revoked_at": row["revoked_at"],
            }
        raise AssertionError(f"unexpected execute_one SQL: {sql}")


def encrypted_envelope(key_id: str, ciphertext: str = "ciphertext") -> dict:
    return {
        "algorithm": "ECDH-P256-AES256-GCM",
        "recipientKeyId": key_id,
        "ciphertext": ciphertext,
        "iv": "iv",
        "senderEphemeralPublicKeyJwk": {"kty": "EC"},
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "sourcePlatform": "web",
        "metadata": {"plaintext": False},
    }


def test_kai_circle_recipient_directory_uses_safe_recommendation_signals() -> None:
    service = FourUserMemoryService()
    now = datetime.now(timezone.utc)
    user_a = "user_a"
    user_b = "user_b"
    user_c = "user_c"
    user_d = "user_d"
    user_e = "user_e"
    user_f = "user_f"
    user_g = "user_g"
    service.identities[user_e] = {
        "user_id": user_e,
        "display_name": "User E",
        "phone_number": "+15550100005",
        "phone_verified": True,
    }
    service.identities[user_f] = {
        "user_id": user_f,
        "display_name": "User F",
        "phone_number": "+15550100006",
        "phone_verified": True,
    }
    service.identities[user_g] = {
        "user_id": user_g,
        "display_name": "User G",
        "phone_number": "+15550100007",
        "phone_verified": True,
    }

    for user_id in (user_a, user_b, user_c, user_d, user_f, user_g):
        service.register_recipient_key(
            user_id=user_id,
            key_id=f"key-{user_id}",
            public_key_jwk={"kty": "EC", "crv": "P-256", "x": user_id, "y": user_id},
        )

    for peer in (user_b, user_c, user_d, user_f, user_g):
        service._seed_connection(user_a, peer)

    service.create_grant(
        owner_user_id=user_a,
        recipient_user_id=user_b,
        recipient_key_id=f"key-{user_b}",
        duration_hours=1,
    )
    service.request_access(
        owner_user_id=user_a,
        requester_user_id=user_c,
        message="Can you share your location?",
    )
    service.professional_relationships.append(
        {
            "investor_user_id": user_a,
            "ria_user_id": user_d,
            "status": "discovered",
            "granted_scope": None,
            "consent_granted_at": None,
            "created_at": now - timedelta(days=3),
            "updated_at": now - timedelta(days=2),
            "ria_display_name": "User D",
            "ria_verification_status": "verified",
            "relationship_share_status": None,
            "relationship_share_granted_at": None,
        }
    )
    service.professional_relationships.append(
        {
            "investor_user_id": user_g,
            "ria_user_id": user_d,
            "status": "approved",
            "granted_scope": "attr.financial.*",
            "consent_granted_at": now - timedelta(days=2),
            "created_at": now - timedelta(days=3),
            "updated_at": now - timedelta(days=1),
            "ria_display_name": "User D",
            "ria_verification_status": "verified",
            "relationship_share_status": "active",
            "relationship_share_granted_at": now - timedelta(days=1),
        }
    )
    service.organization_memberships.append(
        {
            "owner_user_id": user_a,
            "peer_user_id": user_g,
            "firm_name": "Hushh Advisors",
            "peer_role_title": "Advisor partner",
            "owner_membership_updated_at": now - timedelta(days=2),
            "peer_membership_updated_at": now - timedelta(days=1),
        }
    )
    service.consent_audit_rows.append(
        {
            "user_id": user_a,
            "agent_id": user_g,
            "action": "CONSENT_GRANTED",
            "issued_at": now - timedelta(hours=3),
        }
    )
    service.marketplace_profiles[user_a] = {
        "user_id": user_a,
        "profile_type": "investor",
        "headline": "Long-term family planning",
        "strategy_summary": "Public owner profile",
        "verification_badge": "Verified investor",
        "metadata": {"categories": ["retirement", "tax"], "location": "private"},
        "is_discoverable": True,
        "created_at": now - timedelta(days=7),
        "updated_at": now - timedelta(days=1),
    }
    service.marketplace_profiles[user_d] = {
        "user_id": user_d,
        "profile_type": "ria",
        "headline": "Retirement planning specialist",
        "strategy_summary": "Public advisor profile",
        "verification_badge": "Verified advisor",
        "metadata": {"categories": ["estate"]},
        "is_discoverable": True,
        "created_at": now - timedelta(days=4),
        "updated_at": now - timedelta(days=1),
    }
    service.marketplace_profiles[user_f] = {
        "user_id": user_f,
        "profile_type": "investor",
        "headline": "Family tax planning",
        "strategy_summary": "Public investor profile",
        "verification_badge": "Verified profile",
        "metadata": {"categories": ["retirement", "family"], "address": "private"},
        "is_discoverable": True,
        "created_at": now - timedelta(days=4),
        "updated_at": now,
    }
    service.persona_states[user_d] = {
        "user_id": user_d,
        "last_active_persona": "ria",
        "updated_at": now,
    }

    recipients = service.list_verified_recipients(owner_user_id=user_a)
    by_id = {recipient["userId"]: recipient for recipient in recipients}

    assert by_id[user_b]["recommendationCategory"] == "trusted_circle"
    assert by_id[user_b]["trustLevel"] == "high"
    assert any(
        reason["code"] == "active_location_share"
        for reason in by_id[user_b]["recommendationReasons"]
    )
    assert by_id[user_c]["recommendationCategory"] == "needs_action"
    assert by_id[user_c]["recommendationTier"] == "needs_action"
    assert any(
        reason["code"] == "pending_location_request"
        for reason in by_id[user_c]["recommendationReasons"]
    )
    assert by_id[user_d]["recommendationCategory"] == "professional_network"
    assert by_id[user_d]["relationshipType"] == "Advisor relationship"
    assert by_id[user_d]["profileHeadline"] == "Retirement planning specialist"
    assert by_id[user_f]["recommendationCategory"] == "professional_network"
    assert any(
        reason["code"] == "shared_marketplace_categories"
        for reason in by_id[user_f]["recommendationReasons"]
    )
    assert by_id[user_g]["recommendationCategory"] == "trusted_circle"
    assert any(
        reason["code"] == "prior_consent_relationship"
        for reason in by_id[user_g]["recommendationReasons"]
    )
    assert any(
        reason["code"] == "organization_membership"
        for reason in by_id[user_g]["recommendationReasons"]
    )
    assert any(
        reason["code"] == "mutual_kai_relationship"
        for reason in by_id[user_g]["recommendationReasons"]
    )
    # user_e has no active connection with user_a, so does not appear in the
    # connections-only directory.
    assert user_e not in by_id

    ranks = [recipient["recommendationRank"] for recipient in recipients]
    assert ranks == sorted(ranks)
    encoded = json.dumps(recipients, default=str)
    assert "latitude" not in encoded
    assert "longitude" not in encoded
    assert "15550100002" not in encoded
    assert "Can you share your location?" not in encoded
    assert "attr.financial" not in encoded
    assert "private" not in encoded


def test_directory_candidates_includes_phone_verified_without_connection() -> None:
    # Discovery is broad: a phone-verified user with NO connection is a candidate
    # (this is what /connect search relies on to find new people).
    service = FourUserMemoryService()
    candidate_ids = {c["userId"] for c in service.list_directory_candidates(owner_user_id="user_a")}
    assert "user_b" in candidate_ids
    assert "user_c" in candidate_ids


def test_directory_candidates_excludes_marketplace_hidden() -> None:
    service = FourUserMemoryService()
    service.marketplace_profiles["user_b"] = {
        "user_id": "user_b",
        "profile_type": "investor",
        "is_discoverable": False,
        "updated_at": datetime.now(timezone.utc),
    }
    candidate_ids = {c["userId"] for c in service.list_directory_candidates(owner_user_id="user_a")}
    assert "user_b" not in candidate_ids
    assert "user_c" in candidate_ids


def test_directory_candidates_query_targets_actor_identity_cache() -> None:
    service = RecipientDirectoryProbe()
    assert service.list_directory_candidates(owner_user_id="owner") == []
    assert "FROM actor_identity_cache a" in service.sql
    assert "a.phone_verified = TRUE" in service.sql
    assert "a.user_id <> :owner_user_id" in service.sql


def test_directory_candidate_search_filters_before_pagination(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = RecipientDirectoryProbe()
    monkeypatch.setattr(
        service,
        "_apply_kai_circle_recommendations",
        lambda **kwargs: kwargs["recipients"],
    )

    result = service.search_directory_candidates(
        owner_user_id="owner",
        query="cara",
        page=3,
        limit=20,
    )

    assert result == {"items": [], "page": 3, "hasMore": False}
    assert "LOWER(COALESCE(a.display_name, '')) LIKE '%' || :query || '%'" in service.sql
    assert "LIMIT :fetch_limit OFFSET :offset" in service.sql
    assert service.params == {
        "owner_user_id": "owner",
        "candidate_user_id": None,
        "query": "cara",
        "fetch_limit": 21,
        "offset": 40,
    }


def test_terminal_location_work_is_deleted_after_twelve_hour_retention() -> None:
    service = FourUserMemoryService()
    now = datetime.now(timezone.utc)
    old_grant_id = str(uuid.uuid4())
    active_grant_id = str(uuid.uuid4())
    old_request_id = str(uuid.uuid4())
    old_referral_id = str(uuid.uuid4())
    old_envelope_id = str(uuid.uuid4())
    active_envelope_id = str(uuid.uuid4())
    old_invite_id = str(uuid.uuid4())
    old_submission_id = str(uuid.uuid4())
    current_invite_id = str(uuid.uuid4())
    current_submission_id = str(uuid.uuid4())
    old_event_id = str(uuid.uuid4())
    active_event_id = str(uuid.uuid4())

    service.grants[old_grant_id] = {
        "id": old_grant_id,
        "owner_user_id": "user_a",
        "recipient_user_id": "user_b",
        "recipient_key_id": "key-user_b",
        "status": "expired",
        "consent_scope": "cap.location.live.view",
        "capability_scopes": json.dumps(["cap.location.live.view"]),
        "duration_hours": 1,
        "expires_at": now - timedelta(hours=13),
        "created_at": now - timedelta(hours=14),
        "updated_at": now - timedelta(hours=13),
        "revoked_at": None,
        "latest_envelope_id": old_envelope_id,
    }
    service.grants[active_grant_id] = {
        **service.grants[old_grant_id],
        "id": active_grant_id,
        "status": "active",
        "expires_at": now + timedelta(hours=1),
        "latest_envelope_id": active_envelope_id,
    }
    service.envelopes[old_envelope_id] = {
        "id": old_envelope_id,
        "grant_id": old_grant_id,
        "owner_user_id": "user_a",
        "recipient_user_id": "user_b",
        "recipient_key_id": "key-user_b",
    }
    service.envelopes[active_envelope_id] = {
        "id": active_envelope_id,
        "grant_id": active_grant_id,
        "owner_user_id": "user_a",
        "recipient_user_id": "user_b",
        "recipient_key_id": "key-user_b",
        "ciphertext": "current-ciphertext",
    }
    service.requests[old_request_id] = {
        "id": old_request_id,
        "owner_user_id": "user_a",
        "requester_user_id": "user_b",
        "referred_by_user_id": None,
        "status": "approved",
        "requested_at": now - timedelta(hours=14),
        "resolved_at": now - timedelta(hours=13),
        "approved_grant_id": old_grant_id,
    }
    service.referrals[old_referral_id] = {
        "id": old_referral_id,
        "grant_id": old_grant_id,
        "owner_user_id": "user_a",
        "referring_user_id": "user_b",
        "referred_user_id": "user_c",
        "request_id": old_request_id,
        "status": "denied",
        "created_at": now - timedelta(hours=14),
        "resolved_at": now - timedelta(hours=13),
    }
    service.public_invites[old_invite_id] = {
        "id": old_invite_id,
        "owner_user_id": "user_a",
        "public_code_hash": "old-hash",
        "status": "expired",
        "duration_hours": 1,
        "expires_at": now - timedelta(hours=13),
        "created_at": now - timedelta(hours=14),
        "updated_at": now - timedelta(hours=13),
        "revoked_at": None,
    }
    service.public_invites[current_invite_id] = {
        **service.public_invites[old_invite_id],
        "id": current_invite_id,
        "public_code_hash": "current-hash",
        "status": "active",
        "expires_at": now + timedelta(hours=1),
        "created_at": now,
        "updated_at": now,
    }
    service.public_submissions[old_submission_id] = {
        "id": old_submission_id,
        "invite_id": old_invite_id,
        "owner_user_id": "user_a",
        "visitor_display_name": "Old Visitor",
        "visitor_phone_hash": "old-phone-hash",
        "visitor_phone_last4": "0002",
        "matched_user_id": "user_b",
        "request_id": old_request_id,
        "status": "denied",
        "message": "old request",
        "submitted_at": now - timedelta(hours=14),
        "resolved_at": now - timedelta(hours=13),
        "metadata": {},
    }
    service.public_submissions[current_submission_id] = {
        **service.public_submissions[old_submission_id],
        "id": current_submission_id,
        "invite_id": current_invite_id,
        "request_id": None,
        "status": "pending_identity",
        "submitted_at": now,
        "resolved_at": None,
    }
    service.events[old_event_id] = {
        "id": old_event_id,
        "grant_id": old_grant_id,
        "request_id": old_request_id,
        "referral_id": old_referral_id,
        "event_type": "location_public_invite_submitted",
        "metadata": {"invite_id": old_invite_id, "submission_id": old_submission_id},
    }
    service.events[active_event_id] = {
        "id": active_event_id,
        "grant_id": active_grant_id,
        "request_id": None,
        "referral_id": None,
        "event_type": "location_envelope_updated",
        "metadata": {},
    }

    result = service.purge_terminal_work(older_than_hours=12)

    assert result["retention_hours"] == 12
    assert result["deleted_grants"] == 1
    assert result["deleted_envelopes"] == 1
    assert result["deleted_requests"] == 1
    assert result["deleted_referrals"] == 1
    assert result["deleted_public_invites"] == 1
    assert result["deleted_named_circle_codes"] == 0
    assert result["deleted_named_circle_member_invites"] == 0
    assert result["deleted_public_submissions"] == 1
    assert result["deleted_events"] == 1
    assert old_grant_id not in service.grants
    assert old_envelope_id not in service.envelopes
    assert old_request_id not in service.requests
    assert old_referral_id not in service.referrals
    assert old_invite_id not in service.public_invites
    assert old_submission_id not in service.public_submissions
    assert old_event_id not in service.events
    assert active_grant_id in service.grants
    assert active_envelope_id in service.envelopes
    assert service.envelopes[active_envelope_id]["ciphertext"] == "current-ciphertext"
    assert current_invite_id in service.public_invites
    assert current_submission_id in service.public_submissions
    assert active_event_id in service.events


class _TerminalPurgeSqlProbe(OneLocationAgentService):
    def __init__(self) -> None:
        self.sql = ""

    def _execute_one(self, sql: str, params: dict | None = None) -> dict | None:
        self.sql = sql
        return {}


def test_targeted_circle_member_invite_expiry_is_ordered_locked_and_bounded() -> None:
    service = _TerminalPurgeSqlProbe()

    service._purge_terminal_work(user_id="user_a", older_than_hours=12)

    candidate_start = service.sql.index("expired_named_circle_member_invite_candidates AS")
    update_start = service.sql.index("expired_named_circle_member_invites AS")
    candidate_sql = service.sql[candidate_start:update_start]
    assert "SELECT invite.id" in candidate_sql
    assert "WHERE invite.status = 'pending'" in candidate_sql
    assert "ORDER BY invite.expires_at, invite.id" in candidate_sql
    assert "LIMIT 500" in candidate_sql
    assert "FOR UPDATE SKIP LOCKED" in candidate_sql
    assert update_start > candidate_start
    assert "FROM expired_named_circle_member_invite_candidates candidate" in service.sql
    assert "WHERE invite.id = candidate.id" in service.sql


def test_four_user_location_workflow_contract() -> None:
    service = FourUserMemoryService()
    user_a = "user_a"
    user_b = "user_b"
    user_c = "user_c"
    user_d = "user_d"

    for user_id in (user_a, user_b, user_c, user_d):
        service.register_recipient_key(
            user_id=user_id,
            key_id=f"key-{user_id}",
            public_key_jwk={"kty": "EC", "crv": "P-256", "x": user_id, "y": user_id},
        )
    service.identities[user_c]["phone_verified"] = False

    grant_b = service.create_grant(
        owner_user_id=user_a,
        recipient_user_id=user_b,
        recipient_key_id=f"key-{user_b}",
        duration_hours=1,
    )
    share_notification = next(
        item
        for item in service.notifications
        if item["notification_type"] == "location_share_created"
        and (item.get("data") or {}).get("grant_id") == grant_b["id"]
    )
    assert share_notification["body"] == "User A shared location access with you."
    assert "phone" not in json.dumps(share_notification).lower()
    assert "0001" not in json.dumps(share_notification)
    service.store_encrypted_envelope(
        owner_user_id=user_a,
        grant_id=grant_b["id"],
        envelope=encrypted_envelope(f"key-{user_b}", "ciphertext-for-b"),
    )

    viewed_b = service.view_latest_envelope(recipient_user_id=user_b, grant_id=grant_b["id"])
    assert viewed_b["envelope"]["ciphertext"] == "ciphertext-for-b"

    with pytest.raises(OneLocationAgentError) as denied_c:
        service.view_latest_envelope(recipient_user_id=user_c, grant_id=grant_b["id"])
    assert denied_c.value.code == "LOCATION_GRANT_NOT_FOUND"

    with pytest.raises(OneLocationAgentError) as unverified_share:
        service.create_grant(
            owner_user_id=user_a,
            recipient_user_id=user_c,
            recipient_key_id=f"key-{user_c}",
            duration_hours=1,
        )
    assert unverified_share.value.code == "LOCATION_RECIPIENT_UNAVAILABLE"

    direct_request_c = service.request_access(
        requester_user_id=user_c,
        owner_user_id=user_a,
        message="Can you share where you are?",
    )
    duplicate_request_c = service.request_access(
        requester_user_id=user_c,
        owner_user_id=user_a,
        message="Can you share where you are now?",
    )
    assert duplicate_request_c["id"] == direct_request_c["id"]
    assert duplicate_request_c["message"] == "Can you share where you are now?"

    approved_c = service.approve_request(
        owner_user_id=user_a,
        request_id=direct_request_c["id"],
        duration_hours=1,
    )
    grant_c = approved_c["grant"]
    assert grant_c["recipientUserId"] == user_c
    grant_c_notifications = [
        item
        for item in service.notifications
        if str((item.get("data") or {}).get("grant_id") or "") == grant_c["id"]
    ]
    assert [item["notification_type"] for item in grant_c_notifications] == [
        "location_access_approved"
    ]
    service.store_encrypted_envelope(
        owner_user_id=user_a,
        grant_id=grant_c["id"],
        envelope=encrypted_envelope(f"key-{user_c}", "ciphertext-for-c"),
    )
    viewed_c = service.view_latest_envelope(recipient_user_id=user_c, grant_id=grant_c["id"])
    assert viewed_c["envelope"]["ciphertext"] == "ciphertext-for-c"

    referral_response = service.refer_recipient(
        referring_user_id=user_b,
        grant_id=grant_b["id"],
        referred_user_id=user_d,
    )
    assert referral_response["referral"]["status"] == "pending_owner_approval"
    assert referral_response["request"]["status"] == "pending"

    with pytest.raises(OneLocationAgentError):
        service.view_latest_envelope(recipient_user_id=user_d, grant_id=grant_b["id"])

    approved_d = service.approve_request(
        owner_user_id=user_a,
        request_id=referral_response["request"]["id"],
        duration_hours=1,
    )
    grant_d = approved_d["grant"]
    service.store_encrypted_envelope(
        owner_user_id=user_a,
        grant_id=grant_d["id"],
        envelope=encrypted_envelope(f"key-{user_d}", "ciphertext-for-d"),
    )
    viewed_d = service.view_latest_envelope(recipient_user_id=user_d, grant_id=grant_d["id"])
    assert viewed_d["envelope"]["ciphertext"] == "ciphertext-for-d"

    service.revoke_grant(owner_user_id=user_a, grant_id=grant_b["id"])
    with pytest.raises(OneLocationAgentError) as revoked_b:
        service.view_latest_envelope(recipient_user_id=user_b, grant_id=grant_b["id"])
    assert revoked_b.value.code == "LOCATION_GRANT_NOT_ACTIVE"
    assert {item["notification_type"] for item in service.notifications} >= {
        "location_share_created",
        "location_access_request",
        "location_access_approved",
        "location_referral_invite",
        "location_share_revoked",
    }
    assert "latitude" not in json.dumps(service.notifications, default=str)
    assert "longitude" not in json.dumps(service.notifications, default=str)

    serialized_state = json.dumps(
        {
            "grants": service.grants,
            "envelopes": service.envelopes,
            "requests": service.requests,
            "referrals": service.referrals,
        },
        default=str,
    )
    assert "latitude" not in serialized_state
    assert "longitude" not in serialized_state


def test_location_grant_recipient_can_mark_share_revoked() -> None:
    service = FourUserMemoryService()
    for user_id in ("user_a", "user_b", "user_c"):
        service.register_recipient_key(
            user_id=user_id,
            key_id=f"key-{user_id}",
            public_key_jwk={"kty": "EC", "crv": "P-256", "x": user_id, "y": user_id},
        )

    grant = service.create_grant(
        owner_user_id="user_a",
        recipient_user_id="user_b",
        recipient_key_id="key-user_b",
        duration_hours=1,
    )

    with pytest.raises(OneLocationAgentError) as unrelated:
        service.revoke_grant(owner_user_id="user_c", grant_id=grant["id"])
    assert unrelated.value.code == "LOCATION_GRANT_NOT_FOUND"

    revoked = service.revoke_grant(owner_user_id="user_b", grant_id=grant["id"])

    assert revoked["status"] == "revoked"
    assert service.grants[grant["id"]]["status"] == "revoked"
    revoke_events = [
        event
        for event in service.events.values()
        if event["event_type"] == "location_share_revoked"
    ]
    assert revoke_events[-1]["actor_user_id"] == "user_b"
    assert revoke_events[-1]["metadata"]["reason"] == "recipient_revoke"
    assert service.notifications[-1]["user_id"] == "user_a"

    already_revoked = service.revoke_grant(owner_user_id="user_b", grant_id=grant["id"])
    assert already_revoked["status"] == "revoked"


def test_location_request_creation_does_not_require_requester_key_material() -> None:
    service = FourUserMemoryService()
    service.register_recipient_key(
        user_id="user_a",
        key_id="key-user_a",
        public_key_jwk={"kty": "EC", "crv": "P-256", "x": "user_a", "y": "user_a"},
    )

    request = service.request_access(
        requester_user_id="user_c",
        owner_user_id="user_a",
        message="Can I see your location?",
    )

    assert request["ownerUserId"] == "user_a"
    assert request["requesterUserId"] == "user_c"
    assert request["status"] == "pending"

    with pytest.raises(OneLocationAgentError) as missing_key:
        service.create_grant(
            owner_user_id="user_a",
            recipient_user_id="user_c",
            recipient_key_id=None,
            duration_hours=1,
            require_recipient_phone_verified=False,
        )
    assert missing_key.value.code == "LOCATION_RECIPIENT_UNAVAILABLE"


def test_one_location_activity_summary_uses_existing_metadata_events() -> None:
    service = FourUserMemoryService()

    for user_id in ("user_a", "user_b", "user_c"):
        service.register_recipient_key(
            user_id=user_id,
            key_id=f"key-{user_id}",
            public_key_jwk={"kty": "EC", "crv": "P-256", "x": user_id, "y": user_id},
        )

    grant = service.create_grant(
        owner_user_id="user_a",
        recipient_user_id="user_b",
        recipient_key_id="key-user_b",
        duration_hours=1,
    )
    service.store_encrypted_envelope(
        owner_user_id="user_a",
        grant_id=grant["id"],
        envelope=encrypted_envelope("key-user_b", "ciphertext-for-b"),
    )
    service.view_latest_envelope(recipient_user_id="user_b", grant_id=grant["id"])
    service.request_access(
        requester_user_id="user_c",
        owner_user_id="user_a",
        message="Can you share?",
    )
    created = service.create_public_invite(owner_user_id="user_a", duration_hours=1)
    service.submit_public_invite_request(
        public_token=created["publicToken"],
        visitor_display_name="User B",
        phone_number="+1 555 010 0002",
    )

    activity = service.list_activity(user_id="user_a", range_key="30d")

    assert activity["range"] == "30d"
    assert activity["summary"]["sharedWithCount"] == 1
    assert activity["summary"]["activeShareCount"] == 1
    assert activity["summary"]["requestsReceivedCount"] >= 1
    assert activity["summary"]["viewsCount"] == 1
    assert activity["summary"]["publicLinkCount"] == 1
    assert activity["summary"]["publicResponseCount"] == 1
    titles = {event["title"] for event in activity["events"]}
    assert "Shared with User B" in titles
    assert "Viewed by User B" in titles
    assert "Request from User C" in titles
    assert "Request link created" in titles
    assert "Response from User B" in titles

    def without_timestamps(value):
        if isinstance(value, dict):
            return {
                key: without_timestamps(item)
                for key, item in value.items()
                if not key.lower().endswith("at") and key.lower() != "id"
            }
        if isinstance(value, list):
            return [without_timestamps(item) for item in value]
        return value

    serialized = json.dumps(without_timestamps(activity), default=str)
    assert "ciphertext" not in serialized
    assert "latitude" not in serialized
    assert "longitude" not in serialized
    user_visible_text = " ".join(
        str(event.get(field, ""))
        for event in activity["events"]
        for field in ("title", "detail", "actorLabel")
    )
    assert "0100002" not in user_visible_text
    assert "0002" not in user_visible_text


def test_public_invite_is_request_only_and_token_hash_only() -> None:
    service = FourUserMemoryService()
    service.register_recipient_key(
        user_id="user_b",
        key_id="key-user_b",
        public_key_jwk={"kty": "EC", "crv": "P-256", "x": "user_b", "y": "user_b"},
    )

    created = service.create_public_invite(owner_user_id="user_a", duration_hours=1)
    token = created["publicToken"]

    assert created["publicUrl"].endswith(token)
    assert created["publicUrl"].startswith("/one/location/request/")
    assert token not in json.dumps(service.public_invites, default=str)

    resolved = service.resolve_public_invite(public_token=token)
    assert resolved["invite"]["ownerLabel"] == "A trusted person"
    serialized_resolve = json.dumps(resolved)
    assert "ownerUserId" not in serialized_resolve
    assert "ownerDisplayName" not in serialized_resolve
    assert "ownerMaskedPhone" not in serialized_resolve
    assert "grant" not in serialized_resolve
    assert "ciphertext" not in serialized_resolve
    assert "latitude" not in serialized_resolve
    assert "longitude" not in serialized_resolve

    submitted = service.submit_public_invite_request(
        public_token=token,
        visitor_display_name="User B",
        phone_number="+1 555 010 0002",
        message="Please share for pickup.",
    )

    assert submitted["submission"]["status"] == "matched_request_pending"
    assert "request" not in submitted
    assert len(service.requests) == 1
    assert next(iter(service.requests.values()))["status"] == "pending"
    assert next(iter(service.requests.values()))["requester_user_id"] == "user_b"
    assert "latitude" not in json.dumps(service.public_submissions, default=str)
    assert "longitude" not in json.dumps(service.notifications, default=str)
    assert token not in json.dumps(service.notifications, default=str)
    assert {item["notification_type"] for item in service.notifications} >= {
        "location_public_invite_submitted"
    }


def test_public_invite_with_snapshot_returns_location_on_resolve_without_private_request() -> None:
    service = FourUserMemoryService()
    service.register_recipient_key(
        user_id="user_b",
        key_id="key-user_b",
        public_key_jwk={"kty": "EC", "crv": "P-256", "x": "user_b", "y": "user_b"},
    )

    created = service.create_public_invite(
        owner_user_id="user_a",
        duration_hours=1,
        location_snapshot=PUBLIC_LOCATION_SNAPSHOT,
    )
    token = created["publicToken"]

    resolved = service.resolve_public_invite(public_token=token)
    assert resolved["invite"]["locationAvailable"] is True
    assert resolved["publicLocation"]["latitude"] == PUBLIC_LOCATION_SNAPSHOT["latitude"]
    assert resolved["publicLocation"]["longitude"] == PUBLIC_LOCATION_SNAPSHOT["longitude"]

    submitted = service.submit_public_invite_request(
        public_token=token,
        visitor_display_name="User B",
        phone_number="+1 555 010 0002",
        message="For pickup.",
    )

    assert submitted["submission"]["status"] == "approved"
    assert submitted["publicLocation"]["latitude"] == PUBLIC_LOCATION_SNAPSHOT["latitude"]
    assert submitted["publicLocation"]["longitude"] == PUBLIC_LOCATION_SNAPSHOT["longitude"]
    assert service.requests == {}
    assert "latitude" not in json.dumps(service.public_submissions, default=str)
    assert "longitude" not in json.dumps(service.notifications, default=str)
    assert token not in json.dumps(service.notifications, default=str)


def test_public_invite_submission_without_key_never_creates_access() -> None:
    service = FourUserMemoryService()
    created = service.create_public_invite(owner_user_id="user_a", duration_hours=1)

    submitted = service.submit_public_invite_request(
        public_token=created["publicToken"],
        visitor_display_name="User C",
        phone_number="+1 555 010 0003",
    )

    assert submitted["submission"]["status"] == "identity_pending_key"
    assert "matchedUserId" not in submitted["submission"]
    assert "request" not in submitted
    assert service.requests == {}


def test_claim_circle_invite_writes_one_way_trusted_edge(monkeypatch: pytest.MonkeyPatch) -> None:
    """Claiming a Circle invite must write a directional trusted_connections edge
    (owner=claimer, trusted=inviter)."""
    svc = OneLocationAgentService()
    writes: list[tuple[str, dict]] = []

    monkeypatch.setattr(
        svc,
        "_circle_invite_row_for_token",
        lambda **kw: {"id": "inv1", "owner_user_id": "inviter-uid", "message": ""},
    )
    monkeypatch.setattr(
        svc,
        "_identity_row",
        lambda uid: {"user_id": uid, "phone_verified": True, "display_name": uid},
    )

    def fake_execute_one(sql: str, params: dict | None = None) -> dict | None:
        params = params or {}
        writes.append((sql, params))
        # NEW ORDER: invite UPDATE runs first, trusted INSERT runs second.
        if "UPDATE one_location_circle_invites" in sql and "'claimed'" in sql:
            return {
                "id": "inv1",
                "owner_user_id": "inviter-uid",
                "status": "claimed",
                "claimed_by_user_id": "claimant-uid",
                "duration_hours": 24,
                "expires_at": None,
                "created_at": None,
                "updated_at": None,
                "revoked_at": None,
                "claimed_at": None,
                "message": None,
                "metadata": None,
            }
        if "INSERT INTO trusted_connections" in sql:
            return {
                "id": "edge-1",
                "owner_user_id": params.get("owner_user_id"),
                "trusted_user_id": params.get("trusted_user_id"),
                "status": "active",
                "created_at": None,
                "updated_at": None,
                "revoked_at": None,
            }
        # _insert_event calls are wrapped in try/except and ignore return value
        return {}

    monkeypatch.setattr(svc, "_execute_one", fake_execute_one)

    result = svc.claim_circle_invite(invite_token="tok", claimant_user_id="claimant-uid")  # noqa: S106

    tc_writes = [(sql, p) for sql, p in writes if "INSERT INTO trusted_connections" in sql]
    assert len(tc_writes) == 1, "Expected exactly one INSERT INTO trusted_connections"
    assert tc_writes[0][1]["owner_user_id"] == "claimant-uid"
    assert tc_writes[0][1]["trusted_user_id"] == "inviter-uid"
    assert "circle_invite" in tc_writes[0][0], (
        "INSERT SQL must contain the 'circle_invite' source literal"
    )

    assert result["connection"]["id"] == "edge-1"
    assert result["connection"]["inviterUserId"] == "inviter-uid"
    assert result["connection"]["inviteeUserId"] == "claimant-uid"
    assert result["connection"]["inviteId"] == "inv1"


def test_invite_to_one_claim_creates_network_connection_without_location_access() -> None:
    service = FourUserMemoryService()
    service.register_recipient_key(
        user_id="user_b",
        key_id="key-user_b",
        public_key_jwk={"kty": "EC", "crv": "P-256", "x": "user_b", "y": "user_b"},
    )

    created = service.create_circle_invite(
        owner_user_id="user_a",
        duration_hours=1,
        message="Join me on One.",
    )
    token = created["inviteToken"]

    assert created["inviteUrl"].endswith(token)
    assert created["inviteUrl"].startswith("/one/location/invite/")
    assert token not in json.dumps(service.circle_invites, default=str)

    resolved = service.resolve_circle_invite(invite_token=token)
    serialized_resolve = json.dumps(resolved)
    assert resolved["invite"]["ownerLabel"] == "User A - *******0001"
    assert "ownerUserId" not in serialized_resolve
    assert "grant" not in serialized_resolve
    assert "ciphertext" not in serialized_resolve
    assert "latitude" not in serialized_resolve
    assert "longitude" not in serialized_resolve

    claimed = service.claim_circle_invite(
        invite_token=token,
        claimant_user_id="user_b",
        message="Happy to join.",
    )

    assert claimed["invite"]["status"] == "claimed"
    assert claimed["invite"]["claimedByUserId"] == "user_b"
    assert claimed["connection"]["status"] == "active"
    # One-way edge: owner=claimer (user_b), trusted=inviter (user_a).
    # inviterUserId = invite owner (user_a), inviteeUserId = claimant (user_b).
    assert claimed["connection"]["inviterUserId"] == "user_a"
    assert claimed["connection"]["inviteeUserId"] == "user_b"
    assert claimed["connection"]["inviteId"] is not None
    assert service.requests == {}
    assert service.grants == {}
    assert service.network_connections == {}
    assert "latitude" not in json.dumps(claimed, default=str)
    assert "longitude" not in json.dumps(service.notifications, default=str)
    assert token not in json.dumps(service.notifications, default=str)
    assert {item["notification_type"] for item in service.notifications} >= {
        "location_one_network_joined"
    }
    network_notifications = [
        item
        for item in service.notifications
        if item["notification_type"] == "location_one_network_joined"
    ]
    assert network_notifications
    assert all("section=people" in item["request_url"] for item in network_notifications)
    assert any(
        event["event_type"] == "location_one_network_joined" for event in service.events.values()
    )

    # Claiming alone no longer confers location-recipient eligibility: that now
    # requires an explicit `connections` row (created by a separate, frontend-
    # gated path), not just the circle-invite trusted edge.
    recipients_for_claimer = service.list_verified_recipients(owner_user_id="user_b")
    assert all(recipient["userId"] != "user_a" for recipient in recipients_for_claimer)

    with pytest.raises(OneLocationAgentError) as duplicate:
        service.claim_circle_invite(invite_token=token, claimant_user_id="user_c")

    assert duplicate.value.code == "LOCATION_CIRCLE_INVITE_NOT_ACTIVE"


def test_invite_to_one_claim_requires_phone_verified_identity() -> None:
    service = FourUserMemoryService()
    service.identities["user_c"]["phone_verified"] = False
    created = service.create_circle_invite(owner_user_id="user_a", duration_hours=1)

    with pytest.raises(OneLocationAgentError) as exc:
        service.claim_circle_invite(
            invite_token=created["inviteToken"],
            claimant_user_id="user_c",
        )

    assert exc.value.code == "LOCATION_PHONE_VERIFICATION_REQUIRED"
    assert service.network_connections == {}
    assert service.requests == {}
    assert next(iter(service.circle_invites.values()))["status"] == "active"


def test_marketplace_connection_alone_is_not_a_location_recipient() -> None:
    # A marketplace (advisor<->investor) relationship no longer grants location
    # visibility on its own -- only an accepted connection does.
    service = FourUserMemoryService()
    service.professional_relationships.append(
        {
            "investor_user_id": "user_a",
            "ria_user_id": "user_b",
            "status": "approved",
            "ria_display_name": "User B",
            "ria_verification_status": "verified",
            "relationship_share_status": "active",
        }
    )

    recipient_ids = {
        recipient["userId"]
        for recipient in service.list_verified_recipients(owner_user_id="user_a")
    }

    assert "user_b" not in recipient_ids


def test_phone_verified_user_without_connection_is_not_a_recipient() -> None:
    # The broad phone-verified directory no longer seeds recipients.
    service = FourUserMemoryService()

    recipient_ids = {
        recipient["userId"]
        for recipient in service.list_verified_recipients(owner_user_id="user_a")
    }

    assert recipient_ids == set()


def test_active_connection_makes_user_a_location_recipient() -> None:
    service = FourUserMemoryService()
    service._seed_connection("user_a", "user_b")

    recipient_ids = {
        recipient["userId"]
        for recipient in service.list_verified_recipients(owner_user_id="user_a")
    }

    assert recipient_ids == {"user_b"}


def test_shared_named_circle_materializes_circle_only_location_recipient() -> None:
    service = FourUserMemoryService()
    service._seed_named_circle(
        "550e8400-e29b-41d4-a716-446655440000",
        "user_a",
        "user_b",
    )

    recipient_ids = {
        recipient["userId"]
        for recipient in service.list_verified_recipients(owner_user_id="user_a")
    }

    assert recipient_ids == {"user_b"}
    assert len(service.connections) == 1
    assert {origin["origin_kind"] for origin in service.connection_origins.values()} == {
        "named_circle"
    }
    assert service.trusted_connections == {}


def test_public_invite_submission_limits_bound_duplicate_phone_requests() -> None:
    service = FourUserMemoryService()
    service.register_recipient_key(
        user_id="user_b",
        key_id="key-user_b",
        public_key_jwk={"kty": "EC", "crv": "P-256", "x": "user_b", "y": "user_b"},
    )
    created = service.create_public_invite(owner_user_id="user_a", duration_hours=1)

    service.submit_public_invite_request(
        public_token=created["publicToken"],
        visitor_display_name="User B",
        phone_number="+1 555 010 0002",
        submitter_fingerprint_hash="fingerprint-hash",
    )

    with pytest.raises(OneLocationAgentError) as duplicate:
        service.submit_public_invite_request(
            public_token=created["publicToken"],
            visitor_display_name="User B",
            phone_number="+1 555 010 0002",
            submitter_fingerprint_hash="fingerprint-hash",
        )

    assert duplicate.value.code == "LOCATION_PUBLIC_INVITE_ALREADY_SUBMITTED"
    assert duplicate.value.status_code == 429
    assert len(service.public_submissions) == 1
    assert len(service.requests) == 1


# ── Phase 3: HCT capability token on device-to-device grants ────────────────


def test_mint_grant_capability_token_issues_scoped_hct() -> None:
    from hushh_mcp.consent.token import validate_token

    service = OneLocationAgentService()
    minted = service._mint_grant_capability_token(
        owner_user_id="user_a",
        recipient_user_id="user_b",
        duration_hours=1,
    )

    assert minted["token"].startswith("HCT:")
    valid, reason, token = validate_token(minted["token"], expected_scope="cap.location.live.view")
    assert valid is True, reason
    assert token is not None
    assert token.user_id == "user_a"
    assert token.agent_id == "device:user_b"


def test_assert_grant_capability_token_accepts_valid_metadata_token() -> None:
    service = OneLocationAgentService()
    minted = service._mint_grant_capability_token(
        owner_user_id="user_a",
        recipient_user_id="user_b",
        duration_hours=1,
    )

    # Valid token in metadata must pass without raising.
    service._assert_grant_capability_token({"metadata": {"capability_token": minted["token"]}})
    # Same, when metadata arrives as a JSON string (DB round-trip shape).
    service._assert_grant_capability_token(
        {"metadata": json.dumps({"capability_token": minted["token"]})}
    )


def test_assert_grant_capability_token_rejects_tampered_token() -> None:
    service = OneLocationAgentService()
    minted = service._mint_grant_capability_token(
        owner_user_id="user_a",
        recipient_user_id="user_b",
        duration_hours=1,
    )
    tampered = minted["token"][:-4] + "AAAA"

    with pytest.raises(OneLocationAgentError) as exc:
        service._assert_grant_capability_token({"metadata": {"capability_token": tampered}})
    assert exc.value.code == "LOCATION_GRANT_CAPABILITY_INVALID"
    assert exc.value.status_code == 403


def test_assert_grant_capability_token_allows_legacy_tokenless_grant() -> None:
    """Grants created before per-grant minting carry no token; DB checks govern."""
    service = OneLocationAgentService()
    # No capability_token in metadata → no raise (backward compatible).
    service._assert_grant_capability_token({"metadata": {"reason": "owner_approved"}})
    service._assert_grant_capability_token({"metadata": None})
    service._assert_grant_capability_token({})


# ── Migration-083 (encrypted_private_key_jwk) self-heal ─────────────────────


def test_missing_encrypted_private_column_detector_is_narrow() -> None:
    """The self-heal detector must only match the specific migration-083 drift."""
    from db.db_client import DatabaseExecutionError
    from hushh_mcp.services.one_location_agent_service import (
        _is_missing_encrypted_private_column,
    )

    drift = DatabaseExecutionError(
        table_name="<raw_sql>",
        operation="execute_raw",
        details=(
            '(psycopg2.errors.UndefinedColumn) column "encrypted_private_key_jwk" '
            'of relation "one_location_recipient_keys" does not exist'
        ),
    )
    assert _is_missing_encrypted_private_column(drift) is True

    # A different column error must NOT be swallowed by the self-heal.
    unrelated = DatabaseExecutionError(
        table_name="<raw_sql>",
        operation="execute_raw",
        details='column "some_other_col" does not exist',
    )
    assert _is_missing_encrypted_private_column(unrelated) is False

    # A transient/connection error must NOT match either.
    transient = DatabaseExecutionError(
        table_name="<raw_sql>",
        operation="execute_raw",
        details="connection refused",
    )
    assert _is_missing_encrypted_private_column(transient) is False


class _RecipientKeySelfHealService(OneLocationAgentService):
    """Fails the recipient-key INSERT once with the exact migration-083 drift,
    records the ensure-column call, then succeeds on retry."""

    def __init__(self) -> None:
        self.ensure_column_calls = 0
        self.insert_attempts = 0

    def _execute_recipient_key_registration(
        self,
        *,
        recipient_key_lock_key: str,
        mutation_sql: str,
        params: dict,
    ) -> dict | None:
        from db.db_client import DatabaseExecutionError

        assert recipient_key_lock_key.endswith(str(params["user_id"]))
        assert "upserted_key AS" in mutation_sql
        self.insert_attempts += 1
        if self.insert_attempts == 1:
            raise DatabaseExecutionError(
                table_name="<raw_sql>",
                operation="execute_raw",
                details=(
                    "(psycopg2.errors.UndefinedColumn) column "
                    '"encrypted_private_key_jwk" of relation '
                    '"one_location_recipient_keys" does not exist'
                ),
            )
        return {
            "user_id": params.get("user_id"),
            "key_id": params.get("key_id"),
            "public_key_jwk": params.get("public_key_jwk"),
            "algorithm": "ECDH-P256-AES256-GCM",
            "key_created_at": datetime.now(timezone.utc),
            "phone_verified": True,
        }

    def _ensure_recipient_encrypted_private_column(self) -> None:
        self.ensure_column_calls += 1
        type(self)._recipient_encrypted_private_column_ensured = True


def test_register_recipient_key_self_heals_missing_encrypted_private_column() -> None:
    OneLocationAgentService._recipient_encrypted_private_column_ensured = False
    service = _RecipientKeySelfHealService()

    result = service.register_recipient_key(
        user_id="user_a",
        public_key_jwk={"kty": "EC", "crv": "P-256", "x": "abc", "y": "def"},
        key_id="recipient-key-id-1234",
    )

    # The column ensure ran exactly once and the INSERT was retried to success.
    assert service.ensure_column_calls == 1
    assert service.insert_attempts == 2
    assert result.get("userId") == "user_a"


class _RecipientKeyUnrelatedErrorService(OneLocationAgentService):
    """INSERT raises an unrelated DB error; the self-heal must NOT fire and the
    original error must propagate."""

    def __init__(self) -> None:
        self.ensure_column_calls = 0

    def _execute_recipient_key_registration(
        self,
        *,
        recipient_key_lock_key: str,
        mutation_sql: str,
        params: dict,
    ) -> dict | None:
        from db.db_client import DatabaseExecutionError

        raise DatabaseExecutionError(
            table_name="<raw_sql>",
            operation="execute_raw",
            details="some unrelated integrity violation",
        )

    def _ensure_recipient_encrypted_private_column(self) -> None:  # pragma: no cover
        self.ensure_column_calls += 1


def test_register_recipient_key_propagates_unrelated_db_error() -> None:
    from db.db_client import DatabaseExecutionError

    OneLocationAgentService._recipient_encrypted_private_column_ensured = False
    service = _RecipientKeyUnrelatedErrorService()

    with pytest.raises(DatabaseExecutionError):
        service.register_recipient_key(
            user_id="user_a",
            public_key_jwk={"kty": "EC", "crv": "P-256", "x": "abc", "y": "def"},
            key_id="recipient-key-id-1234",
        )
    assert service.ensure_column_calls == 0


def test_recipient_key_rotation_revokes_grants_bound_to_old_key() -> None:
    service = FourUserMemoryService()
    service.register_recipient_key(
        user_id="user_b",
        key_id="key-user-b-old",
        public_key_jwk={"kty": "EC", "crv": "P-256", "x": "old", "y": "old"},
    )
    grant = service.create_grant(
        owner_user_id="user_a",
        recipient_user_id="user_b",
        recipient_key_id="key-user-b-old",
        duration_hours=1,
    )

    service.register_recipient_key(
        user_id="user_b",
        key_id="key-user-b-new",
        public_key_jwk={"kty": "EC", "crv": "P-256", "x": "new", "y": "new"},
    )

    assert service.keys[("user_b", "key-user-b-old")]["status"] == "rotated"
    assert service.keys[("user_b", "key-user-b-new")]["status"] == "active"
    assert service.grants[grant["id"]]["status"] == "revoked"


def test_recipient_key_id_cannot_be_rebound_to_different_material() -> None:
    service = FourUserMemoryService()
    service.register_recipient_key(
        user_id="user_b",
        key_id="stable-key-id",
        public_key_jwk={"kty": "EC", "crv": "P-256", "x": "first", "y": "first"},
    )

    with pytest.raises(OneLocationAgentError) as exc:
        service.register_recipient_key(
            user_id="user_b",
            key_id="stable-key-id",
            public_key_jwk={
                "kty": "EC",
                "crv": "P-256",
                "x": "second",
                "y": "second",
            },
        )

    assert exc.value.code == "LOCATION_RECIPIENT_KEY_ID_CONFLICT"
    assert service.keys[("user_b", "stable-key-id")]["public_key_jwk"]["x"] == "first"


def test_create_grant_enforce_connection_rejects_non_connection() -> None:
    service = FourUserMemoryService()
    service.register_recipient_key(
        user_id="user_b",
        key_id="key-user_b",
        public_key_jwk={"kty": "EC", "crv": "P-256", "x": "user_b", "y": "user_b"},
    )

    with pytest.raises(OneLocationAgentError) as err:
        service.create_grant(
            owner_user_id="user_a",
            recipient_user_id="user_b",
            recipient_key_id="key-user_b",
            duration_hours=1,
            enforce_connection=True,
        )
    assert err.value.code == "LOCATION_RECIPIENT_NOT_CONNECTED"
    assert err.value.status_code == 403


def test_create_grant_enforce_connection_allows_connection() -> None:
    service = FourUserMemoryService()
    service.register_recipient_key(
        user_id="user_b",
        key_id="key-user_b",
        public_key_jwk={"kty": "EC", "crv": "P-256", "x": "user_b", "y": "user_b"},
    )
    service._seed_connection("user_a", "user_b")

    grant = service.create_grant(
        owner_user_id="user_a",
        recipient_user_id="user_b",
        recipient_key_id="key-user_b",
        duration_hours=1,
        enforce_connection=True,
    )
    assert grant["recipientUserId"] == "user_b"
    assert grant["sourceCircleId"] is None


def test_create_grant_circle_only_connection_derives_revocable_provenance() -> None:
    service = FourUserMemoryService()
    service.register_recipient_key(
        user_id="user_b",
        key_id="key-user_b",
        public_key_jwk={"kty": "EC", "crv": "P-256", "x": "user_b", "y": "user_b"},
    )
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    service._seed_named_circle(circle_id, "user_a", "user_b")

    grant = service.create_grant(
        owner_user_id="user_a",
        recipient_user_id="user_b",
        recipient_key_id="key-user_b",
        duration_hours=1,
        enforce_connection=True,
    )

    assert grant["sourceCircleId"] == circle_id
    assert service.grants[grant["id"]]["source_circle_id"] == circle_id
    assert {
        origin["origin_kind"]
        for origin in service.connection_origins.values()
        if origin["status"] == "active"
    } == {"named_circle"}

    service.named_circle_memberships.difference_update(
        {(circle_id, "user_a"), (circle_id, "user_b")}
    )
    service._revoke_connection_origin(
        "user_a",
        "user_b",
        origin_kind="named_circle",
        source_circle_id=circle_id,
    )

    assert next(iter(service.connections.values()))["status"] == "revoked"
    with pytest.raises(OneLocationAgentError) as error:
        service.create_grant(
            owner_user_id="user_a",
            recipient_user_id="user_b",
            recipient_key_id="key-user_b",
            duration_hours=1,
            enforce_connection=True,
        )
    assert error.value.code == "LOCATION_RECIPIENT_NOT_CONNECTED"


def test_create_grant_direct_origin_wins_and_survives_circle_origin_revocation() -> None:
    service = FourUserMemoryService()
    service.register_recipient_key(
        user_id="user_b",
        key_id="key-user_b",
        public_key_jwk={"kty": "EC", "crv": "P-256", "x": "user_b", "y": "user_b"},
    )
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    service._seed_connection("user_a", "user_b")
    service._seed_named_circle(circle_id, "user_a", "user_b")

    grant = service.create_grant(
        owner_user_id="user_a",
        recipient_user_id="user_b",
        recipient_key_id="key-user_b",
        duration_hours=1,
        enforce_connection=True,
    )

    assert grant["sourceCircleId"] is None
    assert {
        origin["origin_kind"]
        for origin in service.connection_origins.values()
        if origin["status"] == "active"
    } == {"direct_request", "named_circle"}

    service.named_circle_memberships.difference_update(
        {(circle_id, "user_a"), (circle_id, "user_b")}
    )
    service._revoke_connection_origin(
        "user_a",
        "user_b",
        origin_kind="named_circle",
        source_circle_id=circle_id,
    )

    assert next(iter(service.connections.values()))["status"] == "active"
    assert service.grants[grant["id"]]["status"] == "active"
    assert service._is_location_peer_eligible(
        owner_user_id="user_a",
        other_user_id="user_b",
    )


def test_create_grant_rejects_an_unshared_explicit_circle() -> None:
    service = FourUserMemoryService()
    service.register_recipient_key(
        user_id="user_b",
        key_id="key-user_b",
        public_key_jwk={"kty": "EC", "crv": "P-256", "x": "user_b", "y": "user_b"},
    )
    service._seed_connection("user_a", "user_b")

    with pytest.raises(OneLocationAgentError) as error:
        service.create_grant(
            owner_user_id="user_a",
            recipient_user_id="user_b",
            recipient_key_id="key-user_b",
            duration_hours=1,
            source_circle_id="550e8400-e29b-41d4-a716-446655440000",
            enforce_connection=True,
        )

    assert error.value.code == "LOCATION_RECIPIENT_NOT_CONNECTED"


def test_enforced_circle_grant_locks_relationship_before_mutation(monkeypatch) -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"

    class Result:
        def __init__(self, *, first=None, rows=None):
            self._first = first
            self._rows = rows or []

        def mappings(self):
            return self

        def first(self):
            return self._first

        def all(self):
            return self._rows

    class Connection:
        def __init__(self):
            self.calls: list[str] = []

        def execute(self, query, _params=None):
            sql = str(query)
            self.calls.append(sql)
            if "FROM connections" in sql:
                return Result()
            if "SELECT mine.circle_id::text AS circle_id" in sql:
                return Result(first={"circle_id": circle_id})
            if "FROM one_location_circles" in sql and "FOR SHARE" in sql:
                return Result(first={"id": circle_id})
            if "FROM one_location_circle_memberships" in sql and "FOR SHARE" in sql:
                return Result(rows=[{"user_id": "user_a"}, {"user_id": "user_b"}])
            if "INSERT INTO one_location_share_grants" in sql:
                return Result(first={"id": "grant-id", "source_circle_id": circle_id})
            return Result()

    connection = Connection()

    class Engine:
        @contextmanager
        def begin(self):
            yield connection

    monkeypatch.setattr(
        one_location_agent_module,
        "get_db",
        lambda: SimpleNamespace(engine=Engine()),
    )

    row = OneLocationAgentService()._create_enforced_grant_row(
        owner_user_id="user_a",
        recipient_user_id="user_b",
        requested_circle_id=None,
        grant_params={
            "owner_user_id": "user_a",
            "recipient_user_id": "user_b",
            "recipient_key_id": "key-user-b",
            "capability_scopes": "[]",
            "duration_hours": 1,
            "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
            "metadata_json": "{}",
            "recipient_display_name": "User B",
            "recipient_phone_number": None,
        },
    )

    assert row == {"id": "grant-id", "source_circle_id": circle_id}
    direct_lookup = next(sql for sql in connection.calls if "FROM connections" in sql)
    assert "JOIN connection_origins origin" in direct_lookup
    assert "origin.status = 'active'" in direct_lookup
    assert "origin.origin_kind <> 'named_circle'" in direct_lookup
    assert "FOR SHARE OF connection, origin" in direct_lookup
    circle_lock = next(
        index
        for index, sql in enumerate(connection.calls)
        if "FROM one_location_circles" in sql and "FOR SHARE" in sql
    )
    membership_lock = next(
        index
        for index, sql in enumerate(connection.calls)
        if "FROM one_location_circle_memberships" in sql and "FOR SHARE" in sql
    )
    revoke = next(
        index
        for index, sql in enumerate(connection.calls)
        if "UPDATE one_location_share_grants" in sql
    )
    insert = next(
        index
        for index, sql in enumerate(connection.calls)
        if "INSERT INTO one_location_share_grants" in sql
    )
    event = next(
        index
        for index, sql in enumerate(connection.calls)
        if "INSERT INTO one_location_events" in sql
    )
    assert circle_lock < membership_lock < revoke < insert < event

    connection.calls.clear()
    OneLocationAgentService()._add_sms_contact_with_locked_eligibility(
        owner_user_id="user_a",
        contact_user_id="user_b",
    )
    circle_lock = next(
        index
        for index, sql in enumerate(connection.calls)
        if "FROM one_location_circles" in sql and "FOR SHARE" in sql
    )
    membership_lock = next(
        index
        for index, sql in enumerate(connection.calls)
        if "FROM one_location_circle_memberships" in sql and "FOR SHARE" in sql
    )
    sms_insert = next(
        index
        for index, sql in enumerate(connection.calls)
        if "INSERT INTO one_location_sms_contacts" in sql
    )
    assert circle_lock < membership_lock < sms_insert


def test_create_grant_without_enforce_allows_non_connection() -> None:
    # The request-approval / public-invite path must keep working.
    service = FourUserMemoryService()
    service.register_recipient_key(
        user_id="user_b",
        key_id="key-user_b",
        public_key_jwk={"kty": "EC", "crv": "P-256", "x": "user_b", "y": "user_b"},
    )

    grant = service.create_grant(
        owner_user_id="user_a",
        recipient_user_id="user_b",
        recipient_key_id="key-user_b",
        duration_hours=1,
    )
    assert grant["recipientUserId"] == "user_b"


def test_sms_contacts_are_owner_scoped_idempotent_and_do_not_change_connection() -> None:
    service = FourUserMemoryService()
    service.register_recipient_key(
        user_id="user_b",
        key_id="key-user_b",
        public_key_jwk={"kty": "EC", "crv": "P-256", "x": "user_b", "y": "user_b"},
    )
    service._seed_connection("user_a", "user_b")
    before = dict(service.connections)

    assert service.add_sms_contact(owner_user_id="user_a", contact_user_id="user_b") == ["user_b"]
    assert service.add_sms_contact(owner_user_id="user_a", contact_user_id="user_b") == ["user_b"]
    assert service.list_sms_contact_ids(owner_user_id="user_c") == []
    assert service.connections == before

    assert service.remove_sms_contact(owner_user_id="user_a", contact_user_id="user_b") == []
    assert service.remove_sms_contact(owner_user_id="user_a", contact_user_id="user_b") == []
    assert service.connections == before


def test_sms_contact_rejects_non_connection() -> None:
    service = FourUserMemoryService()
    service.register_recipient_key(
        user_id="user_b",
        key_id="key-user_b",
        public_key_jwk={"kty": "EC", "crv": "P-256", "x": "user_b", "y": "user_b"},
    )

    with pytest.raises(OneLocationAgentError) as err:
        service.add_sms_contact(owner_user_id="user_a", contact_user_id="user_b")
    assert err.value.code == "LOCATION_SMS_CONTACT_NOT_CONNECTED"


def test_sms_grant_fails_closed_until_recipient_is_selected() -> None:
    service = FourUserMemoryService()
    service.register_recipient_key(
        user_id="user_b",
        key_id="key-user_b",
        public_key_jwk={"kty": "EC", "crv": "P-256", "x": "user_b", "y": "user_b"},
    )
    service._seed_connection("user_a", "user_b")

    with pytest.raises(OneLocationAgentError) as err:
        service.create_grant(
            owner_user_id="user_a",
            recipient_user_id="user_b",
            recipient_key_id="key-user_b",
            duration_hours=8,
            reason="Come get me",
            share_kind="sos",
            enforce_connection=True,
        )
    assert err.value.code == "LOCATION_SMS_CONTACT_REQUIRED"

    service.add_sms_contact(owner_user_id="user_a", contact_user_id="user_b")
    grant = service.create_grant(
        owner_user_id="user_a",
        recipient_user_id="user_b",
        recipient_key_id="key-user_b",
        duration_hours=8,
        reason="Come get me",
        share_kind="sos",
        enforce_connection=True,
    )
    assert grant["shareKind"] == "sos"
    assert grant["shareMessage"] == "Come get me"
    assert service.notifications == []

    service.store_encrypted_envelope(
        owner_user_id="user_a",
        grant_id=grant["id"],
        envelope=encrypted_envelope("key-user_b", "ciphertext"),
    )
    assert len(service.notifications) == 1
    assert service.notifications[0]["title"] == "SMS · Save my soul"
    assert service.notifications[0]["body"] == "User A: Come get me"
    assert service.notifications[0]["data"]["notification_profile"] == (
        "one_location_sms_emergency"
    )
    assert service.notifications[0]["data"]["notification_category"] == (
        "ONE_LOCATION_SMS_EMERGENCY"
    )
