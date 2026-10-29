"""A person's own Connect directory presence (migration 433).

``directory_listed`` is the one switch that answers "do I show up when people
search for me". NULL means the person never chose, so the environment-enrolled
vault rule in ``OneLocationAgentService.search_directory_candidates`` decides;
TRUE lists them by name even with no vault (a website-only account); FALSE
hides them from strangers while existing relationships keep seeing them.
``role_label`` is what they do, in their own words, shown wherever the name is.

Kept out of ``ConnectionsService`` on purpose: that module is already far past
its size budget, and this concern needs only one row read and one row write.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Callable

from hushh_mcp.services.connections_service import ConnectionsError

ROLE_LABEL_MAX_LENGTH = 80

ExecuteOne = Callable[[str, dict[str, Any]], dict[str, Any] | None]

_PRESENCE_COLUMNS = """
      profile.directory_listed,
      profile.role_label,
      profile.updated_at,
      EXISTS (
        SELECT 1
        FROM vault_keys vault
        WHERE vault.user_id = profile.user_id
          AND vault.vault_status = 'active'
          AND vault.environment_enrolled_at IS NOT NULL
      ) AS vault_enrolled
"""


def normalize_role_label(value: str | None) -> str | None:
    """Collapse whitespace, refuse control characters, cap the length.

    An empty label clears the column. The limit is a product choice (one short
    line beside a name), enforced here and by the CHECK constraint.
    """
    label = " ".join(str(value or "").split())
    if not label:
        return None
    if len(label) > ROLE_LABEL_MAX_LENGTH:
        raise ConnectionsError(
            "CONNECTION_ROLE_LABEL_TOO_LONG",
            f"Keep what you do to {ROLE_LABEL_MAX_LENGTH} characters.",
            status_code=422,
        )
    if any(ord(character) < 32 or ord(character) == 127 for character in label):
        raise ConnectionsError(
            "CONNECTION_ROLE_LABEL_INVALID", "Describe what you do in plain text.", status_code=422
        )
    return label


def presence_payload(row: dict[str, Any] | None) -> dict[str, Any]:
    row = row or {}
    listed = row.get("directory_listed")
    if not isinstance(listed, bool):
        listed = None
    vault_enrolled = bool(row.get("vault_enrolled"))
    updated_at = row.get("updated_at")
    return {
        "listed": listed,
        # What the directory actually does today for this person.
        "effectiveListed": listed if listed is not None else vault_enrolled,
        "roleLabel": str(row.get("role_label") or "").strip() or None,
        "vaultEnrolled": vault_enrolled,
        "roleLabelMaxLength": ROLE_LABEL_MAX_LENGTH,
        "updatedAt": updated_at.isoformat() if isinstance(updated_at, datetime) else None,
    }


def _owner(user_id: str) -> str:
    owner = (user_id or "").strip()
    if not owner:
        raise ConnectionsError(
            "CONNECTION_REQUESTER_MISSING", "Missing requester id.", status_code=422
        )
    return owner


def get_directory_presence(execute_one: ExecuteOne, *, user_id: str) -> dict[str, Any]:
    """Read the person's own presence. A missing row reads as "never chose"."""
    row = execute_one(
        f"""
        SELECT {_PRESENCE_COLUMNS}
        FROM actor_profiles profile
        WHERE profile.user_id = :user_id
        LIMIT 1
        """,  # nosec B608 # the interpolated text is a module constant.
        {"user_id": _owner(user_id)},
    )
    return presence_payload(row)


def update_directory_presence(
    execute_one: ExecuteOne,
    *,
    user_id: str,
    fields: set[str],
    listed: bool | None = None,
    role_label: str | None = None,
) -> dict[str, Any]:
    """Write only the fields the caller sent; the others keep their value.

    The row is the actor spine created when the account first syncs its
    identity, so a signed-in website account already has one. No row means that
    sync has not happened yet; the caller refreshes and retries rather than this
    function inventing a profile.
    """
    owner = _owner(user_id)
    assignments: list[str] = []
    params: dict[str, Any] = {"user_id": owner}
    if "listed" in fields:
        if listed is not None and not isinstance(listed, bool):
            raise ConnectionsError(
                "CONNECTION_PRESENCE_INVALID",
                "listed must be true, false or null.",
                status_code=422,
            )
        assignments.append("directory_listed = :listed")
        params["listed"] = listed
    if "role_label" in fields:
        assignments.append("role_label = :role_label")
        params["role_label"] = normalize_role_label(role_label)
    if not assignments:
        raise ConnectionsError("CONNECTION_PRESENCE_EMPTY", "Nothing to update.", status_code=422)
    row = execute_one(
        f"""
        UPDATE actor_profiles AS profile
        SET {", ".join(assignments)}, updated_at = NOW()
        WHERE profile.user_id = :user_id
        RETURNING {_PRESENCE_COLUMNS}
        """,  # nosec B608 # assignments are fixed column fragments chosen above;
        # every caller value is bound.
        params,
    )
    if not row:
        raise ConnectionsError(
            "CONNECTION_PRESENCE_PROFILE_MISSING",
            "Your account is still being set up. Refresh and try again.",
            status_code=409,
        )
    return presence_payload(row)
