"""Transaction-scoped receipts beneath the existing command directive owner.

Postgres serializes command/session and domain effects today. A future shared
cache may accelerate receipt lookup; it cannot replace the atomic DB fence.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any

from sqlalchemy import text

from hushh_mcp.services.action_directive_ledger import (
    ActionDirectiveAuthorityError,
    ActionDirectiveStore,
    command_authority_is_current,
)
from hushh_mcp.services.location_command_membership_receipts import MembershipPreparation


def effect_terms(action: str, binding: dict[str, Any], owner: str) -> dict[str, Any]:
    if binding.get("owner") != owner:
        raise ActionDirectiveAuthorityError(
            "The selected information belongs to a different owner."
        )
    from hushh_mcp.services.location_circle_command import (
        CIRCLE_EFFECT_ACTIONS,
        circle_effect_terms,
    )

    if action in CIRCLE_EFFECT_ACTIONS:
        return circle_effect_terms(action, binding)
    if action in {"location.create_public_link", "location.revoke_public_link"}:
        from hushh_mcp.services.location_public_link_writer import public_link_terms

        return public_link_terms(action, binding)
    if action == "location.checkout_nearby":
        from uuid import UUID

        presence_id, version = binding.get("presenceId"), binding.get("presenceVersion")
        if presence_id is None and type(version) is int and version == 0:
            return {"presenceId": None, "presenceVersion": 0}
        try:
            valid_id = isinstance(presence_id, str) and str(UUID(presence_id)) == presence_id
        except ValueError:
            valid_id = False
        if not valid_id or type(version) is not int or version < 1:
            raise ActionDirectiveAuthorityError("Refresh the Nearby check-in before ending it.")
        return {"presenceId": presence_id, "presenceVersion": version}
    if action == "location.confirm_nearby_check_in":
        place = binding.get("placeId")
        duration = binding.get("durationMinutes")
        consent = binding.get("consentVersion")
        allow = binding.get("allowConnectionRequests")
        if (
            not isinstance(place, str)
            or not 0 < len(place) <= 300
            or type(duration) is not int
            or duration not in {30, 60, 120}
            or not isinstance(consent, str)
            or not 0 < len(consent) <= 80
            or type(allow) is not bool
        ):
            raise ActionDirectiveAuthorityError("Review the place and Nearby visibility terms.")
        return {
            "placeId": place,
            "durationMinutes": duration,
            "consentVersion": consent,
            "allowConnectionRequests": allow,
        }
    if action in {"location.add_emergency_contact", "location.remove_emergency_contact"}:
        people = binding.get("recipientIds")
        if (
            not isinstance(people, list)
            or len(people) != 1
            or not isinstance(people[0], str)
            or not 0 < len(people[0]) <= 160
        ):
            raise ActionDirectiveAuthorityError("Review the exact emergency contact.")
        return {"recipientId": people[0]}
    raise ActionDirectiveAuthorityError("This action has no domain receipt binding.")


def prepare_effect_hmac(
    preparation: MembershipPreparation, *, action: str, owner: str, binding_digest: str | None
) -> str:
    digest = hashlib.sha256(f"{preparation.nonce}:{preparation.binding_json}".encode()).hexdigest()
    if not binding_digest or not hmac.compare_digest(digest, binding_digest):
        raise ActionDirectiveAuthorityError("The effect differs from the confirmed selection.")
    binding = json.loads(preparation.binding_json)
    return ActionDirectiveStore()._hmac([action, effect_terms(action, binding, owner)])


class CommandEffectReceipt:
    def __init__(
        self, connection: Any, *, owner: str, operation: str, action: str, terms: dict[str, Any]
    ):
        self.connection, self.owner, self.operation, self.action = (
            connection,
            owner,
            operation,
            action,
        )
        self.digest = ActionDirectiveStore()._hmac([action, terms])

    def claim(self) -> dict[str, Any] | None:
        # Same session → directive lock order as cancellation and admission.
        session = (
            self.connection.execute(
                text("""SELECT s.command_status,
            s.created_at FROM one_adk_sessions s
            JOIN one_action_directive_ledger d ON d.user_id=s.user_id AND d.session_id=s.session_id
            WHERE s.app_name='one.location.commands.v1' AND s.user_id=:owner
              AND d.operation_id=:operation AND d.channel='command' FOR UPDATE OF s"""),
                {"owner": self.owner, "operation": self.operation},
            )
            .mappings()
            .first()
        )
        row = (
            self.connection.execute(
                text("""SELECT state,effect_request_hmac,effect_receipt,command_effect,expires_at
            FROM one_action_directive_ledger WHERE user_id=:owner AND operation_id=:operation
            AND action_id=:action AND channel='command' FOR UPDATE"""),
                {"owner": self.owner, "operation": self.operation, "action": self.action},
            )
            .mappings()
            .first()
        )
        if (
            not row
            or row["effect_request_hmac"] != self.digest
            or row["command_effect"] != "action"
        ):
            raise ActionDirectiveAuthorityError(
                "This operation does not match the confirmed effect."
            )
        if row["effect_receipt"]:
            return dict(row["effect_receipt"])
        if (
            not session
            or not command_authority_is_current(
                self.connection, created_at=session["created_at"], expires_at=row["expires_at"]
            )
            or session["command_status"] not in {"ready", "admitted"}
            or row["state"] != "consumed"
        ):
            raise ActionDirectiveAuthorityError("This command is no longer active.")
        return None

    def save(self, receipt: dict[str, Any]) -> dict[str, Any]:
        if len(json.dumps(receipt)) > 4096:
            raise ActionDirectiveAuthorityError("The operation receipt exceeds its bound.")
        # Domain writers may have waited on locks after their initial claim.
        # Recheck the database clock inside this same transaction so expiry
        # rolls their effects back, including callers with additional locks.
        if self.claim() is not None:
            raise ActionDirectiveAuthorityError("This operation already has a committed receipt.")
        result = self.connection.execute(
            text("""UPDATE one_action_directive_ledger
            SET effect_receipt=CAST(:receipt AS JSONB),state='settled',settlement_status='succeeded',settled_at=NOW()
            WHERE user_id=:owner AND operation_id=:operation AND action_id=:action
              AND state='consumed' AND effect_receipt IS NULL AND effect_request_hmac=:digest"""),
            {
                "owner": self.owner,
                "operation": self.operation,
                "action": self.action,
                "digest": self.digest,
                "receipt": json.dumps(receipt),
            },
        )
        if result.rowcount != 1:
            raise ActionDirectiveAuthorityError("The operation receipt could not be committed.")
        return receipt
