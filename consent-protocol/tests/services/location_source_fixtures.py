"""Small Location source doubles; real PostgreSQL owns authorization proof."""

import json
from datetime import datetime, timedelta, timezone

from hushh_mcp.services.one_location_agent_service import OneLocationAgentService


class EnvelopeReadProbe(OneLocationAgentService):
    #: When False the grant is live but no envelope row exists yet — the state a
    #: recipient sits in between being granted access and the owner's first fix.
    has_envelope = True

    def __init__(self) -> None:
        self.calls: list[str] = []

    def _execute_many(self, sql: str, params: dict | None = None) -> list[dict]:
        self.calls.append(sql)
        return []

    def _execute_one(self, sql: str, params: dict | None = None) -> dict | None:
        self.calls.append(sql)
        if "FROM one_location_envelopes" in sql and not self.has_envelope:
            return {"id": None}
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


def fixture_grants(self, sql: str, params: dict) -> list[dict]:
    as_owner = "WHERE g.owner_user_id = :user_id" in sql
    column = "owner_user_id" if as_owner else "recipient_user_id"
    counterpart_column = "recipient_user_id" if as_owner else "owner_user_id"
    label = "recipient" if as_owner else "owner"
    rows = []
    for grant in sorted(
        self.grants.values(),
        key=lambda item: item["created_at"],
        reverse=True,
    ):
        if grant[column] != params["user_id"]:
            continue
        identity = self.identities.get(grant[counterpart_column] or "", {})
        rows.append(
            {
                **grant,
                f"{label}_display_name": identity.get("display_name"),
                f"{label}_phone_number": identity.get("phone_number"),
            }
        )
    return rows[:50]
