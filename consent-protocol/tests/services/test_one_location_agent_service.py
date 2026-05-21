from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from hushh_mcp.operons.location.policy import normalize_duration_hours
from hushh_mcp.services.one_location_agent_service import (
    OneLocationAgentError,
    OneLocationAgentService,
    _contains_plaintext_location_key,
    _json_param,
    _redact_location_metadata,
)


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


class RecipientDirectoryProbe(OneLocationAgentService):
    def __init__(self) -> None:
        self.sql = ""
        self.params = {}

    def _execute_many(self, sql: str, params: dict | None = None) -> list[dict]:
        self.sql = sql
        self.params = params or {}
        return []


def test_verified_recipient_directory_filters_self_and_requires_phone_verified() -> None:
    service = RecipientDirectoryProbe()

    assert service.list_verified_recipients(owner_user_id="owner") == []
    assert "a.phone_verified = TRUE" in service.sql
    assert "a.user_id <> :owner_user_id" in service.sql
    assert "ORDER BY COALESCE" in service.sql
    assert service.params["owner_user_id"] == "owner"


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
    response = EnvelopeReadProbe().view_latest_envelope(
        recipient_user_id="user_b",
        grant_id="00000000-0000-0000-0000-000000000001",
    )

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
        self.notifications: list[dict] = []

    def _send_metadata_notification(self, **kwargs) -> None:
        assert _contains_plaintext_location_key(kwargs.get("data") or {}) is False
        self.notifications.append(kwargs)

    def _active_key(self, user_id: str, key_id: str | None = None) -> dict | None:
        matches = [
            key
            for (key_user_id, _), key in self.keys.items()
            if key_user_id == user_id and key["status"] == "active"
        ]
        if key_id:
            matches = [key for key in matches if key["key_id"] == key_id]
        return matches[-1] if matches else None

    def _identity_key_row(self, user_id: str, key_id: str | None = None) -> dict | None:
        identity = self.identities.get(user_id)
        key = self._active_key(user_id, key_id)
        if not identity or not identity["phone_verified"] or not key:
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
        }

    def _execute_many(self, sql: str, params: dict | None = None) -> list[dict]:
        params = params or {}
        if "UPDATE one_location_share_grants" in sql and "expires_at <= NOW()" in sql:
            return []
        if "FROM actor_identity_cache a" in sql:
            owner = params["owner_user_id"]
            rows = []
            for user_id, identity in self.identities.items():
                if user_id == owner or not identity["phone_verified"]:
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
        if "INSERT INTO one_location_events" in sql:
            return None
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
        if "INSERT INTO one_location_recipient_keys" in sql:
            user_id = params["user_id"]
            key_id = params["key_id"]
            row = {
                "user_id": user_id,
                "key_id": key_id,
                "public_key_jwk": json.loads(params["public_key_jwk"]),
                "algorithm": params["algorithm"],
                "status": "active",
                "created_at": datetime.now(timezone.utc),
                "key_created_at": datetime.now(timezone.utc),
                "phone_verified": True,
            }
            self.keys[(user_id, key_id)] = row
            return row
        if "JOIN one_location_recipient_keys k" in sql:
            return self._identity_key_row(
                params["recipient_user_id"], params.get("recipient_key_id")
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
                "recipient_display_name": params.get("recipient_display_name"),
                "recipient_phone_number": params.get("recipient_phone_number"),
            }
            self.grants[grant_id] = row
            return row
        if "FROM one_location_share_grants" in sql and "owner_user_id = :owner_user_id" in sql:
            grant = self.grants.get(params["grant_id"])
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
        if "SET status = 'revoked'" in sql and "owner_user_id = :owner_user_id" in sql:
            grant = self.grants.get(params["grant_id"])
            if (
                grant
                and grant["owner_user_id"] == params["owner_user_id"]
                and grant["status"] == "active"
            ):
                grant["status"] = "revoked"
                grant["revoked_at"] = datetime.now(timezone.utc)
                return grant
            return None
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

    grant_b = service.create_grant(
        owner_user_id=user_a,
        recipient_user_id=user_b,
        recipient_key_id=f"key-{user_b}",
        duration_hours=1,
    )
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
    assert token not in json.dumps(service.public_invites, default=str)

    resolved = service.resolve_public_invite(public_token=token)
    assert resolved["invite"]["ownerUserId"] == "user_a"
    assert "latitude" not in json.dumps(resolved)
    assert "longitude" not in json.dumps(resolved)

    submitted = service.submit_public_invite_request(
        public_token=token,
        visitor_display_name="User B",
        phone_number="+1 555 010 0002",
        message="Please share for pickup.",
    )

    assert submitted["submission"]["status"] == "matched_request_pending"
    assert submitted["request"]["status"] == "pending"
    assert submitted["request"]["requesterUserId"] == "user_b"
    assert "latitude" not in json.dumps(service.public_submissions, default=str)
    assert "longitude" not in json.dumps(service.notifications, default=str)
    assert {item["notification_type"] for item in service.notifications} >= {
        "location_public_invite_submitted"
    }


def test_public_invite_submission_without_key_never_creates_access() -> None:
    service = FourUserMemoryService()
    created = service.create_public_invite(owner_user_id="user_a", duration_hours=1)

    submitted = service.submit_public_invite_request(
        public_token=created["publicToken"],
        visitor_display_name="User C",
        phone_number="+1 555 010 0003",
    )

    assert submitted["submission"]["status"] == "identity_pending_key"
    assert submitted["submission"]["matchedUserId"] == "user_c"
    assert submitted["request"] is None
    assert service.requests == {}
