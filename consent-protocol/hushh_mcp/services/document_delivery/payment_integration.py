"""Compatibility adapters into the existing single payment transaction authority."""

from hushh_mcp.services.drive_sharing_contract import DriveSharingError


async def accept_checkout(service, state, *, requester, request_id, acceptance):
    if state.get("_document_delivery") is not True:
        if acceptance is not None:
            raise DriveSharingError("invalid_argument")
        return state
    from .service import DocumentDeliveryService
    from .store import DocumentDeliveryStore

    if state.get("paymentsReady") is not True:
        raise DriveSharingError("payment_not_ready")
    copies = service.document_delivery or DocumentDeliveryService(
        store=DocumentDeliveryStore(db=service.db)
    )
    await copies.objects.qualify()
    await DocumentDeliveryStore(db=service.db).accept_checkout(
        request_id=request_id, actor=requester, acceptance=acceptance
    )
    return await service.payment_state(requester_user_id=requester, request_id=request_id)


def require_payout(state):
    from hushh_mcp.services.drive_request_checkout_refusals import checkout_refusal
    from hushh_mcp.services.drive_request_owner_payout_service import payout_enabled

    admitted = (
        state.get("_document_delivery_payout_admitted") is True
        if state.get("_document_delivery") is True
        else payout_enabled()
    )
    if not admitted or not state.get("_payout_owner_user_id"):
        raise checkout_refusal("payout_disabled", "payment_unavailable")


def public_payment_state(state):
    from hushh_mcp.services.drive_request_payment_service import _config

    if state.get("_document_delivery") is True:
        try:
            _config()
        except DriveSharingError:
            state["paymentsReady"] = False
    return {key: value for key, value in state.items() if not key.startswith("_")}


def optional_payment_state(store, connection, request, order, requester):
    from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher
    from hushh_mcp.services.drive_sharing_store import DriveSharingStore

    from .store import DocumentDeliveryStore

    private = DriveSharingStore(db=store.db)._open_request(request)
    if private.get("document_delivery_version") == 1:
        return DocumentDeliveryStore(db=store.db).payment_state_locked(
            connection, request=request, order=order, requester=requester
        )
    if not request["payment_required"] and (
        order is None or order["status"] not in {"paid", "refunded"}
    ):
        private = DriveSharingCipher().open(
            request["request_envelope"],
            user_id=request["user_id"],
            resource_id=str(request["request_id"]),
            purpose="request",
        )
        return {
            "status": "not_required",
            "amountCents": 0,
            "currency": "usd",
            **(
                {"existingAccess": True}
                if request["status"] == "completed" and private.get("existing_access_delivery")
                else {}
            ),
        }
    return None


async def verify_payout_account(state):
    from hushh_mcp.services.drive_request_checkout_refusals import checkout_refusal
    from hushh_mcp.services.pkm_payout_service import PkmPayoutService

    try:
        account = await PkmPayoutService().refresh_account(user_id=state["_payout_owner_user_id"])
    except Exception:
        raise checkout_refusal("payout_account_unavailable", "payment_unavailable") from None
    if not account or not account["readiness"]["ready"]:
        raise checkout_refusal("payout_account_not_ready")
    return account["stripe_account_id"]
