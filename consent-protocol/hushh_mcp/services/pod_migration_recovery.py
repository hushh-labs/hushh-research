"""Pre-cutover pod recovery; retain obligations when either recovery step fails."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from hushh_mcp.services.pod_migration_service import MigrationSteps, PodMigrationJobRepo

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MigrationRecovery:
    """Recovery ports bound to the same immutable owner/job attempt as the chain."""

    steps: MigrationSteps
    repo: PodMigrationJobRepo
    user_id: str
    job_id: str

    async def fail(self, code: str, message: str) -> str:
        await self.repo.finish(
            user_id=self.user_id,
            job_id=self.job_id,
            status="failed",
            error_code=code,
            error_message=message,
        )
        return "failed"

    async def recover(self, code: str, message: str) -> str:
        """Preserve source recovery, destination cleanup and superseded-job fences."""
        from hushh_mcp.services.pod_migration_service import MigrationJobSuperseded

        recovery_failed = False
        try:
            await self.steps.unfreeze()
        except MigrationJobSuperseded:
            raise
        except Exception:  # noqa: BLE001
            recovery_failed = True
            logger.warning("pod_migration.unfreeze_failed")
        try:
            await self.steps.rollback_destination()
        except MigrationJobSuperseded:
            raise
        except Exception:  # noqa: BLE001
            recovery_failed = True
            logger.warning("pod_migration.rollback_failed")
        if recovery_failed:
            await self.repo.finish(
                user_id=self.user_id,
                job_id=self.job_id,
                status="recovery_pending",
                error_code="MIGRATION_RECOVERY_PENDING",
                error_message="The move stopped; source admission or destination cleanup still needs verified recovery.",
            )
            return "recovery_pending"
        return await self.fail(code, message)
