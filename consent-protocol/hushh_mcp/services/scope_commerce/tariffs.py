"""Tariffs capability; composed by the canonical commerce transaction host."""

from __future__ import annotations

from uuid import uuid4

from .domain import (
    CommerceError,
    fingerprint,
)


class ScopeTariffs:
    async def set_tariff(
        self,
        *,
        owner_user_id,
        scope_handle,
        machine_scope,
        price_cents,
        base_duration_seconds,
        idempotency_key,
        conn=None,
    ):
        from .domain import prorated_cents

        prorated_cents(price_cents, base_duration_seconds, base_duration_seconds)
        if price_cents:
            self._admit()
        if not owner_user_id or not scope_handle or not machine_scope or not idempotency_key:
            raise CommerceError("invalid_tariff_binding")
        digest = fingerprint([scope_handle, machine_scope, price_cents, base_duration_seconds])

        async def operation(c):
            if price_cents:
                await self._paid_admission(c)
                await self._environment(c, seller_user_id=owner_user_id)
            if price_cents and not await c.fetchval(
                "SELECT eligible FROM scope_commerce_seller_accounts WHERE user_id=$1 FOR SHARE",
                owner_user_id,
            ):
                raise CommerceError("seller_onboarding_required")
            old = await self._row(
                c,
                "SELECT * FROM scope_commerce_tariffs WHERE owner_user_id=$1 AND idempotency_key=$2",
                owner_user_id,
                idempotency_key,
            )
            if old:
                if old["request_hash"] != digest:
                    raise CommerceError("idempotency_conflict")
                return self._tariff_public(old)
            revision = await c.fetchval(
                "SELECT COALESCE(max(revision),0)+1 FROM scope_commerce_tariffs WHERE owner_user_id=$1 AND scope_handle=$2 AND machine_scope=$3",
                owner_user_id,
                scope_handle,
                machine_scope,
            )
            row = await self._row(
                c,
                "INSERT INTO scope_commerce_tariffs(tariff_id,owner_user_id,scope_handle,machine_scope,revision,price_cents,base_duration_seconds,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
                uuid4(),
                owner_user_id,
                scope_handle,
                machine_scope,
                revision,
                price_cents,
                base_duration_seconds,
                idempotency_key,
                digest,
            )
            return self._tariff_public(row)

        return await self._transaction(operation, conn)

    @staticmethod
    def _tariff_public(row):
        return {
            "scopeHandle": row["scope_handle"],
            "machineScope": row["machine_scope"],
            "priceCents": row["price_cents"],
            "baseDurationSeconds": row["base_duration_seconds"],
            "tariffRevision": row["revision"],
            "currency": "usd",
        }

    async def get_tariff(self, *, owner_user_id, scope_handle, machine_scope=None, conn=None):
        async def operation(c):
            rows = await c.fetch(
                "SELECT DISTINCT ON(machine_scope) * FROM scope_commerce_tariffs WHERE owner_user_id=$1 AND scope_handle=$2 AND ($3::text IS NULL OR machine_scope=$3) ORDER BY machine_scope,revision DESC LIMIT 2",
                owner_user_id,
                scope_handle,
                machine_scope,
            )
            if len(rows) > 1:
                raise CommerceError("exact_machine_scope_required")
            return self._tariff_public(dict(rows[0])) if rows else None

        return await self._transaction(operation, conn)

    async def list_tariffs(self, *, owner_user_id, conn=None):
        async def operation(c):
            return [
                self._tariff_public(dict(r))
                for r in await c.fetch(
                    "SELECT DISTINCT ON(scope_handle,machine_scope) * FROM scope_commerce_tariffs WHERE owner_user_id=$1 ORDER BY scope_handle,machine_scope,revision DESC",
                    owner_user_id,
                )
            ]

        return await self._transaction(operation, conn)
