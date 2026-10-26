"""Document delivery checkout: operations over the owning store transaction port."""

from __future__ import annotations

from sqlalchemy import text

from hushh_mcp.services.document_delivery.contracts import (
    DeliveryError,
)
from hushh_mcp.services.stripe_mode import configured_stripe_mode

from .state import has_contract


def _ensure_payment_order(self, connection, *, request_id, request, contract, package):
    actor = contract["owner_user_id"]
    existing = self._row(
        connection,
        "SELECT * FROM drive_request_payment_orders WHERE request_id=:request FOR UPDATE",
        {"request": request_id},
    )
    if existing is not None:
        if (
            existing["amount_cents"] != contract["amount_cents"]
            or existing["requester_user_id"] != contract["recipient_user_id"]
        ):
            raise DeliveryError("payment_binding_changed")
        return
    from hushh_mcp.services.drive_request_payment_store import _record_new_owner_payout

    connection.execute(
        text("""INSERT INTO drive_request_payment_orders
      (request_id,user_id,requester_user_id,amount_cents,stripe_mode,settlement_method)
      VALUES(:request,:owner,:recipient,:amount,:mode,:settlement)"""),
        {
            "request": request_id,
            "owner": actor,
            "recipient": contract["recipient_user_id"],
            "amount": contract["amount_cents"],
            "mode": configured_stripe_mode(),
            "settlement": request.get("settlement_method", "stripe_transfer"),
        },
    )
    connection.execute(
        text("""INSERT INTO document_delivery_financial_bindings
      (request_id,receive_through,original_terms_digest,original_package_digest,content_commitment,
       amount_cents,expected_count,unsettled_count)
      VALUES(:request,:mode,:terms,:package,:content,:amount,:count,:count)"""),
        {
            "request": request_id,
            "mode": contract["receive_through"],
            "terms": package["terms_digest"],
            "package": package["package_digest"],
            "content": package["content_commitment"],
            "amount": contract["amount_cents"],
            "count": len(self._selection(contract)),
        },
    )
    _record_new_owner_payout(
        connection,
        request_id=request_id,
        owner_user_id=actor,
        amount_cents=contract["amount_cents"],
        quoted_request=True,
        settlement_method=request.get("settlement_method", "stripe_transfer"),
    )


def checkout_authority(self, connection, *, request_id, requester, acceptance=None):
    request, contract = self._locked(connection, request_id=request_id, actor=requester)
    try:
        self._current(request, contract)
        if requester != contract["recipient_user_id"] or contract["status"] not in {
            "approved",
            "released",
        }:
            raise DeliveryError("payment_not_ready")
        if (
            contract["receive_through"] == "both"
            and contract["drive_revoke_status"] != "not_requested"
        ):
            raise DeliveryError("drive_delivery_authority_ended")
        self._relationship(connection, contract["owner_user_id"], requester)
        package = self._row(
            connection,
            "SELECT * FROM document_delivery_packages WHERE package_id=:id",
            {"id": contract["current_package_id"]},
        )
        if package is None:
            raise DeliveryError("package_not_ready")
        if acceptance is not None:
            expected = {
                "acceptedTermsRevision": contract["revision"],
                "acceptedTermsDigest": package["terms_digest"],
                "acceptedPackageDigest": package["package_digest"],
            }
            if acceptance != expected:
                raise DeliveryError("checkout_terms_changed")
            self._public_key(connection, contract, require_active=True)
            proof = connection.execute(
                text("""SELECT EXISTS(SELECT 1 FROM document_delivery_key_challenges
              WHERE request_id=:request AND user_id=:user AND key_id=:key AND fingerprint=:fp
                AND verified_at IS NOT NULL)"""),
                {
                    "request": request_id,
                    "user": requester,
                    "key": contract["recipient_key_id"],
                    "fp": contract["recipient_key_fingerprint"],
                },
            ).scalar()
            if not proof:
                raise DeliveryError("recipient_key_proof_required")
            connection.execute(
                text("""UPDATE document_delivery_contracts SET accepted_at=clock_timestamp(),
              accepted_terms_digest=:terms,accepted_package_digest=:package WHERE request_id=:request"""),
                {
                    "request": request_id,
                    "terms": package["terms_digest"],
                    "package": package["package_digest"],
                },
            )
            self._ensure_payment_order(
                connection,
                request_id=request_id,
                request=request,
                contract=contract,
                package=package,
            )
        elif (
            contract["accepted_at"] is None
            or contract["accepted_terms_digest"] != package["terms_digest"]
            or contract["accepted_package_digest"] != package["package_digest"]
        ):
            raise DeliveryError("checkout_terms_acceptance_required")
        return request
    except DeliveryError:
        from hushh_mcp.services.drive_sharing_contract import DriveSharingError

        raise DriveSharingError("payment_not_ready") from None


async def accept_checkout(self, *, request_id, actor, acceptance):
    def operation(connection):
        if not has_contract(connection, request_id):
            if acceptance is not None:
                raise DeliveryError("legacy_checkout_body_forbidden", 422)
            return False
        if acceptance is None:
            raise DeliveryError("checkout_terms_acceptance_required")
        self.checkout_authority(
            connection, request_id=request_id, requester=actor, acceptance=acceptance
        )
        return True

    return await self._transaction(operation)


def _paid(self, connection, request, contract):
    self._current(request, contract)
    if contract["approved_at"] is None or contract["accepted_at"] is None:
        raise DeliveryError("payment_required", 402)
    order = self._row(
        connection,
        "SELECT * FROM drive_request_payment_orders WHERE request_id=:request FOR UPDATE",
        {"request": request["request_id"]},
    )
    obligation = self._row(
        connection,
        "SELECT * FROM drive_request_payment_obligations WHERE request_id=:request FOR UPDATE",
        {"request": request["request_id"]},
    )
    refund = self._row(
        connection,
        "SELECT * FROM drive_request_payment_refunds WHERE request_id=:request FOR UPDATE",
        {"request": request["request_id"]},
    )
    partial_refund = False
    if refund and refund["status"] == "succeeded" and order:
        payout = self._row(
            connection,
            "SELECT * FROM drive_request_owner_payouts WHERE request_id=:request FOR UPDATE",
            {"request": request["request_id"]},
        )
        partial_refund = bool(
            payout
            and payout["finalized_at"] is not None
            and payout["retained_amount_cents"] > 0
            and 0 < refund["amount_cents"] < order["amount_cents"]
            and payout["refund_amount_cents"] == refund["amount_cents"]
            and payout["retained_amount_cents"] + refund["amount_cents"] == order["amount_cents"]
        )
    if (
        not order
        or not obligation
        or order["status"] != "paid"
        or obligation["status"] != "paid"
        or order["reconciliation_required"]
        or obligation["reconciliation_required"]
        or order["stripe_mode"] != configured_stripe_mode()
        or order["amount_cents"] != contract["amount_cents"]
        or refund
        and refund["status"] not in {"failed", "cancelled"}
        and not partial_refund
    ):
        raise DeliveryError("payment_required", 402)
    package = self._row(
        connection,
        "SELECT * FROM document_delivery_packages WHERE package_id=:id",
        {"id": contract["current_package_id"]},
    )
    if (
        package is None
        or contract["accepted_terms_digest"] != package["terms_digest"]
        or contract["accepted_package_digest"] != package["package_digest"]
    ):
        raise DeliveryError("paid_package_binding_changed")
    package["_partial_refund"] = partial_refund
    return package
