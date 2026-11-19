"""A reviewed Location request in the existing Consent Center contract."""

from typing import Any


def request_entry(
    request: dict[str, Any],
    *,
    kind: str,
    section: str,
    counterpart_id: str,
    counterpart_label: str,
    require_complete: bool,
) -> dict[str, Any]:
    from hushh_mcp.services.one_location_center_contributor import (
        LOCATION_VIEW_SCOPE,
        _coerce_metadata,
        _duration_label,
        _safe_str,
    )

    request_id = _safe_str(request.get("id"))
    # The amount asked for travels with the row, so the Consent Manager can
    # say "3 hours more" on the same request the popup and the feed are
    # already naming. An entry that omitted it left the owner approving a
    # duration only one of the three surfaces had ever mentioned.
    is_extension = bool(request.get("isExtension")) or bool(
        _safe_str(request.get("extendsGrantId"))
    )
    duration_label = _duration_label(request.get("requestedDurationHours"))
    until_stopped = _safe_str(request.get("requestedDurationMode")) == "until_stopped"
    amount = "for as long as they need" if until_stopped else duration_label
    metadata = _coerce_metadata(
        {
            "request_source": "one_location_access_request",
            "request_revision": int(request.get("requestRevision") or 1),
            "extends_grant_id": request.get("extendsGrantId"),
            "extends_grant_expires_at": request.get("extendsGrantExpiresAt"),
            "section": section,
            "request_id": request_id,
            "requester_label": counterpart_label,
            "is_extension": is_extension,
            **({"requested_duration_label": amount} if amount else {}),
            **(
                {"requested_duration_hours": request.get("requestedDurationHours")}
                if request.get("requestedDurationHours") is not None
                else {}
            ),
            **(
                {"requested_duration_mode": _safe_str(request.get("requestedDurationMode"))}
                if request.get("requestedDurationMode")
                else {}
            ),
        }
    )
    if is_extension:
        scope_description = (
            f"More live location time requested ({amount})"
            if amount
            else "More live location time requested"
        )
    else:
        scope_description = (
            f"Live location access request ({amount})" if amount else "Live location access request"
        )
    return {
        "id": f"one_location_request:{request_id}",
        "kind": kind,
        "status": _safe_str(request.get("status")) or "pending",
        "action": "REQUESTED",
        "scope": LOCATION_VIEW_SCOPE,
        "scope_description": scope_description,
        "counterpart_type": "investor",
        "counterpart_id": counterpart_id or None,
        "counterpart_label": counterpart_label,
        "request_id": request_id,
        "issued_at": request.get("requestedAt"),
        **({"expires_at": request.get("expiresAt")} if require_complete else {}),
        "reason": _safe_str(request.get("message")) or None,
        "metadata": metadata,
    }
