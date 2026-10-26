"""PostgreSQL authority for owner-device prepared ciphertext deliveries.

Lock order: participant graph -> original request -> delivery contract -> order
-> obligation -> refund -> payout. Object/provider I/O never runs in this store.
Only opaque encrypted key envelopes are accepted; this runtime cannot establish
plaintext fidelity, watermarks, malware safety or successful local decryption.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import text

from hushh_mcp.services.document_delivery.contracts import (
    DeliveryError,
)


def iso(value) -> str | None:
    return (
        value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        if value
        else None
    )


def deadline(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None or iso(parsed) != value:
            raise ValueError
        return parsed
    except (ValueError, TypeError):
        raise DeliveryError("invalid_access_deadline", 422) from None


def has_contract(connection, request_id: str) -> bool:
    # Deployment before migration is a readiness failure, not a fallback to an
    # unfenced new flow. Historical callers need compatibility before rollout.
    if (
        connection.execute(text("SELECT to_regclass('document_delivery_contracts')")).scalar()
        is None
    ):
        return False
    return bool(
        connection.execute(
            text(
                "SELECT EXISTS(SELECT 1 FROM document_delivery_contracts WHERE request_id=:request)"
            ),
            {"request": request_id},
        ).scalar()
    )


def delivery_summary(connection, request_id: str) -> dict[str, int] | None:
    """Canonical one-file denominator shared by money, status and erasure."""
    if (
        connection.execute(
            text("SELECT to_regprocedure('document_delivery_summary_for(uuid)')")
        ).scalar()
        is None
    ):
        return None
    row = (
        connection.execute(
            text("SELECT * FROM document_delivery_summary_for(CAST(:request AS uuid))"),
            {"request": request_id},
        )
        .mappings()
        .first()
    )
    return {key: int(row[key]) for key in ("expected", "confirmed", "unsettled")} if row else None
