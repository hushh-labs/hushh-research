"""Stable provider identity for retrying one approved advisor meeting."""

import hashlib
import json
import re
from datetime import datetime

from hushh_mcp.services.advisor_review_store import AdvisorReviewError


def event_id(owner, request_id, meeting_id):
    return hashlib.sha256(
        json.dumps(["advisor-introduction-v1", owner, request_id, meeting_id]).encode()
    ).hexdigest()


def binding_hash(binding):
    return hashlib.sha256(
        json.dumps(binding, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def same_instant(left, right):
    try:
        return datetime.fromisoformat(left.replace("Z", "+00:00")) == datetime.fromisoformat(
            right.replace("Z", "+00:00")
        )
    except (ValueError, AttributeError):
        return False


def bind_plan(plan, payload):
    if payload.get("booking_source") == "advisor_review":
        selected = payload.get("advisor_event_id", "")
        if not isinstance(selected, str) or not re.fullmatch(r"[a-f0-9]{64}", selected):
            raise AdvisorReviewError("ADVISOR_MEETING_CHANGED", 422)
        plan.update(booking_source="advisor_review", event_id=selected)


def bind_event(body, plan):
    if plan.get("booking_source") == "advisor_review":
        body["id"] = plan["event_id"]
