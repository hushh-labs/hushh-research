"""Atomic public-link operations inside the existing Location service.

Manual and command callers share an owner lock. Postgres remains the effect and
receipt authority; a future Redis notification adapter must preserve this fence.
No public token, position or personal label enters the operation receipt.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable
from uuid import UUID

from sqlalchemy import text

from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
from hushh_mcp.services.location_command_effect_receipts import CommandEffectReceipt


def public_link_terms(action: str, binding: dict[str, Any]) -> dict[str, Any]:
    if action not in {"location.create_public_link", "location.revoke_public_link"}:
        raise ActionDirectiveAuthorityError("This action does not change a public link.")
    active = binding.get("activeInvite")
    if active is not None:
        try:
            if not isinstance(active, dict) or str(UUID(active["id"])) != active["id"]:
                raise ValueError()
            expiry = datetime.fromisoformat(active["expiresAt"].replace("Z", "+00:00"))
            if expiry.tzinfo is None:
                raise ValueError()
        except (ValueError, TypeError, KeyError, AttributeError):
            raise ActionDirectiveAuthorityError(
                "Refresh the exact public link before reviewing it."
            ) from None
        active = {"id": active["id"], "expiresAt": expiry.astimezone(timezone.utc).isoformat()}
    if action == "location.revoke_public_link":
        if not active:
            raise ActionDirectiveAuthorityError("Choose the live link to revoke.")
        return {"activeInvite": active}
    duration = binding.get("durationHours")
    if type(duration) not in {int, float} or duration not in {0.25, 0.5, 1}:
        raise ActionDirectiveAuthorityError(
            "Choose a supported public-link duration, up to one hour."
        )
    return {"activeInvite": active, "durationHours": duration}


def write_public_link(
    service: Any,
    *,
    owner: str,
    action: str,
    effect: Callable[[], dict[str, Any]],
    operation: str | None = None,
    binding: dict[str, Any] | None = None,
    duration: float | None = None,
    invite_id: str | None = None,
) -> dict[str, Any]:
    if (operation is None) != (binding is None):
        raise ActionDirectiveAuthorityError(
            "The command operation and reviewed link must be supplied together."
        )
    if binding is not None and binding.get("action") != action:
        raise ActionDirectiveAuthorityError("This command reviewed a different public-link action.")
    with service._event_bound_writer():
        conn = getattr(service, "_key_writer_connection", None)
        receipt = None
        terms = None
        if operation:
            if conn is None or not binding or binding.get("owner") != owner:
                raise ActionDirectiveAuthorityError("Review this public link before creating it.")
            terms = public_link_terms(action, binding)
            if duration is not None and duration != terms.get("durationHours"):
                raise ActionDirectiveAuthorityError("The public-link duration changed.")
            if invite_id is not None and invite_id != (terms.get("activeInvite") or {}).get("id"):
                raise ActionDirectiveAuthorityError(
                    "The public link differs from the reviewed link."
                )
            receipt = CommandEffectReceipt(
                conn, owner=owner, operation=operation, action=action, terms=terms
            )
            previous = receipt.claim()
            if previous is not None:
                row = service._execute_one(
                    """SELECT * FROM one_location_public_invites
                    WHERE owner_user_id=:owner AND id=CAST(:id AS UUID)""",
                    {"owner": owner, "id": previous["invite_id"]},
                )
                invite = service._public_invite_payload(row) or {}
                return {
                    "invite": invite,
                    "publicUrl": invite.get("publicUrl"),
                    "reused": previous.get("reused", False),
                    "operationReceipt": previous,
                }
        if conn is not None:
            # Manual callers take this same lock: concurrent initial creates
            # cannot mint two URLs while command confirmation pins no live link.
            conn.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:key,0))"),
                {"key": f"location-public-link:{owner}"},
            )
        if receipt and terms is not None:
            receipt.claim()  # Recheck real expiry after waiting for the domain lock.
            rows = service._execute_many(
                """SELECT * FROM one_location_public_invites
                WHERE owner_user_id=:owner AND status='active' AND expires_at>clock_timestamp()
                ORDER BY created_at DESC FOR UPDATE""",
                {"owner": owner},
            )
            expected = terms["activeInvite"]
            actual = [
                {
                    "id": str(row["id"]),
                    "expiresAt": row["expires_at"].astimezone(timezone.utc).isoformat(),
                }
                for row in rows
            ]
            if action == "location.revoke_public_link":
                matches = [value for value in actual if value["id"] == invite_id]
                valid = matches == [expected]
            else:
                valid = actual == ([expected] if expected else [])
            if not valid:
                raise ActionDirectiveAuthorityError(
                    "Your live links changed. Refresh and review the exact link and duration."
                )
        result = effect()
        if receipt:
            if terms is None:
                raise ActionDirectiveAuthorityError(
                    "The reviewed public-link terms are unavailable."
                )
            invite = result["invite"]
            expected = terms["activeInvite"]
            if (
                action == "location.create_public_link"
                and expected
                and (invite["id"] != expected["id"] or result.get("reused") is not True)
            ):
                # Expiry or a legacy non-derivable token may make the manual
                # service mint a replacement. A reviewed extension cannot.
                raise ActionDirectiveAuthorityError(
                    "That link can no longer be extended. Review creating a new link."
                )
            result["operationReceipt"] = receipt.save(
                {
                    "operation_id": operation,
                    "invite_id": invite["id"],
                    "expires_at": invite.get("expiresAt"),
                    "status": invite["status"],
                    "reused": result.get("reused", False),
                }
            )
        return result
