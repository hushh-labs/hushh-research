"""One submission receipt, composed with the owning encrypted conversation store."""

from __future__ import annotations

import hashlib
import uuid
from typing import Any

from fastapi import HTTPException
from google.adk.events import Event
from pydantic import BaseModel, Field

from hushh_mcp.one_adk.history_descriptors import (
    _record,
    _request_source,
    _safe_submitted_information_request_card,
    _submitted_source_id,
)


class RecordInformationRequestSubmission(BaseModel):
    source_activity_id: str = Field(min_length=1, max_length=256)
    bundle_id: uuid.UUID
    idempotency_key: str = Field(min_length=16, max_length=256)


def _submission_card(bundle: dict[str, Any], person: dict[str, Any]) -> dict[str, Any]:
    """Display-safe projection of the already verified authoritative receipt."""
    statuses = [item["status"] for item in bundle["items"]]
    status = statuses[0] if all(value == statuses[0] for value in statuses) else "mixed"
    hours = bundle["durationSeconds"] // 3600
    duration_label = (
        f"{hours // 24} {'day' if hours // 24 == 1 else 'days'}"
        if hours % 24 == 0
        else f"{hours} {'hour' if hours == 1 else 'hours'}"
    )
    return {
        "activityType": "one.information_request_review.v1",
        "direction": "outgoing",
        "phase": "submitted",
        "status": status,
        "personName": person["displayName"],
        "subjectRef": bundle["personRef"],
        "bundleId": bundle["bundleId"],
        "purpose": bundle["purpose"],
        "durationLabel": duration_label,
        "fields": [
            {
                "requestId": item["requestId"],
                "label": item["label"],
                "domain": "Information",
                "sensitivity": item.get("sensitivity") or "standard",
                "status": item["status"],
            }
            for item in bundle["items"]
        ],
    }


async def record_submission(
    *,
    owner_id: str,
    conversation_id: str,
    payload: RecordInformationRequestSubmission,
    sessions: Any,
    verify_submission: Any,
    app_name: str,
    require_access: Any = None,
) -> dict:
    owner = owner_id
    if require_access is not None:
        await require_access()
    session = await sessions.get_session(
        app_name=app_name, user_id=owner, session_id=conversation_id
    )
    if session is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    source = _request_source(session, payload.source_activity_id)
    if source is None:
        raise HTTPException(status_code=404, detail="Request card not found.")
    source_card_id, source_card = source
    bundle = await verify_submission(
        requester_user_id=owner,
        bundle_id=str(payload.bundle_id),
        idempotency_key=payload.idempotency_key,
    )
    if require_access is not None:
        await require_access()
    person = source_card["person"]
    if bundle["personRef"] != person.get("personRef") or not bundle.get("items"):
        raise HTTPException(status_code=409, detail="Request recipient did not match the card.")
    card = _submission_card(bundle, person)
    descriptor = _safe_submitted_information_request_card(card)
    if descriptor is None:
        raise HTTPException(status_code=409, detail="Request receipt could not be projected.")
    event = Event(
        id=f"request_submission_{hashlib.sha256(source_card_id.encode()).hexdigest()[:32]}",
        author="one",
        invocation_id=f"information_request_{payload.bundle_id}",
        custom_metadata={
            "kind": "information_request_submission_v1",
            "sourceCardId": source_card_id,
            "card": card,
        },
    )
    persisted = await sessions.append_event_once(
        app_name=app_name, user_id=owner, session_id=conversation_id, event=event
    )
    persisted_metadata = _record(persisted.custom_metadata) or {}
    persisted_descriptor = _safe_submitted_information_request_card(persisted_metadata.get("card"))
    if _submitted_source_id(persisted) != source_card_id or not persisted_descriptor:
        raise HTTPException(status_code=409, detail="Discovery was already submitted.")
    if persisted_descriptor["content"].get("bundleId") != str(payload.bundle_id):
        raise HTTPException(status_code=409, detail="Discovery was already submitted.")
    if require_access is not None:
        await require_access()
    return {"descriptor": persisted_descriptor, "sourceActivityId": source_card_id}
