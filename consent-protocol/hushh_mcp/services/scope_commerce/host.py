"""Host capability; composed by the canonical commerce transaction host."""

from __future__ import annotations

import os
from uuid import uuid4

from .domain import (
    CommerceError,
)

COMMERCE_GATE = 2690001


class CommerceRuntime:
    def __init__(self, pool=None, *, enabled: bool | None = None, provider_config=None):
        self.pool = pool
        self.enabled = enabled
        self.provider_config = provider_config

    def _config(self):
        if self.provider_config is None:
            from .provider_config import ScopeCommerceProviderConfig

            return ScopeCommerceProviderConfig.from_env()
        return self.provider_config

    def _admit(self) -> None:
        enabled = (
            self.enabled
            if self.enabled is not None
            else os.getenv("SCOPE_COMMERCE_ENABLED", "").lower() == "true"
        )
        if not enabled:
            raise CommerceError("commerce_unavailable")
        config = self._config()
        config.validate(new_activity=True)
        if not config.countries:
            raise CommerceError("provider_configuration_required")
        if self.provider_config is None:
            from .provider_prerequisites import provider_prerequisites

            prerequisites = provider_prerequisites(config, new_activity=True)
            if not prerequisites["ready"]:
                raise CommerceError(prerequisites["reason_code"])
        if os.getenv("DB_OFFLINE", "").lower() in {"1", "true", "yes", "on"} and self.pool is None:
            raise CommerceError("commerce_requires_postgres")

    async def _transaction(self, operation, conn=None):
        if conn is not None:
            await conn.execute("SELECT pg_advisory_xact_lock($1)", COMMERCE_GATE)
            return await operation(conn)
        pool = self.pool
        if pool is None:
            from db.connection import get_pool

            pool = await get_pool()
            # SQLite offline adapter cannot enforce this accounting contract.
            if pool.__class__.__module__.startswith("db.offline"):
                raise CommerceError("commerce_requires_postgres")
        async with pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute("SELECT pg_advisory_xact_lock($1)", COMMERCE_GATE)
                return await operation(connection)

    @staticmethod
    async def _row(conn, sql, *args):
        row = await conn.fetchrow(sql, *args)
        if row is None:
            return None
        result = dict(row)
        if result.get("status") == "staged" and "admission_now" not in result:
            result["admission_now"] = await conn.fetchval("SELECT clock_timestamp()")
        return result


class CommerceEnvironment:
    async def bind_environment(self, *, platform_account_id, livemode, conn=None):
        """Trusted adapter port: call only after retrieving actual platform identity.

        A database is permanently bound to one provider account and mode. Flags
        cannot turn historical sandbox credit into live purchasing power.
        """
        if type(livemode) is not bool or not str(platform_account_id).startswith("acct_"):
            raise CommerceError("provider_identity_invalid")

        async def operation(c):
            existing = await c.fetchrow("SELECT * FROM scope_commerce_environment FOR UPDATE")
            if existing:
                if (
                    existing["platform_account_id"] != platform_account_id
                    or existing["livemode"] != livemode
                ):
                    raise CommerceError("commerce_environment_mismatch")
            else:
                if await c.fetchval("SELECT EXISTS(SELECT 1 FROM scope_commerce_journal)"):
                    raise CommerceError("commerce_environment_unbound")
                await c.execute(
                    "INSERT INTO scope_commerce_environment(singleton,platform_account_id,livemode) VALUES(true,$1,$2)",
                    platform_account_id,
                    livemode,
                )
            config = self._config()
            if config.platform_account_id != platform_account_id or config.livemode != livemode:
                raise CommerceError("commerce_environment_mismatch")
            return {"platform_account_id": platform_account_id, "livemode": livemode}

        return await self._transaction(operation, conn)

    async def _environment(self, c, *, seller_user_id=None, livemode=None):
        config = self._config()
        pin = await c.fetchrow("SELECT * FROM scope_commerce_environment FOR SHARE")
        if not pin:
            raise CommerceError("commerce_environment_unbound")
        if (
            pin["platform_account_id"] != config.platform_account_id
            or pin["livemode"] != config.livemode
            or (livemode is not None and pin["livemode"] != livemode)
        ):
            raise CommerceError("commerce_environment_mismatch")
        if seller_user_id is not None:
            seller = await c.fetchrow(
                "SELECT * FROM scope_commerce_seller_accounts WHERE user_id=$1 FOR SHARE",
                seller_user_id,
            )
            if (
                not seller
                or not seller["eligible"]
                or seller["livemode"] != pin["livemode"]
                or seller["country"] not in config.countries
            ):
                raise CommerceError("seller_onboarding_required")
        return pin


class CommerceJournal:
    @staticmethod
    async def _post(conn, key: str, kind: str, postings: dict[str, int], reference_id: str):
        postings = {k: v for k, v in postings.items() if v}
        if not postings:
            return None
        if (
            len(postings) < 2
            or sum(postings.values()) != 0
            or any(type(v) is not int for v in postings.values())
        ):
            raise CommerceError("unbalanced_posting")
        existing = await conn.fetchrow(
            "SELECT * FROM scope_commerce_journal WHERE idempotency_key=$1", key
        )
        if existing:
            actual = {
                r["account"]: r["micro_usd"]
                for r in await conn.fetch(
                    "SELECT account,micro_usd FROM scope_commerce_postings WHERE entry_id=$1",
                    existing["entry_id"],
                )
            }
            if (
                actual != postings
                or existing["kind"] != kind
                or existing["reference_id"] != str(reference_id)
            ):
                raise CommerceError("idempotency_conflict")
            return existing["entry_id"]
        entry = uuid4()
        await conn.execute(
            "INSERT INTO scope_commerce_journal VALUES($1,$2,$3,$4,clock_timestamp())",
            entry,
            key,
            kind,
            str(reference_id),
        )
        await conn.executemany(
            "INSERT INTO scope_commerce_postings(entry_id,account,micro_usd) VALUES($1,$2,$3)",
            [(entry, k, v) for k, v in postings.items()],
        )
        return entry

    @staticmethod
    async def _amount(conn, name: str) -> int:
        return await conn.fetchval(
            "SELECT COALESCE(sum(micro_usd),0)::bigint FROM scope_commerce_postings WHERE account=$1",
            name,
        )


class CommerceIdentity:
    async def _wallet(self, conn, payer_user_id: str, buyer_app_id: str = "shared", lock=True):
        buyer_app_id = buyer_app_id or "shared"
        # Registry authority is rechecked, not inferred from a contact email or
        # OAuth/MCP metadata. Partner apps need explicit payer delegation first.
        if buyer_app_id not in {"shared", "agent_one"}:
            app = await conn.fetchrow(
                "SELECT owner_firebase_uid,status FROM developer_apps WHERE app_id=$1 FOR SHARE",
                buyer_app_id,
            )
            if not app or app["status"] != "active" or app["owner_firebase_uid"] != payer_user_id:
                raise CommerceError("payer_app_binding_required")
        await conn.execute(
            "INSERT INTO scope_commerce_wallets(wallet_id,payer_user_id,buyer_app_id) VALUES($1,$2,'shared') ON CONFLICT(payer_user_id,buyer_app_id) DO NOTHING",
            uuid4(),
            payer_user_id,
        )
        row = await self._row(
            conn,
            "SELECT * FROM scope_commerce_wallets WHERE payer_user_id=$1 AND buyer_app_id='shared' FOR UPDATE",
            payer_user_id,
        )
        if row["erased_at"]:
            raise CommerceError("account_erased")
        return row

    async def _paid_admission(self, c):
        await self._environment(c)
        if await c.fetchval(
            "SELECT EXISTS(SELECT 1 FROM scope_commerce_obligations WHERE kind='recovery' AND idempotency_key LIKE 'retention:%' AND status<>'succeeded')"
        ):
            raise CommerceError("commerce_retention_resolution_required")

    async def _seller(self, conn, owner_user_id: str):
        await conn.execute(
            "INSERT INTO scope_commerce_sellers(seller_id,owner_user_id) VALUES($1,$2) ON CONFLICT(owner_user_id) DO NOTHING",
            uuid4(),
            owner_user_id,
        )
        return await self._row(
            conn,
            "SELECT * FROM scope_commerce_sellers WHERE owner_user_id=$1 FOR UPDATE",
            owner_user_id,
        )

    async def _registered_key(self, c, p):
        if p["buyer_app_id"] == "agent_one":
            row = await self._row(
                c,
                "SELECT connector_key_id,connector_public_key,connector_wrapping_alg FROM one_kyc_client_connectors WHERE user_id=$1 AND status='active' FOR SHARE",
                p["payer_user_id"],
            )
        else:
            row = await self._row(
                c,
                "SELECT connector_key_id,connector_public_key,connector_wrapping_alg FROM developer_connector_keys WHERE app_id=$1 AND status='active' FOR SHARE",
                p["buyer_app_id"],
            )
        if not row:
            raise CommerceError("registered_recipient_key_required")
        from hushh_mcp.consent.export_envelope import connector_key_fingerprint

        if connector_key_fingerprint(row["connector_public_key"]) != p["recipient_key_fingerprint"]:
            raise CommerceError("recipient_key_changed")
        return row
