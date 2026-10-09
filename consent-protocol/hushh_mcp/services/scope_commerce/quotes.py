"""Quotes capability; composed by the canonical commerce transaction host."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from .domain import (
    CommerceError,
    fingerprint,
    public,
)


class ImmutableQuotes:
    async def quote(
        self,
        *,
        owner_user_id,
        buyer_app_id,
        payer_user_id,
        scope_handle,
        machine_scope,
        duration_seconds,
        recipient_key_fingerprint,
        idempotency_key,
        request_id,
        purpose,
        refresh_policy,
        scope_manifest_revision,
        request_deadline=None,
        conn=None,
    ):
        self._admit()
        if request_deadline is not None and (
            not isinstance(request_deadline, datetime) or request_deadline.tzinfo is None
        ):
            raise CommerceError("invalid_request_deadline")
        if (
            not re.fullmatch(r"sha256:[0-9a-f]{64}", recipient_key_fingerprint)
            or not request_id
            or not purpose
            or not scope_manifest_revision
            or refresh_policy not in {"snapshot", "continuous_until_expiry"}
        ):
            raise CommerceError("invalid_quote_binding")
        digest = fingerprint(
            [
                owner_user_id,
                buyer_app_id,
                payer_user_id,
                scope_handle,
                machine_scope,
                duration_seconds,
                recipient_key_fingerprint,
                request_id,
                purpose,
                refresh_policy,
                scope_manifest_revision,
                request_deadline,
            ]
        )

        async def operation(c):
            return await self._tx_quote(
                c,
                owner_user_id,
                buyer_app_id,
                payer_user_id,
                scope_handle,
                machine_scope,
                duration_seconds,
                recipient_key_fingerprint,
                idempotency_key,
                request_id,
                purpose,
                refresh_policy,
                scope_manifest_revision,
                request_deadline,
                digest,
            )

        return await self._transaction(operation, conn)

    async def _tx_quote(
        self,
        c: Any,
        owner_user_id: Any,
        buyer_app_id: Any,
        payer_user_id: Any,
        scope_handle: Any,
        machine_scope: Any,
        duration_seconds: Any,
        recipient_key_fingerprint: Any,
        idempotency_key: Any,
        request_id: Any,
        purpose: Any,
        refresh_policy: Any,
        scope_manifest_revision: Any,
        request_deadline: Any,
        digest: Any,
    ) -> Any:
        await self._environment(c)
        await self._validate_quote_payer(c, buyer_app_id, payer_user_id, owner_user_id, request_id)
        wallet = await self._wallet(c, payer_user_id, buyer_app_id)
        seller = await self._seller(c, owner_user_id)
        if buyer_app_id == "shared":
            raise CommerceError("requester_app_required")
        await self._registered_key(
            c,
            {
                "buyer_app_id": buyer_app_id,
                "payer_user_id": payer_user_id,
                "recipient_key_fingerprint": recipient_key_fingerprint,
            },
        )
        old = await self._row(
            c,
            "SELECT * FROM scope_commerce_quotes WHERE request_id=$1 OR (wallet_id=$2 AND idempotency_key=$3)",
            request_id,
            wallet["wallet_id"],
            idempotency_key,
        )
        if old:
            if old["request_hash"] != digest:
                raise CommerceError("idempotency_conflict")
            if old["price_cents"]:
                self._admit_actors(owner_user_id, payer_user_id)
            return await self._quote_public(c, old)
        tariff, price = await self._quote_tariff(
            c, owner_user_id, scope_handle, machine_scope, duration_seconds
        )
        if price:
            self._admit_actors(owner_user_id, payer_user_id)
        row = await self._persist_quote(
            c,
            request_id,
            tariff,
            seller,
            wallet,
            owner_user_id,
            payer_user_id,
            buyer_app_id,
            machine_scope,
            scope_handle,
            recipient_key_fingerprint,
            scope_manifest_revision,
            purpose,
            refresh_policy,
            duration_seconds,
            price,
            idempotency_key,
            digest,
            request_deadline,
        )
        return await self._quote_public(c, row)

    async def _validate_quote_payer(
        self, c: Any, buyer_app_id: str, payer_user_id: str, owner_user_id: str, request_id: str
    ):
        if buyer_app_id == "agent_one":
            # Personal requests have a different existing authority; never
            # treat the shared first-party app registration as a payer grant.
            bundle = await c.fetchrow(
                """SELECT b.requester_user_id,b.subject_user_id FROM one_information_request_bundles b JOIN one_information_request_items i USING(bundle_id) WHERE i.request_id=$1 FOR SHARE OF b,i""",
                request_id,
            )
            marketplace = (
                await c.fetchrow(
                    "SELECT buyer_user_id,owner_user_id FROM marketplace_access_requests WHERE id::text=$1 FOR SHARE",
                    request_id,
                )
                if not bundle
                else None
            )
            personal_ok = (
                bundle
                and bundle["requester_user_id"] == payer_user_id
                and bundle["subject_user_id"] == owner_user_id
            )
            marketplace_ok = (
                marketplace
                and marketplace["buyer_user_id"] == payer_user_id
                and marketplace["owner_user_id"] == owner_user_id
            )
            if not personal_ok and not marketplace_ok:
                raise CommerceError("payer_request_binding_required")

    async def _persist_quote(
        self,
        c: Any,
        request_id: str,
        tariff: dict[str, Any],
        seller: dict[str, Any],
        wallet: dict[str, Any],
        owner_user_id: str,
        payer_user_id: str,
        buyer_app_id: str,
        machine_scope: str,
        scope_handle: str,
        recipient_key_fingerprint: str,
        scope_manifest_revision: Any,
        purpose: str,
        refresh_policy: str,
        duration_seconds: int,
        price: int,
        idempotency_key: str,
        digest: str,
        request_deadline: datetime | None,
    ):
        row = await self._row(
            c,
            """INSERT INTO scope_commerce_quotes(quote_id,request_id,tariff_id,seller_id,wallet_id,owner_user_id,payer_user_id,buyer_app_id,machine_scope,scope_handle,recipient_key_fingerprint,scope_manifest_revision,purpose,refresh_policy,duration_seconds,price_cents,idempotency_key,request_hash,expires_at,request_deadline)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,LEAST(clock_timestamp()+interval '15 minutes',$19::timestamptz),$19) RETURNING *""",
            uuid4(),
            request_id,
            tariff["tariff_id"],
            seller["seller_id"],
            wallet["wallet_id"],
            owner_user_id,
            payer_user_id,
            buyer_app_id,
            machine_scope,
            scope_handle,
            recipient_key_fingerprint,
            str(scope_manifest_revision),
            purpose,
            refresh_policy,
            duration_seconds,
            price,
            idempotency_key,
            digest,
            request_deadline,
        )
        return row

    async def _quote_tariff(
        self,
        c: Any,
        owner_user_id: str,
        scope_handle: str,
        machine_scope: str,
        duration_seconds: int,
    ):
        tariff = await self._row(
            c,
            "SELECT * FROM scope_commerce_tariffs WHERE owner_user_id=$1 AND scope_handle=$2 AND machine_scope=$3 ORDER BY revision DESC LIMIT 1",
            owner_user_id,
            scope_handle,
            machine_scope,
        )
        if not tariff or tariff["machine_scope"] != machine_scope:
            raise CommerceError("exact_tariff_required")
        from .domain import prorated_cents

        price = prorated_cents(
            tariff["price_cents"], tariff["base_duration_seconds"], duration_seconds
        )
        if price:
            await self._paid_admission(c)
        return tariff, price


class QuoteApproval:
    async def approve_quote(
        self, *, owner_user_id, quote_id, request_id, consent_token=None, conn=None
    ):
        self._admit()

        async def operation(c):
            await self._environment(c)
            quote = await self._row(
                c,
                "SELECT * FROM scope_commerce_quotes WHERE quote_id=$1 AND owner_user_id=$2 AND request_id=$3 FOR UPDATE",
                UUID(str(quote_id)),
                owner_user_id,
                request_id,
            )
            if not quote:
                raise CommerceError("quote_unavailable")
            if quote["price_cents"]:
                self._admit_actors(quote["owner_user_id"], quote["payer_user_id"])
            old = await self._row(
                c, "SELECT * FROM scope_commerce_purchases WHERE quote_id=$1", quote["quote_id"]
            )
            if old:
                return public(old)
            now = await c.fetchval("SELECT clock_timestamp()")
            if now >= quote["expires_at"]:
                raise CommerceError("quote_expired")
            row = await self._row(
                c,
                """INSERT INTO scope_commerce_purchases(purchase_id,quote_id,request_id,owner_user_id,payer_user_id,buyer_app_id,seller_id,wallet_id,machine_scope,scope_handle,recipient_key_fingerprint,status,price_cents,duration_seconds,fulfillment_deadline)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'awaiting_payment',$12,$13,LEAST(clock_timestamp()+interval '24 hours',$14::timestamptz)) RETURNING *""",
                uuid4(),
                quote["quote_id"],
                request_id,
                owner_user_id,
                quote["payer_user_id"],
                quote["buyer_app_id"],
                quote["seller_id"],
                quote["wallet_id"],
                quote["machine_scope"],
                quote["scope_handle"],
                quote["recipient_key_fingerprint"],
                quote["price_cents"],
                quote["duration_seconds"],
                quote["request_deadline"],
            )
            if consent_token:
                await self.bind_consent_token(
                    purchase_id=row["purchase_id"], token=consent_token, conn=c
                )
            return public(row)

        return await self._transaction(operation, conn)


class QuoteReadProjection:
    async def _quote_public(self, c, row):
        tariff = await self._row(
            c, "SELECT * FROM scope_commerce_tariffs WHERE tariff_id=$1", row["tariff_id"]
        )
        result = public(
            {
                **row,
                "base_price_cents": tariff["price_cents"],
                "base_duration_seconds": tariff["base_duration_seconds"],
                "tariff_revision": tariff["revision"],
            }
        )
        result["quoteExpiresAt"] = result.pop("expiresAt")
        result["status"] = "quoted"
        return result

    async def get_quote_by_request(self, request_id, buyer_app_id=None, conn=None):
        async def operation(c):
            row = await self._row(
                c, "SELECT * FROM scope_commerce_quotes WHERE request_id=$1", request_id
            )
            if row and buyer_app_id and row["buyer_app_id"] != buyer_app_id:
                raise CommerceError("request_unavailable")
            return await self._quote_public(c, row) if row else None

        return await self._transaction(operation, conn)
