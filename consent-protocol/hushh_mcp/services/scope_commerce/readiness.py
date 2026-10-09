"""Caller-scoped configuration and persisted readiness; no provider I/O or writes."""

from __future__ import annotations

import os
from typing import Any, Literal, TypedDict


class PlatformReadiness(TypedDict):
    status: Literal["disabled", "unconfigured", "unverified", "ready"]
    reason_code: str | None
    verification_scope: Literal["configured_and_persisted"]


class SellerReadiness(TypedDict):
    status: Literal["not_onboarded", "not_eligible", "eligible"]
    reason_code: str | None


def _platform(status: str, reason: str | None) -> dict[str, Any]:
    return {
        "status": status,
        "reason_code": reason,
        "verification_scope": "configured_and_persisted",
    }


def _seller_status(row, config, pin) -> SellerReadiness:
    if not row:
        return {"status": "not_onboarded", "reason_code": "seller_onboarding_required"}
    reason = "seller_not_eligible"
    if config is not None and row["country"] not in config.countries:
        reason = "seller_country_unavailable"
    elif pin is not None and row["livemode"] != pin["livemode"]:
        reason = "seller_account_mismatch"
    elif row["eligible"]:
        return {"status": "eligible", "reason_code": None}
    return {"status": "not_eligible", "reason_code": reason}


class CommerceReadiness:
    def _commerce_enabled(self) -> bool:
        return (
            self.enabled
            if self.enabled is not None
            else os.getenv("SCOPE_COMMERCE_ENABLED", "").lower() == "true"
        )

    def _configured_platform(self):
        if not self._commerce_enabled():
            return None, _platform("disabled", "commerce_disabled")
        try:
            config = self._config()
            if not config.enabled:
                return config, _platform("disabled", "provider_disabled")
            config.validate(new_activity=True)
            if not config.countries:
                return config, _platform("unconfigured", "provider_configuration_required")
            if self.provider_config is None:
                from .provider_prerequisites import provider_prerequisites

                prerequisites = provider_prerequisites(config, new_activity=True)
                if not prerequisites["ready"]:
                    reason = prerequisites["reason_code"]
                    return config, _platform(
                        "unconfigured",
                        "provider_configuration_required"
                        if reason
                        in {"provider_unavailable", "provider_sandbox_environment_mismatch"}
                        else reason,
                    )
        except Exception as error:
            # Configuration validation exposes only typed safe reasons. Never
            # echo parser diagnostics, account identifiers or credential values.
            code = getattr(error, "code", "")
            reason = (
                code
                if code == "provider_sandbox_policy_required"
                else "provider_configuration_required"
            )
            return None, _platform("unconfigured", reason)
        return config, _platform("ready", None)

    async def readiness(self, *, viewer_user_id: str, conn: Any = None) -> dict[str, Any]:
        config, configured = self._configured_platform()

        async def operation(c):
            tables = await c.fetchrow(
                """SELECT to_regclass('scope_commerce_tariffs') IS NOT NULL AS tariffs,
                to_regclass('scope_commerce_environment') IS NOT NULL AS environment,
                to_regclass('scope_commerce_seller_accounts') IS NOT NULL AS sellers,
                to_regclass('scope_commerce_obligations') IS NOT NULL AS obligations"""
            )
            schema = all(tables.values())
            pin = (
                await c.fetchrow("SELECT * FROM scope_commerce_environment WHERE singleton")
                if tables["environment"]
                else None
            )
            seller = (
                await c.fetchrow(
                    "SELECT eligible,country,livemode FROM scope_commerce_seller_accounts WHERE user_id=$1",
                    viewer_user_id,
                )
                if tables["sellers"]
                else None
            )
            platform = dict(configured)
            if platform["status"] == "ready":
                platform = await self._persisted_platform(c, config, pin, schema)
            seller_state = _seller_status(seller, config, pin)
            ready = platform["status"] == "ready" and config.allows_actor(viewer_user_id)
            eligible = ready and seller_state["status"] == "eligible"
            return {
                "schema_version": 1,
                "enabled": self._commerce_enabled(),
                "free": {
                    "requires_payment_provider": False,
                    "requires_owner_approval": True,
                    "tariff_controls_available": bool(tables["tariffs"]),
                },
                "platform": platform,
                "seller": seller_state,
                "capabilities": {
                    "set_free_tariff": bool(tables["tariffs"]),
                    "set_paid_tariff": eligible,
                    "approve_paid_request": eligible,
                    "reserve_paid_purchase": ready,
                    "start_funding": ready,
                    "start_onboarding": ready,
                },
            }

        return await self._transaction(operation, conn)

    async def _persisted_platform(self, c, config, pin, schema) -> PlatformReadiness:
        if not schema:
            return _platform("unconfigured", "commerce_schema_required")
        if not pin:
            return _platform("unverified", "platform_account_unverified")
        if (
            pin["platform_account_id"] != config.platform_account_id
            or pin["livemode"] != config.livemode
        ):
            return _platform("unverified", "platform_account_mismatch")
        if await c.fetchval(
            """SELECT EXISTS(SELECT 1 FROM scope_commerce_obligations WHERE kind='recovery'
            AND idempotency_key LIKE 'retention:%' AND status<>'succeeded')"""
        ):
            return _platform("unverified", "commerce_retention_resolution_required")
        return _platform("ready", None)
