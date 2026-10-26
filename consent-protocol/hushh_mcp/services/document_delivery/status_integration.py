"""Legacy status facade joins the dedicated delivery projection without new authority."""

from datetime import UTC, datetime

from hushh_mcp.services.drive_sharing_contract import DriveSharingError


def hosted_status(store, connection, row, user_id, private):
    if private.get("document_delivery_version") == 1:
        from hushh_mcp.services.document_delivery.store import DocumentDeliveryStore

        contract = store._row(
            connection,
            "SELECT * FROM document_delivery_contracts WHERE request_id=:request",
            {"request": row["request_id"]},
        )
        if contract is None:
            raise DriveSharingError("request_unavailable")
        recipient = row["recipient_user_id"] == user_id
        return {
            **store._summary(row, recipient=recipient),
            "direction": "outgoing" if recipient else "incoming",
            "delivery": DocumentDeliveryStore(db=store.db)._projection(
                connection, row, contract, user_id
            ),
        }
    return None


def payout_setup_relevant(row):
    return bool(
        row["payment_required"] is True
        and row.get("settlement_method", "stripe_transfer") != "hashcoins"
        and (
            (
                row["status"] in {"pending", "preparing", "review_ready", "approved", "partial"}
                and row["expires_at"] > datetime.now(UTC)
            )
            or row["owner_payout_status"]
            in {
                "awaiting_account",
                "due",
                "awaiting_delivery",
                "awaiting_fee",
                "awaiting_refund",
            }
        )
    )
