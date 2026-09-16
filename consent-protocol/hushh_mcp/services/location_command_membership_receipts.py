"""A transaction-bound receipt seam inside the existing directive ledger.

Postgres serializes command cancellation and domain effects today. A future
cache/notification adapter may use Redis; the durable receipt remains atomic
with the membership rows and is never replaced by cache state.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text

from hushh_mcp.services.action_directive_ledger import (
    ActionDirectiveAuthorityError,
    ActionDirectiveStore,
    command_authority_is_current,
)


class MembershipPreparation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    nonce: str = Field(pattern=r"^[a-f0-9]{64}$")
    binding_json: str = Field(min_length=2, max_length=500000)


class _Person(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    userId: str = Field(min_length=1, max_length=128)
    displayName: str = Field(max_length=400)
    member: bool


class _Binding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    owner: str = Field(min_length=1, max_length=128)
    circleId: UUID
    circleName: str = Field(max_length=400)
    people: list[_Person] = Field(min_length=1, max_length=5000)
    sourceReceipt: list[dict[str, Any]] | None = Field(default=None, max_length=1)


def prepare_membership_plan(
    preparation: MembershipPreparation | None,
    *,
    owner: str,
    binding_digest: str | None,
    store: ActionDirectiveStore,
    expected_circle_id: str | None = None,
) -> dict[str, Any]:
    """Verify the exact confirmation binding transiently; persist only HMACs.

    The model never sees this prepared binding and cannot author it. Labels and
    personal selections remain in the encrypted client capsule after this call.
    """
    if preparation is None or not binding_digest:
        raise ActionDirectiveAuthorityError("Review the complete circle audience first.")
    actual = hashlib.sha256(f"{preparation.nonce}:{preparation.binding_json}".encode()).hexdigest()
    if not hmac.compare_digest(actual, binding_digest):
        raise ActionDirectiveAuthorityError(
            "The membership audience differs from the confirmed card."
        )
    binding = _Binding.model_validate_json(preparation.binding_json)
    if binding.owner != owner or (
        expected_circle_id and str(binding.circleId) != expected_circle_id
    ):
        raise ActionDirectiveAuthorityError("The membership resource differs from this command.")
    if len({person.userId for person in binding.people}) != len(binding.people):
        raise ActionDirectiveAuthorityError("The membership audience contains duplicate people.")
    people = [person.userId for person in binding.people if not person.member]
    count = (len(people) + 19) // 20
    return {
        str(index): {
            "request_hmac": store._hmac(
                [str(binding.circleId), sorted(people[offset : offset + 20]), count]
            ),
            "circle_hmac": store._hmac(str(binding.circleId)),
            "batch_count": count,
        }
        for index, offset in enumerate(range(0, len(people), 20))
    }


class MembershipBatchReceipt:
    def __init__(
        self,
        connection: Any,
        *,
        owner: str,
        operation_id: str,
        batch: int,
        circle_id: str,
        people: list[str],
        batch_count: int = 1,
        directive_id: str | None = None,
    ):
        if not 0 <= batch < batch_count <= 250:
            raise ActionDirectiveAuthorityError("The membership batch is outside its bound.")
        self.connection, self.owner, self.operation, self.batch = (
            connection,
            owner,
            operation_id,
            str(batch),
        )
        self.count = batch_count
        self.directive_id = directive_id
        self.circle_hmac = ActionDirectiveStore()._hmac(circle_id)
        self.request_hmac = ActionDirectiveStore()._hmac([circle_id, sorted(people), batch_count])

    def claim(self) -> dict[str, Any] | None:
        # Match the command owner's session → directive lock order. Cancellation
        # cannot pass this fence then allow a later batch to dispatch.
        session = (
            self.connection.execute(
                text("""SELECT s.command_status,s.created_at FROM one_adk_sessions s
            JOIN one_action_directive_ledger d ON d.user_id=s.user_id AND d.session_id=s.session_id
            WHERE s.app_name='one.location.commands.v1' AND s.user_id=:owner
              AND d.operation_id=:operation AND d.channel='command'
            FOR UPDATE OF s"""),
                {"owner": self.owner, "operation": self.operation},
            )
            .mappings()
            .first()
        )
        row = (
            self.connection.execute(
                text("""SELECT state,membership_plan,membership_receipts,expires_at,
                  directive_id,issued_at>consumed_at AS renewed FROM one_action_directive_ledger
            WHERE user_id=:owner AND operation_id=:operation AND channel='command'
              AND action_id='location.add_to_circle' AND command_effect='action'
            FOR UPDATE"""),
                {"owner": self.owner, "operation": self.operation},
            )
            .mappings()
            .first()
        )
        if row is None:
            raise ActionDirectiveAuthorityError("The membership command was not admitted.")
        expected = (row["membership_plan"] or {}).get(self.batch)
        if not expected or expected != {
            "request_hmac": self.request_hmac,
            "circle_hmac": self.circle_hmac,
            "batch_count": self.count,
        }:
            raise ActionDirectiveAuthorityError(
                "This batch was not included in the confirmed membership audience."
            )
        receipts = row["membership_receipts"] or {}
        if any(
            item.get("batch_count") != self.count or item.get("circle_hmac") != self.circle_hmac
            for item in receipts.values()
        ):
            raise ActionDirectiveAuthorityError(
                "The membership selection changed. Review the circle."
            )
        if any(str(index) not in receipts for index in range(int(self.batch))):
            raise ActionDirectiveAuthorityError(
                "An earlier membership batch is unfinished. Review the circle."
            )
        prior = receipts.get(self.batch)
        if prior:
            if prior.get("request_hmac") != self.request_hmac:
                raise ActionDirectiveAuthorityError(
                    "The membership audience changed. Review the circle."
                )
            return dict(prior["result"])
        if (
            not session
            or not command_authority_is_current(
                self.connection, created_at=session["created_at"], expires_at=row["expires_at"]
            )
            or session["command_status"] not in {"ready", "admitted"}
            or row["state"] != "consumed"
            or (row.get("renewed") and self.directive_id != row["directive_id"])
        ):
            raise ActionDirectiveAuthorityError(
                "The command is no longer active. Review the circle."
            )
        return None

    def save(self, result: dict[str, Any]) -> None:
        value = json.dumps(
            {
                "request_hmac": self.request_hmac,
                "circle_hmac": self.circle_hmac,
                "batch_count": self.count,
                "result": result,
            }
        )
        recorded = self.connection.execute(
            text("""UPDATE one_action_directive_ledger
            SET membership_receipts=jsonb_set(membership_receipts,ARRAY[:batch],CAST(:receipt AS JSONB))
            WHERE user_id=:owner AND operation_id=:operation AND channel='command' AND state='consumed'
              AND NOT membership_receipts ? :batch"""),
            {
                "owner": self.owner,
                "operation": self.operation,
                "batch": self.batch,
                "receipt": value,
            },
        )
        if recorded.rowcount != 1:
            raise ActionDirectiveAuthorityError("The membership receipt could not be saved.")
