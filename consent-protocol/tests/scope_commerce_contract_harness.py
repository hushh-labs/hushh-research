"""Typed HTTP, encrypted fixture and clock seams for paid consent contracts.

All authorization, money and admission decisions remain in the real services.
The synthetic envelope exercises its metadata contract, not cryptographic secrecy.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import asyncpg
import httpx
import pytest

from hushh_mcp.consent.export_envelope import (
    canonical_aad_bytes,
    connector_key_fingerprint,
    digest_bytes,
)
from hushh_mcp.consent.token import issue_token
from hushh_mcp.services.consent_db import ConsentDBService
from hushh_mcp.services.scope_commerce import ScopeCommerceService, domain

JsonObject = dict[str, Any]
SCOPE = "attr.travel.preferences.*"
HANDLE = "s_registry_contract_fixture"
PUBLIC_KEY = base64.b64encode(b"k" * 32).decode()
FINGERPRINT = connector_key_fingerprint(PUBLIC_KEY)


@dataclass(frozen=True)
class Reservation:
    request_id: str
    purchase_id: str
    quote: JsonObject


@dataclass(frozen=True)
class Grant:
    token: str
    request_id: str
    export_id: str
    expires_at_ms: int

    async def exports(self) -> list[JsonObject | None]:
        consent = ConsentDBService()
        return [
            await consent.get_consent_export(self.token),
            await consent.get_consent_export_by_grant(self.request_id, app_id="app"),
            await consent.get_consent_export_by_id(self.export_id),
            await consent.get_consent_export_metadata(self.token),
        ]


@dataclass(frozen=True)
class PaidGrant:
    reservation: Reservation
    grant: Grant
    context: JsonObject
    metadata: JsonObject


@dataclass(frozen=True)
class PaidContract:
    client: httpx.AsyncClient
    pool: asyncpg.Pool
    service: ScopeCommerceService
    request_id: str

    async def post(self, path: str, body: JsonObject, identity: str = "payer") -> httpx.Response:
        return await self.client.post(
            "/api/scope-commerce" + path,
            json=body,
            headers={"X-Contract-Identity": identity},
        )

    async def get(self, path: str, identity: str = "payer") -> httpx.Response:
        return await self.client.get(
            "/api/scope-commerce" + path, headers={"X-Contract-Identity": identity}
        )

    async def tariff(self, price: int = 1, duration: int = 3600) -> httpx.Response:
        return await self.post(
            "/tariffs",
            {
                "idempotency_key": str(uuid4()),
                "scope_handle": HANDLE,
                "machine_scope": SCOPE,
                "price_cents": price,
                "base_duration_seconds": duration,
            },
            "owner",
        )

    async def approve(self, request_id: str, identity: str = "owner") -> httpx.Response:
        return await self.post(
            f"/requests/{request_id}/approve",
            {"duration_seconds": 3600, "idempotency_key": str(uuid4())},
            identity,
        )

    async def quote(self, request_id: str) -> httpx.Response:
        return await self.post(
            "/quotes",
            {"request_id": request_id, "duration_seconds": 3600, "idempotency_key": str(uuid4())},
        )

    async def fund(self) -> None:
        funding_id = str(uuid4())
        await self.service.reserve_funding(
            payer_user_id="payer", funding_id=funding_id, amount_cents=50
        )
        # Provider verification is tested by the provider suite. This canonical
        # successful receipt is never accepted through a caller HTTP endpoint.
        await self.service.settle_funding(
            payer_user_id="payer",
            buyer_app_id="shared",
            funding_id=funding_id,
            amount_cents=50,
            fee_micro_usd=0,
            livemode=False,
            payment_intent_id="pi_contract",
            charge_id="ch_contract",
            balance_transaction_id="txn_contract",
            provider_event_id="evt_contract",
        )

    async def additional_request(self, refresh_policy: str = "snapshot") -> str:
        request_id = "req_paid_parallel_" + uuid4().hex
        async with self.pool.acquire() as conn, conn.transaction():
            metadata = json.loads(
                await conn.fetchval(
                    "SELECT metadata FROM consent_audit WHERE request_id=$1 AND action='REQUESTED'",
                    self.request_id,
                )
            )
            metadata["refresh_policy"] = refresh_policy
            await conn.execute(
                "UPDATE contract_clock SET observed_at=observed_at+interval '1 minute'"
            )
            await ConsentDBService().insert_event(
                user_id="owner",
                agent_id="developer:app",
                scope=SCOPE,
                action="REQUESTED",
                request_id=request_id,
                metadata=metadata,
                connection=conn,
            )
        return request_id

    async def prepare(self, reservation: Reservation) -> JsonObject:
        response = await self.post(
            f"/purchases/{reservation.purchase_id}/prepare",
            {"source_revisions": {"content_revision": 1, "manifest_revision": 1}},
            "owner",
        )
        assert response.status_code == 200, response.text
        return response.json()

    async def stage(self, reservation: Reservation, context: JsonObject) -> PaidGrant:
        response = await self.post(
            f"/purchases/{reservation.purchase_id}/stage",
            {"preparation_id": context["preparation_id"], "envelope": encrypted_package(context)},
            "owner",
        )
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "armed"
        assert "consent_token" not in response.text and "wrapped_export_key" not in response.text
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT token_id,metadata FROM consent_audit WHERE request_id=$1 AND action='CONSENT_GRANTED'",
                reservation.request_id,
            )
        grant = Grant(
            row["token_id"], reservation.request_id, context["export_id"], context["expires_at_ms"]
        )
        return PaidGrant(reservation, grant, context, json.loads(row["metadata"]))

    async def activate(self, paid: PaidGrant, monkeypatch: pytest.MonkeyPatch) -> None:
        active_at = datetime.fromtimestamp(paid.context["starts_at_ms"] / 1000, UTC) + timedelta(
            seconds=1
        )
        async with self.pool.acquire() as conn:
            await conn.execute("UPDATE contract_clock SET observed_at=$1", active_at)
        monkeypatch.setattr(domain, "utcnow", lambda: active_at)


async def approved_quote(ctx: PaidContract, request_id: str | None = None) -> JsonObject:
    request_id = request_id or ctx.request_id
    approval = await ctx.approve(request_id)
    assert approval.status_code == 200, approval.text
    quote = await ctx.quote(request_id)
    assert quote.status_code == 200, quote.text
    return quote.json()


async def reserve_quote(ctx: PaidContract, quote: JsonObject, request_id: str) -> Reservation:
    response = await ctx.post(
        "/purchases", {"quote_id": quote["id"], "confirmed": True, "idempotency_key": str(uuid4())}
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "reserved"
    return Reservation(request_id, response.json()["id"], quote)


async def funded_reservation(ctx: PaidContract) -> Reservation:
    response = await ctx.tariff()
    assert response.status_code == 200, response.text
    quote = await approved_quote(ctx)
    await ctx.fund()
    return await reserve_quote(ctx, quote, ctx.request_id)


async def staged_purchase(ctx: PaidContract) -> PaidGrant:
    reservation = await funded_reservation(ctx)
    return await ctx.stage(reservation, await ctx.prepare(reservation))


async def additional_purchase(ctx: PaidContract, refresh_policy: str = "snapshot") -> PaidGrant:
    request_id = await ctx.additional_request(refresh_policy)
    quote = await approved_quote(ctx, request_id)
    reservation = await reserve_quote(ctx, quote, request_id)
    return await ctx.stage(reservation, await ctx.prepare(reservation))


def encrypted_package(context: JsonObject) -> JsonObject:
    ciphertext = b"synthetic-encrypted-information"
    aad = {
        "version": 2,
        "app_id": "app",
        "grant_id": context["grant_id"],
        "export_id": context["export_id"],
        "revision": 1,
        "machine_scope": SCOPE,
        "scope_handle": HANDLE,
        "recipient_key_fingerprint": FINGERPRINT,
        "payload_algorithm": "AES-256-GCM",
        "expires_at_ms": context["expires_at_ms"],
    }
    return {
        "ciphertext": base64.b64encode(ciphertext).decode(),
        "iv": base64.b64encode(b"i" * 12).decode(),
        "tag": base64.b64encode(b"t" * 16).decode(),
        "wrappedKey": {
            "connector_key_id": "key",
            "wrapping_alg": "X25519-AES256-GCM",
            "wrapped_export_key": base64.b64encode(b"w" * 32).decode(),
            "wrapped_key_iv": base64.b64encode(b"j" * 12).decode(),
            "wrapped_key_tag": base64.b64encode(b"u" * 16).decode(),
            "sender_public_key": base64.b64encode(b"p" * 32).decode(),
        },
        "exportEnvelope": {
            "version": 2,
            "export_id": aad["export_id"],
            "aad": aad,
            "aad_sha256": digest_bytes(canonical_aad_bytes(aad)),
            "ciphertext_sha256": digest_bytes(ciphertext),
            "ciphertext_bytes": len(ciphertext),
        },
        "sourceRevisions": {"contentRevision": 1, "manifestRevision": 1},
    }


async def existing_free_grant(ctx: PaidContract) -> Grant:
    """Genuine earlier v2 consent; no commercial terms or simulated admission."""
    request_id, export_id = "req_free_" + uuid4().hex, uuid4().hex
    expiry_ms = int((datetime.now(UTC) + timedelta(hours=2)).timestamp() * 1000)
    token = issue_token(
        user_id="owner", agent_id="developer:app", scope=SCOPE, expires_at_ms=expiry_ms
    ).token
    package = encrypted_package(
        {"grant_id": request_id, "export_id": export_id, "expires_at_ms": expiry_ms}
    )
    envelope = package["exportEnvelope"]
    async with ctx.pool.acquire() as conn, conn.transaction():
        assert await ConsentDBService().store_consent_export(
            consent_token=token,
            user_id="owner",
            encrypted_data=package["ciphertext"],
            iv=package["iv"],
            tag=package["tag"],
            export_key=None,
            wrapped_key_bundle=package["wrappedKey"],
            scope=SCOPE,
            expires_at_ms=expiry_ms,
            export_id=export_id,
            envelope_version=2,
            grant_id=request_id,
            app_id="app",
            scope_handle=HANDLE,
            recipient_key_fingerprint=FINGERPRINT,
            envelope_aad=envelope["aad"],
            envelope_aad_sha256=envelope["aad_sha256"],
            ciphertext_sha256=envelope["ciphertext_sha256"],
            ciphertext_bytes=envelope["ciphertext_bytes"],
            connection=conn,
        )
        await ConsentDBService().insert_event(
            user_id="owner",
            agent_id="developer:app",
            scope=SCOPE,
            action="CONSENT_GRANTED",
            token_id=token,
            request_id=request_id,
            expires_at=expiry_ms,
            metadata={"developer_app_id": "app", "scope_handle": HANDLE},
            connection=conn,
        )
    return Grant(token, request_id, export_id, expiry_ms)


async def active_token_ids() -> set[str]:
    return {
        row["token_id"]
        for row in await ConsentDBService().get_active_tokens(
            "owner", agent_id="developer:app", scope=SCOPE
        )
    }
