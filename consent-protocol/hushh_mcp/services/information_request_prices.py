"""Read-only prices for the existing person request and commerce ledger."""

from __future__ import annotations

import asyncio
from typing import Any

from hushh_mcp.consent.export_envelope import scope_handle_for_machine_scope
from hushh_mcp.consent.requestable_scope_policy import is_scope_requestable_by_others
from hushh_mcp.consent.scope_labels import human_scope_label
from hushh_mcp.services.scope_commerce.domain import (
    fingerprint,
    prorated_cents,
)


async def information_request_prices(
    *,
    requester_user_id: str,
    person_ref: str,
    scope_refs: list[str],
    duration_seconds: int,
    profiles: Any,
    commerce: Any,
    connection: Any = None,
) -> dict:
    """Preview current published terms without creating a request or a wallet.

    The binding covers price inputs, not the balance: adding coins must not
    change the reviewed offer. Send must recompute these terms in its own
    transaction before holding any funds.
    """
    if (
        not 1 <= len(scope_refs) <= 50
        or len(set(scope_refs)) != len(scope_refs)
        or isinstance(duration_seconds, bool)
        or not isinstance(duration_seconds, int)
        or not 3600 <= duration_seconds <= 2_592_000
        or duration_seconds % 3600
    ):
        raise ValueError("invalid_request_price_selection")
    if connection is None:
        from db.connection import get_pool

        pool = await get_pool()
        async with pool.acquire() as conn, conn.transaction():
            return await information_request_prices(
                requester_user_id=requester_user_id,
                person_ref=person_ref,
                scope_refs=scope_refs,
                duration_seconds=duration_seconds,
                profiles=profiles,
                commerce=commerce,
                connection=conn,
            )

    from hushh_mcp.services.scope_commerce.service import COMMERCE_GATE

    await connection.execute("SELECT pg_advisory_xact_lock($1)", COMMERCE_GATE)
    subject, scopes = await asyncio.to_thread(
        profiles.resolve_scope_refs,
        viewer_user_id=requester_user_id,
        public_person_ref=person_ref,
        scope_refs=scope_refs,
    )
    owner = str(subject["user_id"])
    terms, items = [], []
    for scope in sorted(scopes, key=lambda item: item["scopeRef"]):
        machine_scope = str(scope["scope"])
        if not is_scope_requestable_by_others(machine_scope):
            raise ValueError("scope_unavailable")
        handle = scope.get("registry_handle") or scope_handle_for_machine_scope(
            owner, machine_scope
        )
        tariff = await commerce.get_tariff(
            owner_user_id=owner,
            scope_handle=handle,
            machine_scope=machine_scope,
            conn=connection,
        )
        amount = (
            prorated_cents(tariff["priceCents"], tariff["baseDurationSeconds"], duration_seconds)
            if tariff
            else 0
        )
        terms.append([scope["scopeRef"], machine_scope, handle, tariff, amount])
        items.append(
            {
                "scopeRef": scope["scopeRef"],
                "label": human_scope_label(machine_scope, scope.get("label")),
                "amountCoins": amount,
            }
        )
    balance = await commerce.balance(payer_user_id=requester_user_id, conn=connection)
    available = balance["balanceCents"]
    total = sum(item["amountCoins"] for item in items)
    return {
        "version": 1,
        "personRef": person_ref,
        "durationSeconds": duration_seconds,
        "currency": "USD",
        "coinsPerDollar": 100,
        "items": items,
        "totalCoins": total,
        "availableCoins": available,
        "shortfallCoins": max(0, total - available),
        "binding": fingerprint([requester_user_id, owner, person_ref, duration_seconds, terms]),
    }


async def create_reviewed_request(service: Any, *, price_binding: str, **selection: Any) -> dict:
    """One commit for the request, its exact displayed prices and all coin holds."""
    import hashlib

    from db.connection import get_pool
    from hushh_mcp.services.information_request_service import (
        InformationRequestError,
        InformationRequestService,
    )
    from hushh_mcp.services.scope_commerce.service import COMMERCE_GATE, ScopeCommerceService
    from hushh_mcp.services.scope_commerce_requests import resolve_commerce_request

    pool = await get_pool()
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock($1)", COMMERCE_GATE)
        scoped = InformationRequestService(
            profiles=service._profiles, consent_db=service._consent, connection=conn
        )
        idem = hashlib.sha256(
            f"{selection['requester_user_id']}|{selection['idempotency_key']}".encode()
        ).hexdigest()
        existing = await conn.fetchrow(
            "SELECT bundle_id,request_fingerprint FROM one_information_request_bundles WHERE requester_user_id=$1 AND idempotency_hash=$2",
            selection["requester_user_id"],
            idem,
        )
        if existing:
            # A committed request is reconciled on its original terms. Balance,
            # tariff and quote expiry may legitimately have changed afterward.
            if existing["request_fingerprint"] != request_fingerprint(**selection):
                raise InformationRequestError(
                    "This request was already sent with different choices.", status_code=409
                )
            return await scoped.get(
                requester_user_id=selection["requester_user_id"],
                bundle_id=str(existing["bundle_id"]),
            )
        commerce = ScopeCommerceService()
        preview = await information_request_prices(
            **{
                key: selection[key]
                for key in ("requester_user_id", "person_ref", "scope_refs", "duration_seconds")
            },
            profiles=service._profiles,
            commerce=commerce,
            connection=conn,
        )
        if preview["binding"] != price_binding:
            raise InformationRequestError(
                "The price changed. Review it before sending.", status_code=409
            )
        if preview["shortfallCoins"]:
            raise InformationRequestError("Add coins before sending this request.", status_code=409)
        result = await scoped._create(**selection, reviewed_prices=preview)
        amounts = {item["scopeRef"]: item["amountCoins"] for item in preview["items"]}
        for item in result["items"]:
            if not amounts[item["scopeRef"]]:
                continue
            binding = await resolve_commerce_request(
                item["requestId"],
                selection["requester_user_id"],
                require_payer=True,
                connection=conn,
            )
            domain = binding["machine_scope"].split(".")[1]
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
                binding["owner_user_id"] + ":" + domain,
            )
            revision = await conn.fetchval(
                "SELECT manifest_version FROM pkm_manifests WHERE user_id=$1 AND domain=$2 FOR SHARE",
                binding["owner_user_id"],
                domain,
            )
            if not revision:
                raise InformationRequestError(
                    "This information is no longer available.", status_code=409
                )
            quote = await commerce.quote(
                **{
                    key: binding[key]
                    for key in (
                        "owner_user_id",
                        "buyer_app_id",
                        "payer_user_id",
                        "scope_handle",
                        "machine_scope",
                        "recipient_key_fingerprint",
                        "request_id",
                        "purpose",
                        "refresh_policy",
                        "duration_seconds",
                        "request_deadline",
                    )
                },
                scope_manifest_revision=revision,
                idempotency_key="request:" + item["requestId"],
                conn=conn,
            )
            if quote["priceCents"] != amounts[item["scopeRef"]]:
                raise InformationRequestError(
                    "The price changed. Review it before sending.", status_code=409
                )
            await commerce.reserve_information_request(
                payer_user_id=selection["requester_user_id"],
                quote_id=quote["quoteId"],
                idempotency_key="request:" + item["requestId"],
                conn=conn,
            )
        return result


def request_fingerprint(
    *,
    person_ref: str,
    scope_refs: list[str],
    purpose: str,
    duration_seconds: int,
    connector_key_id: str,
    **_: Any,
) -> str:
    return fingerprint(
        {
            "personRef": person_ref,
            "scopeRefs": sorted(scope_refs),
            "purpose": purpose.strip(),
            "durationSeconds": duration_seconds,
            "connectorKeyId": connector_key_id,
        }
    )
