"""Exact circle effect guards inside the owning service's transaction.

The directive ledger and circle locks remain Postgres-owned. A future Redis
adapter may carry notifications, but cannot replace these effect/receipt locks.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import text

from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
from hushh_mcp.services.location_command_effect_receipts import CommandEffectReceipt

CIRCLE_EFFECT_ACTIONS = frozenset(
    {
        "location.rename_circle",
        "location.remove_from_circle",
        "location.leave_circle",
        "location.delete_circle",
        "location.accept_circle_invite",
        "location.decline_circle_invite",
    }
)


def _timestamp(value: Any) -> str:
    try:
        parsed = (
            value
            if isinstance(value, datetime)
            else datetime.fromisoformat(value.replace("Z", "+00:00"))
        )
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(timezone.utc).isoformat()
    except (ValueError, TypeError, AttributeError):
        raise ActionDirectiveAuthorityError(
            "Refresh the exact circle or invitation before reviewing it."
        ) from None


def _identity(value: Any, *, uuid: bool = False) -> str:
    if not isinstance(value, str) or not 0 < len(value) <= 160:
        raise ActionDirectiveAuthorityError("Choose a current circle, member or invitation.")
    if uuid:
        try:
            if str(UUID(value)) != value:
                raise ValueError()
        except ValueError:
            raise ActionDirectiveAuthorityError(
                "The selected circle or invitation is invalid."
            ) from None
    return value


def _roster(rows: Any) -> list[dict[str, str]]:
    if not isinstance(rows, list) or not 1 <= len(rows) <= 1000:
        raise ActionDirectiveAuthorityError(
            "Review the complete circle membership before deleting it."
        )
    values = []
    for row in rows:
        if not isinstance(row, dict) or row.get("role") not in {"owner", "member"}:
            raise ActionDirectiveAuthorityError("The circle membership changed.")
        values.append(
            {
                "userId": _identity(row.get("userId")),
                "role": row["role"],
                "joinedAt": _timestamp(row.get("joinedAt")),
            }
        )
    if len({row["userId"] for row in values}) != len(values):
        raise ActionDirectiveAuthorityError("The circle membership is incomplete.")
    return sorted(values, key=lambda row: row["userId"])


def circle_effect_terms(action: str, binding: dict[str, Any]) -> dict[str, Any]:
    if action not in CIRCLE_EFFECT_ACTIONS or binding.get("action") != action:
        raise ActionDirectiveAuthorityError("This command reviewed a different circle action.")
    terms: dict[str, Any] = {"circleId": _identity(binding.get("circleId"), uuid=True)}
    if action in {"location.accept_circle_invite", "location.decline_circle_invite"}:
        terms.update(
            inviteId=_identity(binding.get("inviteId"), uuid=True),
            inviterId=_identity(binding.get("inviterId")),
            inviteCreatedAt=_timestamp(binding.get("inviteCreatedAt")),
            inviteExpiresAt=_timestamp(binding.get("inviteExpiresAt")),
        )
        return terms
    terms["circleUpdatedAt"] = _timestamp(binding.get("circleUpdatedAt"))
    if action == "location.rename_circle":
        name = binding.get("newName")
        if not isinstance(name, str) or not 1 <= len(name) <= 80 or " ".join(name.split()) != name:
            raise ActionDirectiveAuthorityError("Choose a circle name of 1 to 80 characters.")
        terms["newName"] = name
    elif action == "location.delete_circle":
        terms["roster"] = _roster(binding.get("roster"))
    else:
        terms.update(
            memberId=_identity(binding.get("memberId")),
            joinedAt=_timestamp(binding.get("joinedAt")),
        )
    return terms


def begin_circle_command(
    connection: Any,
    *,
    owner: str,
    action: str,
    operation: str | None,
    binding: dict[str, Any] | None,
    circle_id: str | None = None,
    member_id: str | None = None,
    invite_id: str | None = None,
    new_name: str | None = None,
) -> tuple[CommandEffectReceipt | None, dict[str, Any] | None, dict[str, Any] | None]:
    """Return a prior receipt before requiring resources the operation removed."""
    if operation is None and binding is None:
        return None, None, None
    try:
        if not operation or not binding or binding.get("owner") != owner:
            raise ActionDirectiveAuthorityError(
                "The operation and owner-reviewed circle must be supplied together."
            )
        terms = circle_effect_terms(action, binding)
        for supplied, key in (
            (circle_id, "circleId"),
            (member_id, "memberId"),
            (invite_id, "inviteId"),
            (new_name, "newName"),
        ):
            if supplied is not None and supplied != terms.get(key):
                raise ActionDirectiveAuthorityError(
                    "The requested change differs from the reviewed circle action."
                )
        receipt = CommandEffectReceipt(
            connection, owner=owner, operation=operation, action=action, terms=terms
        )
        previous = receipt.claim()
        if previous is not None:
            return receipt, previous, None
        circle = (
            connection.execute(
                text("""SELECT id,owner_user_id,name,status,updated_at,is_system,system_kind
            FROM one_location_circles WHERE id=CAST(:id AS UUID) FOR UPDATE"""),
                {"id": terms["circleId"]},
            )
            .mappings()
            .first()
        )
        if not circle or circle["status"] != "active":
            raise ActionDirectiveAuthorityError(
                "This circle is no longer available. Review People."
            )
        if "inviteId" in terms:
            invite = (
                connection.execute(
                    text("""SELECT circle_id,inviter_user_id,invitee_user_id,status,created_at,expires_at
                FROM one_location_circle_member_invites WHERE id=CAST(:id AS UUID) AND invitee_user_id=:owner FOR UPDATE"""),
                    {"id": terms["inviteId"], "owner": owner},
                )
                .mappings()
                .first()
            )
            valid = (
                invite
                and invite["status"] == "pending"
                and str(invite["circle_id"]) == terms["circleId"]
                and invite["inviter_user_id"] == terms["inviterId"]
                and _timestamp(invite["created_at"]) == terms["inviteCreatedAt"]
                and _timestamp(invite["expires_at"]) == terms["inviteExpiresAt"]
            )
            if (
                not valid
                or not connection.execute(
                    text("SELECT CAST(:expiry AS TIMESTAMPTZ)>clock_timestamp()"),
                    {"expiry": terms["inviteExpiresAt"]},
                ).scalar_one()
            ):
                raise ActionDirectiveAuthorityError(
                    "That invitation changed or expired. Review People."
                )
        else:
            if (
                _timestamp(circle["updated_at"]) != terms["circleUpdatedAt"]
                or circle["system_kind"] == "trusted"
            ):
                raise ActionDirectiveAuthorityError(
                    "That circle changed or follows your connections. Review People."
                )
            if action != "location.leave_circle" and circle["owner_user_id"] != owner:
                raise ActionDirectiveAuthorityError(
                    "Only this circle's owner can make the reviewed change."
                )
            if action == "location.delete_circle":
                if circle["is_system"]:
                    raise ActionDirectiveAuthorityError("This system circle cannot be deleted.")
                rows = (
                    connection.execute(
                        text("""SELECT user_id,role,joined_at FROM one_location_circle_memberships
                    WHERE circle_id=CAST(:id AS UUID) AND status='active' ORDER BY user_id FOR UPDATE"""),
                        {"id": terms["circleId"]},
                    )
                    .mappings()
                    .all()
                )
                current = [
                    {"userId": row["user_id"], "role": row["role"], "joinedAt": row["joined_at"]}
                    for row in rows
                ]
                if _roster(current) != terms["roster"]:
                    raise ActionDirectiveAuthorityError(
                        "The circle audience changed. Review everyone before deleting it."
                    )
            elif "memberId" in terms:
                if action == "location.leave_circle" and terms["memberId"] != owner:
                    raise ActionDirectiveAuthorityError("You can only leave your own membership.")
                member = (
                    connection.execute(
                        text("""SELECT role,joined_at FROM one_location_circle_memberships
                    WHERE circle_id=CAST(:id AS UUID) AND user_id=:member AND status='active' FOR UPDATE"""),
                        {"id": terms["circleId"], "member": terms["memberId"]},
                    )
                    .mappings()
                    .first()
                )
                if (
                    not member
                    or member["role"] != "member"
                    or _timestamp(member["joined_at"]) != terms["joinedAt"]
                ):
                    raise ActionDirectiveAuthorityError(
                        "That membership changed. Review the circle before removing or leaving it."
                    )
        receipt.claim()  # Real expiry is checked again after every domain lock.
        return receipt, None, dict(circle)
    except ActionDirectiveAuthorityError as exc:
        from hushh_mcp.services.one_location_circle_service import OneLocationCircleError

        raise OneLocationCircleError(
            "LOCATION_CIRCLE_COMMAND_REVIEW_REQUIRED", str(exc), status_code=409
        ) from None


def save_circle_command(
    receipt: CommandEffectReceipt,
    *,
    operation: str,
    action: str,
    circle_id: str,
    member_id: str | None = None,
    invite_id: str | None = None,
    result: str,
) -> dict[str, Any]:
    try:
        return {
            "operationReceipt": receipt.save(
                {
                    "operation_id": operation,
                    "action_id": action,
                    "circle_id": circle_id,
                    "member_id": member_id,
                    "invite_id": invite_id,
                    "result": result,
                }
            )
        }
    except ActionDirectiveAuthorityError as exc:
        from hushh_mcp.services.one_location_circle_service import OneLocationCircleError

        raise OneLocationCircleError(
            "LOCATION_CIRCLE_COMMAND_REVIEW_REQUIRED", str(exc), status_code=409
        ) from None
