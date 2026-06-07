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
        self.events: dict[str, dict] = {}
        self.notifications: list[dict] = []
        self.professional_relationships: list[dict] = []
        self.organization_memberships: list[dict] = []
        self.consent_audit_rows: list[dict] = []
        self.marketplace_profiles: dict[str, dict] = {}
        self.persona_states: dict[str, dict] = {}

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

            deleted_events = 0
            for event_id, event in list(self.events.items()):
                metadata = event.get("metadata") or {}
                if (
                    event.get("grant_id") in stale_grant_ids
                    or event.get("request_id") in stale_request_ids
                    or event.get("referral_id") in stale_referral_ids
                    or metadata.get("invite_id") in stale_public_invite_ids
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
            return {
                "deleted_grants": deleted_grants,
                "deleted_envelopes": deleted_envelopes,
                "deleted_requests": deleted_requests,
                "deleted_referrals": deleted_referrals,
                "deleted_public_invites": deleted_public_invites,
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
    assert by_id[user_e]["recommendationCategory"] == "needs_setup"
    assert by_id[user_e]["canReceiveLocation"] is False

    ranks = [recipient["recommendationRank"] for recipient in recipients]
    assert ranks == sorted(ranks)
    encoded = json.dumps(recipients, default=str)
    assert "latitude" not in encoded
    assert "longitude" not in encoded
    assert "15550100002" not in encoded
    assert "Can you share your location?" not in encoded
    assert "attr.financial" not in encoded
    assert "private" not in encoded


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
                if not key.lower().endswith("at")
            }
        if isinstance(value, list):
            return [without_timestamps(item) for item in value]
        return value

    serialized = json.dumps(without_timestamps(activity), default=str)
    assert "ciphertext" not in serialized
    assert "latitude" not in serialized
    assert "longitude" not in serialized
    assert "0100002" not in serialized
    assert "0002" not in serialized


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
