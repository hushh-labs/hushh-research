"""Failure semantics for the existing private-pod provisioning operation."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from logging import Logger


class ProvisionReconciliationRequired(RuntimeError):
    """An uncertain provider/checkpoint result must retain its current attempt."""


async def retain_provision_failure(
    record: Callable[..., Awaitable[None]] | None, error: Exception, logger: Logger
) -> None:
    """Never let a losing checkpoint writer terminate another worker's attempt."""
    if record is None or isinstance(error, ProvisionReconciliationRequired):
        return
    try:
        await record("provisioning_failed")
    except Exception:
        logger.exception("personal_agent.failed_status_write_failed")
