"""Bind first-party Follow-up booking to the existing one-use Calendar ledger."""

from datetime import UTC, datetime

from hushh_mcp.services.calendar_email_followup_store import FollowupStateError


async def require_booking_request(store, monitor, grant, request_id: str, revision: int):
    await grant.require_current()
    await store.require_monitor_current(monitor)
    target = await store.resolve_request(monitor, request_id)
    detail = await store.detail(monitor, target["conversation_id"], calendar_only=True)
    request = next((item for item in detail["requests"] if item["id"] == request_id), None)
    if not request or request["revision"] != revision:
        raise FollowupStateError("request_changed")
    if (
        request.get("kind") != "meeting"
        or request.get("booking_state") == "booked"
        or request["state"] not in {"pending", "needs_review", "snoozed"}
    ):
        raise FollowupStateError("request_changed")
    await grant.require_current()
    await store.require_monitor_current(monitor)


def seal_booking_review(store, monitor, request_id: str, revision: int, review: dict) -> str:
    return store._seal(
        {
            "proposal_id": review["proposal_id"],
            "revision": revision,
            "generation": monitor.generation,
            "grant": monitor.grant_epoch_digest,
            "expires_at": review["expires_at"],
        },
        monitor,
        request_id,
        "booking-review",
    )


def verify_booking_review(
    store, monitor, request_id: str, revision: int, proposal_id: str, token: str
):
    value = store._open(token, monitor, request_id, "booking-review")
    if (
        not isinstance(value, dict)
        or value.get("proposal_id") != proposal_id
        or value.get("revision") != revision
        or value.get("generation") != monitor.generation
        or value.get("grant") != monitor.grant_epoch_digest
        or datetime.fromisoformat(value["expires_at"]) <= datetime.now(UTC)
    ):
        raise FollowupStateError("request_changed")
