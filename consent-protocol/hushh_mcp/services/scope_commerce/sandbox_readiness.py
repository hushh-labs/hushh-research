"""Read-only, reviewer-restricted attestation of the isolated sandbox binding."""

import json
import os
from pathlib import Path
from typing import Any

from db.migration_authority import (
    MigrationAuthorityError,
    build_manifest_entries,
)
from db.migration_readiness import verified_manifest_head

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
            or (
                set(config.countries) != {"US"}
                and not (
                    not config.countries and commerce_enabled is False and config.enabled is False
                )
            )
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
                # Shared Dev also has parked migrations. Only exact release
                # receipts or a verified release baseline prove this source.
                database = Path(__file__).resolve().parents[3] / "db"
                try:
                    manifest = json.loads(
                        (database / "release_migration_manifest.json").read_text()
                    )
                    entries = build_manifest_entries(
                        database / "migrations", manifest["ordered_migrations"]
                    )
                    head = await verified_manifest_head(c, entries)
                except (MigrationAuthorityError, OSError, ValueError, KeyError):
                    head = None
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
