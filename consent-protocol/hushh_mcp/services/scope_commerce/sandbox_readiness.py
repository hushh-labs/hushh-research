"""Read-only, reviewer-restricted attestation of the isolated sandbox binding."""

import os
from typing import Any

from .domain import CommerceError


class SandboxReadiness:
    async def sandbox_readiness(
        self, *, viewer_user_id: str, app_origin: str, conn: Any = None
    ) -> dict[str, Any]:
        config = self._config()
        policy = config.sandbox_policy
        if policy is None or viewer_user_id not in policy.reviewer_user_ids:
            raise CommerceError("sandbox_readiness_unavailable")
        config.validate(new_activity=False)
        commerce_enabled = (
            self.enabled
            if self.enabled is not None
            else os.getenv("SCOPE_COMMERCE_ENABLED", "").lower() == "true"
        )
        if (
            config.livemode
            or app_origin != config.frontend_origin
            or set(config.countries) != {"US"}
        ):
            raise CommerceError("sandbox_readiness_unbound")

        async def operation(c):
            pin = await c.fetchrow("SELECT * FROM scope_commerce_environment WHERE singleton")
            if (
                pin is None
                or pin["livemode"] is not False
                or pin["platform_account_id"] != policy.platform_account_id
            ):
                raise CommerceError("sandbox_readiness_unbound")
            head = None
            if await c.fetchval("SELECT to_regclass('schema_migrations')"):
                head = await c.fetchval(
                    """SELECT max(head) FROM (
                    SELECT migration_id::integer AS head FROM schema_migrations
                    WHERE status='applied' AND migration_id ~ '^[0-9]+$'
                    UNION ALL SELECT baseline_through FROM schema_migrations
                    WHERE status='baseline') versions"""
                )
            return {
                "app_origin": config.frontend_origin,
                "environment": "sandbox",
                "platform_account_id": policy.platform_account_id,
                "livemode": False,
                "new_activity_enabled": bool(commerce_enabled and config.enabled),
                "reviewer_funding_cap_cents": policy.reviewer_funding_cap_cents,
                "operating_capital_cap_cents": policy.operating_capital_cap_cents,
                "persisted_pin_matches": True,
                "schema_head": head,
            }

        return await self._transaction(operation, conn)
