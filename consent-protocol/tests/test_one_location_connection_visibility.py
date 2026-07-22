from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from hushh_mcp.services.one_location_agent_service import OneLocationAgentService


class _VisibilityMemoryService(OneLocationAgentService):
    def __init__(self) -> None:
        self.preference: dict | None = None
        self.preference_sql = ""
        self.exclusions: dict[str, str] = {}
        self.grants: list[dict] = []
        self.recipients = [
            {
                "userId": "user_b",
                "displayName": "Bob",
                "keyId": "key-user-b",
                "canReceiveLocation": True,
            },
            {
                "userId": "user_c",
                "displayName": "Carol",
                "keyId": "key-user-c",
                "canReceiveLocation": True,
            },
            {
                "userId": "user_d",
                "displayName": "Dev",
                "keyId": None,
                "canReceiveLocation": False,
            },
        ]

    def list_verified_recipients(self, *, owner_user_id: str, limit: int = 50):  # noqa: ARG002
        return self.recipients[:limit]

    def _list_connection_visibility_recipients(self, *, owner_user_id: str):  # noqa: ARG002
        return self.recipients

    def _execute_many(self, sql: str, params=None):
        if "FROM one_location_visibility_exclusions" in sql:
            return [
                {"excluded_user_id": user_id, "source": source}
                for user_id, source in self.exclusions.items()
            ]
        if "FROM one_location_share_grants" in sql and "connections_visibility" in sql:
            return [grant.copy() for grant in self.grants if grant["status"] == "active"]
        raise AssertionError(f"unexpected execute_many SQL: {sql}")

    def _execute_one(self, sql: str, params=None):
        params = params or {}
        if "INSERT INTO one_location_visibility_preferences" in sql:
            self.preference_sql = sql
            now = datetime.now(timezone.utc)
            encoded_exclusions = json.loads(params["excluded_user_ids_json"])
            assert isinstance(encoded_exclusions, list)
            owner_exclusions = set(encoded_exclusions)
            self.exclusions = {
                user_id: source
                for user_id, source in self.exclusions.items()
                if source == "recipient"
            }
            self.exclusions.update({user_id: "owner" for user_id in owner_exclusions})
            self.preference = {
                "owner_user_id": params["owner_user_id"],
                "audience": params["audience"],
                "precision": params["precision"],
                "enabled_at": now if params["enabled"] else None,
                "disabled_at": None if params["enabled"] else now,
                "updated_at": now,
            }
            return self.preference.copy()
        if sql.strip().startswith("DELETE FROM one_location_visibility_exclusions"):
            self.exclusions = {
                user_id: source for user_id, source in self.exclusions.items() if source != "owner"
            }
            return None
        if "INSERT INTO one_location_visibility_exclusions" in sql:
            self.exclusions.setdefault(params["excluded_user_id"], "owner")
            return {"owner_user_id": params["owner_user_id"]}
        if "FROM one_location_share_grants" in sql and "recipient_user_id" in sql:
            return next(
                (
                    grant.copy()
                    for grant in self.grants
                    if grant["recipient_user_id"] == params["recipient_user_id"]
                    and grant["status"] == "active"
                ),
                None,
            )
        if "UPDATE one_location_share_grants" in sql and "status = 'revoked'" in sql:
            for grant in self.grants:
                if grant["id"] == params["grant_id"] and grant["status"] == "active":
                    grant["status"] = "revoked"
                    return grant.copy()
            return None
        raise AssertionError(f"unexpected execute_one SQL: {sql}")

    def create_grant(self, **kwargs):
        now = datetime.now(timezone.utc)
        row = {
            "id": f"grant-{len(self.grants) + 1}",
            "owner_user_id": kwargs["owner_user_id"],
            "recipient_user_id": kwargs["recipient_user_id"],
            "recipient_key_id": kwargs["recipient_key_id"],
            "status": "active",
            "consent_scope": "cap.location.live.view",
            "capability_scopes": [],
            "duration_hours": kwargs["duration_hours"],
            "expires_at": now + timedelta(hours=24),
            "created_at": now,
            "updated_at": now,
            "metadata": {
                "share_kind": "connections_visibility",
                "access_origin": "connections_visibility",
            },
            "access_origin": "connections_visibility",
        }
        self.grants.append(row)
        return self._grant_payload(row)

    def _renew_managed_visibility_grant(self, row):
        return row


class _PublishTargetQueryService(OneLocationAgentService):
    def __init__(self) -> None:
        self.query = ""

    def _visibility_preference_row(self, *, owner_user_id: str):  # noqa: ARG002
        return None

    def _execute_many(self, sql: str, params=None):  # noqa: ARG002
        self.query = sql
        return []


def test_connection_visibility_is_idempotent_and_respects_readiness_and_exclusions():
    service = _VisibilityMemoryService()

    enabled = service.set_connection_visibility(
        owner_user_id="user_a",
        enabled=True,
        precision="approximate",
        excluded_user_ids=["user_b"],
    )
    assert enabled["visibility"]["enabled"] is True
    assert enabled["visibility"]["precision"] == "approximate"
    assert enabled["visibility"]["eligibleConnectionCount"] == 2
    assert enabled["visibility"]["readyConnectionCount"] == 1
    assert [grant["recipientUserId"] for grant in enabled["grants"]] == ["user_c"]
    assert "AND NOT EXISTS" in service.preference_sql

    repeated = service.set_connection_visibility(
        owner_user_id="user_a",
        enabled=True,
        precision="approximate",
        excluded_user_ids=["user_b"],
    )
    assert len(service.grants) == 1
    assert repeated["grants"][0]["id"] == enabled["grants"][0]["id"]

    disabled = service.set_connection_visibility(
        owner_user_id="user_a",
        enabled=False,
        precision="approximate",
        excluded_user_ids=[],
    )
    assert disabled["visibility"]["enabled"] is False
    assert service.grants[0]["status"] == "revoked"


def test_publish_targets_query_uses_a_non_reserved_grant_alias():
    service = _PublishTargetQueryService()

    assert service.list_publish_targets(owner_user_id="user_a") == []
    assert "FROM one_location_share_grants share_grant" in service.query
    assert "FROM one_location_share_grants grant" not in service.query


def test_recipient_readiness_matches_grant_phone_and_key_requirements():
    ready = OneLocationAgentService._recipient_payload(
        {
            "user_id": "user_b",
            "phone_verified": True,
            "key_id": "key-b",
            "public_key_jwk": {"kty": "EC", "crv": "P-256", "x": "x", "y": "y"},
        }
    )
    unverified = OneLocationAgentService._recipient_payload(
        {
            "user_id": "user_c",
            "phone_verified": False,
            "key_id": "key-c",
            "public_key_jwk": {"kty": "EC"},
        }
    )
    missing_key = OneLocationAgentService._recipient_payload(
        {"user_id": "user_d", "phone_verified": True, "key_id": "key-d"}
    )

    assert ready and ready["canReceiveLocation"] is True
    assert unverified and unverified["canReceiveLocation"] is False
    assert missing_key and missing_key["canReceiveLocation"] is False
