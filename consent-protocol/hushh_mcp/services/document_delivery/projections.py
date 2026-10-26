"""Document delivery projections: operations over the owning store transaction port."""

from __future__ import annotations

from datetime import UTC, datetime

from hushh_mcp.services.document_delivery.contracts import (
    DeliveryError,
)
from hushh_mcp.services.stripe_mode import configured_stripe_mode

from .state import delivery_summary, iso


def _delivery_status(contract, order, summary):
    status = {
        "preparing": "preparing_on_owner_device",
        "approved": "ready_for_buyer",
        "released": "delivered",
    }.get(contract["status"], contract["status"])
    if contract["status"] not in {"revoked", "expired", "erasing"}:
        if contract["access_expires_at"] <= datetime.now(UTC):
            status = "expired"
        elif order and order["status"] == "refunded":
            status = "refunded"
        elif order and order["status"] == "paid":
            status = (
                "delivered"
                if summary["expected"] and summary["confirmed"] == summary["expected"]
                else "partial"
                if summary["confirmed"]
                else "delivering"
            )
        elif order and order["status"] == "checkout_open":
            status = "checkout_open"
    return status


def _projection(self, connection, request, contract, actor, *, include_owner_source=False) -> dict:
    package = None
    if contract["current_package_id"]:
        package = self._row(
            connection,
            "SELECT * FROM document_delivery_packages WHERE package_id=:id",
            {"id": contract["current_package_id"]},
        )
    owner = actor == contract["owner_user_id"]
    # General network/control reads expose only A-approved delivery metadata.
    # Source catalogues and provider locators belong to ContentOwner reads.
    files = (
        self._selection(contract)
        if contract["approved_at"] or (owner and include_owner_source)
        else []
    )
    if not (owner and include_owner_source):
        files = [
            {key: item[key] for key in ("fileRef", "name", "mimeType", "size")} for item in files
        ]
    key = self._public_key(connection, contract, require_active=False)
    summary = delivery_summary(connection, str(request["request_id"]))
    order = self._row(
        connection,
        "SELECT status FROM drive_request_payment_orders WHERE request_id=:request",
        {"request": request["request_id"]},
    )
    status = _delivery_status(contract, order, summary)
    result = {
        "requestId": str(request["request_id"]),
        "revision": contract["revision"],
        "receiveThrough": contract["receive_through"],
        "status": status,
        "ownerUserId": contract["owner_user_id"],
        "recipientUserId": contract["recipient_user_id"],
        "accessExpiresAt": iso(contract["access_expires_at"]),
        "amountCents": contract["amount_cents"],
        "currency": "usd",
        "recipientKey": key,
        "generationId": str(contract["generation_id"]) if contract["generation_id"] else None,
        "sourceSelectionDigest": contract["source_selection_digest"],
        "preparationDigest": contract["preparation_digest"],
        "contentCommitment": package["content_commitment"] if package else None,
        "terms": package["terms"] if package else None,
        "termsDigest": package["terms_digest"] if package else None,
        "packageDigest": package["package_digest"] if package else None,
        "files": files,
        "hostedUrl": f"/one/documents/open?ref={request['request_id']}"
        if contract["approved_at"]
        else None,
        "driveRevokeStatus": contract["drive_revoke_status"],
        "deliverySummary": summary,
    }
    from hushh_mcp.services.document_delivery.recovery import proven_recovery_key

    replacement = proven_recovery_key(self, connection, contract)
    result["recoveryRequested"] = bool(
        replacement and replacement["connectorKeyId"] != contract["recipient_key_id"]
    )
    if owner:
        result["ownerSetup"] = self._document_owner_setup(
            connection,
            owner_user_id=contract["owner_user_id"],
            amount_cents=contract["amount_cents"],
            settlement_method=request.get("settlement_method", "stripe_transfer"),
        )
    return result


async def projection(self, *, request_id, actor):
    def operation(connection):
        request, contract = self._locked(connection, request_id=request_id, actor=actor)
        return self._projection(connection, request, contract, actor)

    return await self._transaction(operation)


def payment_state_locked(self, connection, *, request, order, requester):
    contract = self._row(
        connection,
        "SELECT * FROM document_delivery_contracts WHERE request_id=:request",
        {"request": request["request_id"]},
    )
    if contract is None:
        raise DeliveryError("delivery_contract_unavailable", 503)
    ended = contract["status"] in {"revoked", "expired", "erasing"} or contract[
        "access_expires_at"
    ] <= datetime.now(UTC)
    setup = self._document_owner_setup(
        connection,
        owner_user_id=contract["owner_user_id"],
        amount_cents=contract["amount_cents"],
        settlement_method=request.get("settlement_method", "stripe_transfer"),
    )
    payments_ready = bool(
        setup["paymentsReady"]
        and setup["ownerPayoutAccountReady"]
        and not setup["ownerPriceRequired"]
    )
    from hushh_mcp.services.document_delivery.finance import payout_admitted

    hosted_payout_ready = bool(order) and payout_admitted(
        connection,
        request_id=str(request["request_id"]),
        owner_user_id=contract["owner_user_id"],
        amount_cents=contract["amount_cents"],
    )
    status = (
        order["status"]
        if order and order["status"] in {"paid", "refunded"}
        else "expired"
        if ended
        else order["status"]
        if order
        else "awaiting_payment"
        if contract["approved_at"] is not None
        and contract["current_package_id"] is not None
        and payments_ready
        else "preparing"
    )
    from hushh_mcp.services.drive_request_payment_view import (
        order_view_input,
        requester_payment_view,
    )

    view = requester_payment_view(
        payment_required=True,
        package_disclosure_required=False,
        package_disclosure=None,
        request_status=request["status"],
        request_expires_at=request["expires_at"],
        now=datetime.now(UTC),
        access_stopped=ended,
        preparation_error_code=None,
        quoted_amount_cents=contract["amount_cents"],
        order=order_view_input(order),
        refund=None,
        owner_payout_ready=order.get("owner_account_ready")
        if order and order.get("payout_enrolled")
        else None,
        configured_mode=configured_stripe_mode(),
    )
    return _payment_fields(
        self,
        connection,
        request=request,
        contract=contract,
        order=order,
        requester=requester,
        status=status,
        payments_ready=payments_ready,
        view=view,
        hosted_payout_ready=hosted_payout_ready,
    )


def _payment_fields(
    self,
    connection,
    *,
    request,
    contract,
    order,
    requester,
    status,
    payments_ready,
    view,
    hosted_payout_ready,
):
    return {
        "status": status,
        "amountCents": contract["amount_cents"],
        "currency": "usd",
        "paymentsReady": payments_ready,
        "paymentView": view,
        "stripeMode": order["stripe_mode"] if order else configured_stripe_mode(),
        "paymentLinkExpired": bool(
            order
            and order.get("stripe_checkout_expires_at")
            and order["stripe_checkout_expires_at"] <= datetime.now(UTC)
        ),
        "checkoutExpiresAt": iso(order.get("stripe_checkout_expires_at")) if order else None,
        "reconciliationRequired": bool(order and order["reconciliation_required"]),
        "delivery": self._projection(connection, request, contract, requester),
        "_document_delivery": True,
        "_document_delivery_payout_admitted": hosted_payout_ready,
        "_order_present": order is not None,
        "_payout_enrolled": bool(order and order.get("payout_enrolled")),
        "_payout_settlement_method": order.get("settlement_method", "stripe_transfer")
        if order
        else "stripe_transfer",
        "_payout_owner_user_id": contract["owner_user_id"]
        if order and order.get("payout_enrolled")
        else None,
    }
