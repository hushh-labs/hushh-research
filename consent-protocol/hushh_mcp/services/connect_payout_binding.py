"""Source-aware account admission; financial ownership remains with each ledger."""

from __future__ import annotations

import asyncio
from typing import Any, Protocol

from .pkm_packet_order_service import PacketOrderError


class PayoutBindingConflict(ValueError):
    """A provider account cannot be adopted by another settlement authority."""


def require_separate_payout_account(account_id: str | None, foreign_ids: set[str]) -> None:
    if account_id in foreign_ids:
        raise PayoutBindingConflict("payout_financial_source_conflict")


async def scope_account_ids(
    database: Any, owner: str, mode: str, account: str | None = None
) -> set[str]:
    """Read active and retained attribution with RLS refusal, without writes."""
    try:
        result = await asyncio.to_thread(
            database.execute_raw,
            "SELECT scope_commerce_payout_account_claims_v1(:owner,:mode,:account) AS account_ids",
            {"owner": owner, "mode": mode == "live", "account": account},
        )
        return set(result.data[0]["account_ids"])
    except Exception:
        raise PayoutBindingConflict("payout_binding_lookup_unavailable") from None


async def document_account_ids(
    connection: Any, owner: str, livemode: bool, account: str | None = None
) -> set[str]:
    """Read mode-bound and historical document mappings in the current transaction."""
    await connection.execute("SET LOCAL row_security=off")
    result: set[str] = set()
    for table, mode_bound in (
        ("stripe_owner_payout_accounts", True),
        ("pkm_owner_payout_accounts", False),
    ):
        if not await connection.fetchval("SELECT to_regclass($1) IS NOT NULL", table):
            continue
        # Both table identifiers are authored constants; owner/mode stay bound.
        column = "stripe_account_id" if account else "user_id"
        query = f"SELECT stripe_account_id FROM {table} WHERE {column}=$1"  # noqa: S608
        arguments = [account or owner]
        if mode_bound:
            query += " AND stripe_mode=$2"
            arguments.append("live" if livemode else "test")
        rows = await connection.fetch(query, *arguments)
        result.update(row["stripe_account_id"] for row in rows)
    return result


class DocumentBindingPorts(Protocol):
    db: Any
    account_mode: str

    async def _account(self, user_id: str) -> dict[str, Any] | None: ...


async def resolve_document_binding(
    ports: DocumentBindingPorts, owner: str
) -> dict[str, Any] | None:
    account = await ports._account(owner)
    if account is None:
        return None
    try:
        account_id = account["stripe_account_id"]
        foreign_ids = await scope_account_ids(ports.db, owner, ports.account_mode, account_id)
        require_separate_payout_account(account_id, foreign_ids)
    except PayoutBindingConflict:
        raise PacketOrderError(
            "PAYOUT_UNAVAILABLE", "This payout setup could not be verified. Please retry."
        ) from None
    return account
