"""Read-only provider inventory review shared by preview and deletion preparation."""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Callable
from dataclasses import dataclass

from sqlalchemy import text

from db.db_client import get_db_connection

ACCOUNT_ERASURE_SQL_LIMITS = text(
    "SELECT set_config('lock_timeout', '3000ms', TRUE), "
    "set_config('statement_timeout', '20000ms', TRUE)"
)


class ProviderCleanupReviewChanged(RuntimeError):
    """The final approval no longer matches the exact provider inventory."""

    def result(self) -> dict[str, bool | str]:
        return {
            "success": False,
            "account_deleted": False,
            "error_code": "ACCOUNT_DELETE_CLEANUP_REVIEW_CHANGED",
        }


@dataclass(frozen=True, slots=True)
class ProviderCleanupReview:
    inventory_sha256: str
    credential_count: int
    local_erasure_required: bool


async def review_lost_vault_deletion(user_id: str) -> dict[str, str | int | bool]:
    """Return safe review metadata without creating a deletion intent."""

    def review() -> ProviderCleanupReview:
        with get_db_connection() as conn:
            conn.execute(ACCOUNT_ERASURE_SQL_LIMITS)
            return review_provider_cleanup_in_transaction(conn, user_id=user_id)

    result = await asyncio.to_thread(review)
    return {
        "inventory_sha256": result.inventory_sha256,
        "credential_count": result.credential_count,
        "local_erasure_required": result.local_erasure_required,
    }


def review_provider_cleanup_in_transaction(
    conn, *, user_id: str, describe_inventory: Callable | None = None
) -> ProviderCleanupReview:
    """Inspect current provider credentials without preparing deletion."""
    owner = str(user_id or "").strip()
    if not owner or len(owner) > 128:
        raise ValueError("account cleanup principal is invalid")
    if (
        conn.execute(text("SELECT public.account_provider_cleanup_contract_version()")).scalar_one()
        != 2
    ):
        raise RuntimeError("current provider cleanup contract is required")
    _, review = review_provider_inventory_in_transaction(
        conn, owner=owner, describe_inventory=describe_inventory
    )
    return review


def review_provider_inventory_in_transaction(
    conn, *, owner: str, describe_inventory: Callable | None
) -> tuple[dict, ProviderCleanupReview]:
    """Use one canonical snapshot for preview and durable preparation."""
    inventory_row = (
        conn.execute(
            text("""WITH prepared AS MATERIALIZED (
            SELECT public.account_provider_cleanup_live_inventory(:owner) AS inventory)
            SELECT inventory,encode(sha256(convert_to(inventory::text,'UTF8')),'hex')
                AS inventory_sha256 FROM prepared"""),
            {"owner": owner},
        )
        .mappings()
        .one()
    )
    inventory = inventory_row["inventory"]
    if not isinstance(inventory, dict) or len(inventory) > 128:
        raise RuntimeError("provider cleanup inventory is unavailable")
    if describe_inventory is None:
        from hushh_mcp.services.account_deletion_provider_credentials import (
            describe_inventory as describe_inventory,
        )
    if describe_inventory is not None:
        metadata = describe_inventory(conn, owner, inventory)
        if not isinstance(metadata, dict) or set(metadata) != set(inventory):
            raise RuntimeError("provider cleanup metadata is unavailable")
        for ref, extra in metadata.items():
            if not isinstance(extra, dict) or set(extra) - {
                "groupDigest",
                "revocationSupport",
                "authorityScope",
            }:
                raise ValueError("provider cleanup metadata is invalid")
            if "authorityScope" in extra and (
                extra["authorityScope"] != "retain_shared_google"
                or extra.get("revocationSupport") != "required"
                or "groupDigest" not in extra
            ):
                raise ValueError("provider cleanup authority is invalid")
            if extra.get("revocationSupport") not in {"required", "unsupported", "unverified"}:
                raise ValueError("provider cleanup support is invalid")
            if "groupDigest" in extra and not re.fullmatch(r"[0-9a-f]{64}", extra["groupDigest"]):
                raise ValueError("provider cleanup group is invalid")
            inventory[ref].update(extra)
        # PostgreSQL's canonical JSON representation owns the transition digest.
        inventory_row = {
            "inventory_sha256": conn.execute(
                text("""SELECT encode(sha256(
            convert_to(CAST(:inventory AS jsonb)::text,'UTF8')),'hex')"""),
                {"inventory": json.dumps(inventory)},
            ).scalar_one()
        }
    return inventory, ProviderCleanupReview(
        inventory_sha256=inventory_row["inventory_sha256"],
        credential_count=len(inventory),
        local_erasure_required=any(
            item.get("revocationSupport") == "unsupported"
            or item.get("authorityScope") == "retain_shared_google"
            for item in inventory.values()
        ),
    )
