"""Per-recipient effects of one reviewed audience, in the owning SQL transaction.

Only keyed commitments and receipt locators remain on the existing directive.
Postgres is the shared authority; a future Redis cache may cache lookups only.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from sqlalchemy import text

from hushh_mcp.services.action_directive_ledger import (
    ActionDirectiveAuthorityError,
    ActionDirectiveStore,
    command_authority_is_current,
)
from hushh_mcp.services.location_command_membership_receipts import MembershipPreparation

ACTIONS = {"location.share_selected", "location.send_request", "location.send_check_in"}
SHARE_ACTIONS = {"share": "location.share_selected", "check_in": "location.send_check_in"}


class _AudiencePerson(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(min_length=1, max_length=160)
    name: str = Field(max_length=400)
    detail: str | None = Field(default=None, max_length=500)
    keyId: str | None = Field(default=None, max_length=160)
    ready: bool


class _Replacement(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: UUID
    recipientUserId: str = Field(min_length=1, max_length=160)
    expiresAt: AwareDatetime | None
    durationMode: str = Field(pattern=r"^(timed|until_stopped)$")


class _AudienceBinding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    owner: str = Field(min_length=1, max_length=160)
    recipientIds: list[str] = Field(min_length=1, max_length=5000)
    people: list[_AudiencePerson] = Field(min_length=1, max_length=5000)
    duration: str = Field(min_length=1, max_length=40)
    message: str | None = Field(default=None, max_length=500)
    sourceCircleByRecipient: dict[str, UUID | None] = Field(default_factory=dict, max_length=5000)
    replacements: list[_Replacement] = Field(default_factory=list, max_length=5000)
    privateDraftDigest: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


def command_operation_for_client(
    connection: Any, *, owner: str, operation: str | None, explicit: str | None
) -> str | None:
    """Known command identities cannot opt out of authority through an omitted flag."""
    if explicit:
        if explicit != operation:
            raise ActionDirectiveAuthorityError(
                "The operation identity changed. Review this command."
            )
        return explicit
    if not operation:
        return None
    row = connection.execute(
        text("""SELECT operation_id FROM one_action_directive_ledger
        WHERE user_id=:owner AND operation_id=:operation AND channel='command'"""),
        {"owner": owner, "operation": operation},
    ).first()
    return operation if row else None


def audience_terms(
    *,
    recipient: str,
    duration: Any,
    mode: str,
    message: str | None,
    key: str | None = None,
    circle: str | None = None,
) -> dict[str, Any]:
    hours = None if mode == "until_stopped" else float(duration)
    if (
        not recipient
        or mode not in {"timed", "until_stopped"}
        or (hours is not None and (not math.isfinite(hours) or not 0 < hours <= 24))
    ):
        raise ActionDirectiveAuthorityError("Review the exact Location duration and audience.")
    return {
        "recipient": recipient,
        "hours": hours,
        "mode": mode,
        "message": (message or "").strip(),
        "key": key or None,
        "circle": circle or None,
    }


def replacement_terms(values: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for value in values:
        expiry = value.get("expiresAt", value.get("expires_at"))
        date = (
            datetime.fromisoformat(expiry.replace("Z", "+00:00"))
            if isinstance(expiry, str)
            else expiry
        )
        result.append(
            {
                "id": str(value["id"]),
                "mode": value.get("durationMode", value.get("duration_mode")) or "timed",
                "expires": int(date.timestamp() * 1000) if date else None,
            }
        )
    return sorted(result, key=lambda item: item["id"])


def prepare_audience_plan(
    preparation: MembershipPreparation, *, action: str, owner: str, binding_digest: str | None
) -> dict[str, Any]:
    digest = hashlib.sha256(f"{preparation.nonce}:{preparation.binding_json}".encode()).hexdigest()
    if (
        action not in ACTIONS
        or not binding_digest
        or not hmac.compare_digest(digest, binding_digest)
    ):
        raise ActionDirectiveAuthorityError("The audience differs from the confirmation card.")
    binding = _AudienceBinding.model_validate_json(preparation.binding_json).model_dump(mode="json")
    people = binding["people"]
    ids = binding["recipientIds"]
    if (
        binding["owner"] != owner
        or owner in ids
        or len(set(ids)) != len(ids)
        or len(people) != len(ids)
        or {item["id"] for item in people} != set(ids)
        or not set(binding["sourceCircleByRecipient"]).issubset(ids)
    ):
        raise ActionDirectiveAuthorityError("Review the complete audience.")
    duration = binding.get("duration")
    mode = "until_stopped" if duration == "until_stopped" else "timed"
    if action == "location.send_request" and mode != "timed":
        raise ActionDirectiveAuthorityError("Choose a timed Location request.")
    store = ActionDirectiveStore()
    plan = {}
    for person in people:
        recipient = person["id"]
        if action in SHARE_ACTIONS.values() and (not person["ready"] or not person["keyId"]):
            raise ActionDirectiveAuthorityError(
                "A recipient has not finished secure Location setup."
            )
        terms = audience_terms(
            recipient=recipient,
            duration=duration,
            mode=mode,
            message=binding.get("message"),
            key=person.get("keyId") if action in SHARE_ACTIONS.values() else None,
            circle=(binding.get("sourceCircleByRecipient") or {}).get(recipient)
            if action in SHARE_ACTIONS.values()
            else None,
        )
        expected = [
            value
            for value in binding.get("replacements", [])
            if value.get("recipientUserId") == recipient
        ]
        plan[store._hmac(recipient)] = {
            "terms": store._hmac([action, terms]),
            "replacements": store._hmac(replacement_terms(expected)),
        }
    return plan


class CommandAudienceReceipt:
    def __init__(
        self,
        connection: Any,
        *,
        owner: str,
        operation: str,
        action: str,
        terms: dict[str, Any],
        directive_id: str | None = None,
    ):
        self.conn, self.owner, self.operation, self.action = connection, owner, operation, action
        self.directive_id = directive_id
        self.store = ActionDirectiveStore()
        self.key = self.store._hmac(terms["recipient"])
        self.digest = self.store._hmac([action, terms])
        self.plan: dict[str, Any] = {}
        self.receipts: dict[str, Any] = {}

    def claim(self) -> dict[str, Any] | None:
        # Same session -> directive ordering as cancellation and the effect receipt port.
        session = (
            self.conn.execute(
                text("""SELECT s.command_status,s.created_at
            FROM one_adk_sessions s JOIN one_action_directive_ledger d ON d.user_id=s.user_id AND d.session_id=s.session_id
            WHERE s.app_name='one.location.commands.v1' AND s.user_id=:owner AND d.operation_id=:operation
              AND d.channel='command' FOR UPDATE OF s"""),
                self.params(),
            )
            .mappings()
            .first()
        )
        row = (
            self.conn.execute(
                text("""SELECT state,command_effect,audience_plan,audience_receipts,expires_at,
                  directive_id,issued_at>consumed_at AS renewed FROM one_action_directive_ledger
            WHERE user_id=:owner AND operation_id=:operation AND action_id=:action AND channel='command' FOR UPDATE"""),
                self.params(),
            )
            .mappings()
            .first()
        )
        if not row or row["command_effect"] != "action" or self.action not in ACTIONS:
            raise ActionDirectiveAuthorityError("This audience operation has no admitted command.")
        self.plan, self.receipts = dict(row["audience_plan"]), dict(row["audience_receipts"])
        if self.plan.get(self.key, {}).get("terms") != self.digest:
            raise ActionDirectiveAuthorityError(
                "This person or duration was not on the confirmation card."
            )
        if self.key in self.receipts:
            return self.receipts[self.key]
        if (
            not session
            or not command_authority_is_current(
                self.conn, created_at=session["created_at"], expires_at=row["expires_at"]
            )
            or session["command_status"] not in {"ready", "admitted"}
            or row["state"] != "consumed"
            or (row.get("renewed") and self.directive_id != row["directive_id"])
        ):
            raise ActionDirectiveAuthorityError("This command is no longer active.")
        return None

    def verify_replacements(self, values: list[dict[str, Any]]) -> None:
        if self.store._hmac(replacement_terms(values)) != self.plan[self.key]["replacements"]:
            raise ActionDirectiveAuthorityError(
                "An existing share changed. Review the replacement before continuing."
            )

    def params(self):
        return {"owner": self.owner, "operation": self.operation, "action": self.action}

    def save(self, resource_id: str) -> None:
        if (
            not isinstance(resource_id, str)
            or not 0 < len(resource_id) <= 300
            or self.key not in self.plan
        ):
            raise ActionDirectiveAuthorityError("The operation has no valid resource receipt.")
        self.receipts[self.key] = {"resource_id": resource_id, "terms": self.digest}
        complete = self.plan.keys() == self.receipts.keys()
        result = self.conn.execute(
            text("""UPDATE one_action_directive_ledger SET audience_receipts=CAST(:receipts AS JSONB),
            state=CASE WHEN :complete THEN 'settled' ELSE state END,
            settlement_status=CASE WHEN :complete THEN 'succeeded' ELSE settlement_status END,
            settlement_reason_code=CASE WHEN :complete THEN 'verified_audience_receipts' ELSE settlement_reason_code END,
            settled_at=CASE WHEN :complete THEN NOW() ELSE settled_at END
            WHERE user_id=:owner AND operation_id=:operation AND action_id=:action AND state='consumed'"""),
            {**self.params(), "receipts": json.dumps(self.receipts), "complete": complete},
        )
        if result.rowcount != 1:
            raise ActionDirectiveAuthorityError("The audience receipt could not be committed.")
