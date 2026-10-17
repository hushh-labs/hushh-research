"""Bounded connector-status projection; private labels require explicit admission."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from hushh_mcp.services.external_connector_credentials_service import (
    ExternalConnectorCredentialError,
)


def public_status(
    *, open_credential, user_id: str, connector_id: str, row: dict[str, Any], include_private: bool
) -> dict[str, Any]:
    status = row["status"]
    label = row.get("connected_account_label") if include_private else None
    profile = None
    if (
        include_private
        and row.get("envelope_version") == 2
        and status
        in {
            "connected",
            "verifying",
            "needs_reauth",
        }
    ):
        try:
            credential = open_credential(user_id=user_id, connector_id=connector_id, row=row)
            label = credential.get("accountLabel")
            if connector_id == "google_drive":
                profile = credential.get("profile", "selected")
                if profile not in {"selected", "live"}:
                    profile = None
        except ExternalConnectorCredentialError:
            status, label = "needs_reauth", None
    connected_at = row.get("connected_at")
    if isinstance(connected_at, datetime):
        connected_at = connected_at.isoformat()
    return {
        "connectorId": connector_id,
        "status": status,
        "accountLabel": str(label)[:254] if label else None,
        "connectedAt": connected_at,
        "validationState": row.get("validation_state", "unverified"),
        "profile": profile,
        "revocationOutcome": row.get("revocation_outcome", "not_attempted"),
        "lastErrorCode": row.get("last_error_code")
        if row.get("last_error_code")
        in {"grant_rejected", "policy_drift", "provider_unavailable", "insufficient_scope"}
        else None,
    }
