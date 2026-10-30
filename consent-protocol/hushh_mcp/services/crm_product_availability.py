"""Single fail-closed availability authority for the paused CRM product plane."""

from __future__ import annotations

import os

LOCAL_CRM_ENABLE_FLAG = "HUSHH_LOCAL_CRM_ENABLED"
_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})
_UNSET = object()


def _clean(value: str | None) -> str:
    return str(value or "").strip().lower()


def crm_product_available(
    *,
    environment: str | None = None,
    explicit_enabled: str | bool | None | object = _UNSET,
) -> bool:
    """Return true only for an explicitly enabled local development runtime.

    The backend is authoritative. Frontend visibility is only a convenience;
    a forged client flag can never admit the user-facing CRM APIs or specialist.
    """

    resolved_environment = _clean(
        environment
        if environment is not None
        else os.getenv("ENVIRONMENT") or os.getenv("HUSHH_DEPLOY_ENV")
    )
    resolved_enabled = (
        os.getenv(LOCAL_CRM_ENABLE_FLAG) if explicit_enabled is _UNSET else explicit_enabled
    )
    enabled = (
        resolved_enabled
        if isinstance(resolved_enabled, bool)
        else _clean(resolved_enabled) in _TRUE_VALUES
    )
    return resolved_environment == "development" and enabled


__all__ = ["LOCAL_CRM_ENABLE_FLAG", "crm_product_available"]
