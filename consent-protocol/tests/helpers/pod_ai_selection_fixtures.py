"""Owner authority setup for the AI-selection route fixtures."""

import time
from typing import Any

from hushh_mcp.services.pod_authority_store import PodAuthorityStore
from hushh_mcp.services.pod_session_authority import SCOPE_POD_CONFIG, SCOPE_POD_STATUS


def owner_claims(owner: str) -> dict:
    return {
        "hushh_id": owner,
        "user_id": "owner-uid",
        "subject_id": "fixture-app",
        "role": "app",
        "scopes": [SCOPE_POD_CONFIG, SCOPE_POD_STATUS],
        "version": 1,
    }


async def seed_owner_binding(log: Any, owner: str, claims: dict) -> None:
    claims["exp"] = int(time.time()) + 3600
    authority = PodAuthorityStore(log, hushh_id=owner)
    await authority.load()
    await authority.record_trust(
        {
            "hushh_id": owner,
            "user_id": claims["user_id"],
            "subject_id": claims["subject_id"],
            "role": "app",
            "scopes": claims["scopes"],
            "version": claims["version"],
            "expires_at_ms": claims["exp"] * 1000,
        }
    )


async def allow_fixture_snapshot(_records: Any) -> None:
    """Trusted test setup; owner routes use the real snapshot authorizer."""
    return None
