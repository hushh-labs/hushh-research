"""Owner decision on one grant's model use; never inferred from price or sensitivity."""

from collections.abc import Mapping
from typing import Any


def owner_model_processing(allowed: bool) -> dict[str, Any]:
    """Called only with the authenticated owner's strict approval body."""
    if type(allowed) is not bool:
        raise ValueError("invalid_model_processing_permission")
    return {"version": 1, "allowed": allowed}


def model_processing_allowed(metadata: Any) -> bool:
    """Only the current canonical grant event may supply this metadata."""
    if not isinstance(metadata, Mapping):
        return False
    permission = metadata.get("model_processing")
    return (
        isinstance(permission, Mapping)
        and set(permission) == {"version", "allowed"}
        and type(permission.get("version")) is int
        and permission.get("version") == 1
        and permission.get("allowed") is True
    )


async def grant_processing_projection(
    *, granted: bool, token_id: str, metadata: Any
) -> dict[str, bool]:
    """Compose current paid admission and the owner's independent model decision."""
    from hushh_mcp.consent.paid_admission import paid_grant_is_admitted

    ready = granted and await paid_grant_is_admitted(token_id, metadata or {})
    return {
        "accessReady": ready,
        "modelProcessingAllowed": ready and model_processing_allowed(metadata),
    }
