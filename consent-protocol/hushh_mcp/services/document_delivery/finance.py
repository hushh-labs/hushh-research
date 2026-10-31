"""New-contract payout admission, never a global legacy-finance flag override."""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.stripe_mode import configured_stripe_mode


def payout_admitted(connection, *, request_id, owner_user_id, amount_cents):
    """Verify the exact accepted unpaid contract and original financial binding.

    Called inside the existing payment transaction. Issued paid obligations use
    the existing drain independently of new intake admission.
    """
    if not connector_feature_enabled("protected_document_delivery", owner_user_id):
        return False
    if (
        connection.execute(text("SELECT to_regclass('document_delivery_contracts')")).scalar()
        is None
    ):
        return False
    return (
        connection.execute(
            text("""SELECT EXISTS(
      SELECT 1 FROM document_delivery_contracts c
      JOIN document_delivery_packages p ON p.package_id=c.current_package_id AND p.request_id=c.request_id
      JOIN document_delivery_financial_bindings b ON b.request_id=c.request_id
      JOIN drive_request_payment_orders o ON o.request_id=c.request_id
      WHERE c.request_id=:request AND c.owner_user_id=:owner AND c.amount_cents=:amount
        AND c.receive_through IN ('one','both') AND c.status='approved'
        AND c.approved_at IS NOT NULL AND c.copy_accepted_at IS NOT NULL
        AND c.accepted_at IS NOT NULL AND c.hosted_revoked_at IS NULL
        AND c.access_expires_at>clock_timestamp()
        AND c.accepted_terms_digest=p.terms_digest AND c.accepted_package_digest=p.package_digest
        AND b.original_terms_digest=p.terms_digest AND b.original_package_digest=p.package_digest
        AND b.content_commitment=p.content_commitment AND b.amount_cents=c.amount_cents
        AND b.receive_through=c.receive_through AND b.erased_at IS NULL
        AND o.user_id=c.owner_user_id AND o.requester_user_id=c.recipient_user_id
        AND o.amount_cents=c.amount_cents AND o.stripe_mode=:mode
        AND o.status IN ('awaiting_payment','checkout_open') AND o.paid_at IS NULL
        AND o.settlement_method='stripe_transfer' AND NOT o.reconciliation_required
    )"""),
            {
                "request": request_id,
                "owner": owner_user_id,
                "amount": amount_cents,
                "mode": configured_stripe_mode(),
            },
        ).scalar_one()
        is True
    )


def validate_new_payout(connection, request_id, owner_user_id, amount_cents, settlement_method):
    from hushh_mcp.services.drive_request_owner_payout_service import payout_enabled
    from hushh_mcp.services.hashcoin_wallet_service import hashcoins_enabled

    if settlement_method not in {"stripe_transfer", "hashcoins"}:
        raise ValueError("invalid settlement method")
    if not payout_enabled() and not (settlement_method == "hashcoins" and hashcoins_enabled()):
        if not payout_admitted(
            connection,
            request_id=str(request_id),
            owner_user_id=owner_user_id,
            amount_cents=amount_cents,
        ):
            raise RuntimeError("owner_payouts_disabled")
    request = str(UUID(str(request_id)))
    if not owner_user_id or type(amount_cents) is not int or not 50 <= amount_cents <= 50000:
        raise ValueError("invalid payout order")
    return request


def locked_settlement_request(store, connection, request_id):
    from .store import has_contract

    request = store._row(
        connection,
        "SELECT * FROM drive_share_requests WHERE request_id=:request FOR UPDATE",
        {"request": request_id},
    )
    if request is not None and has_contract(connection, request_id):
        delivery = store._row(
            connection,
            "SELECT * FROM document_delivery_contracts WHERE request_id=:request FOR UPDATE",
            {"request": request_id},
        )
        if delivery["hosted_revoked_at"] is not None or delivery[
            "access_expires_at"
        ] <= datetime.now(UTC):
            return {
                **request,
                "access_stop_requested_at": delivery["hosted_revoked_at"]
                or delivery["access_expires_at"],
            }
    return request
