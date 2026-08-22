"""Resolve a human label for a user id, safe to put on a lock screen.

Why this is not just ``SELECT display_name``:

``actor_identity_cache.display_name`` is **not** guaranteed to be a human name.
Migration 037 back-seeds it as ``COALESCE(mpp.display_name, rp.display_name,
ap.user_id)`` and ``ActorIdentityService._get_many_fallback`` does the same, so
for any actor that has never synced from Firebase the column holds the raw
Firebase uid. Interpolating that into a notification produces
"RPNmQAmVdlNz84GVfXxta50wnYx1 wants to connect with you on Hussh." -- which is
worse than the generic line, not better. The web has always guarded against
this (``isTechnicalRequesterIdentity`` in ``lib/consent/consent-display.ts``);
the push path never did.

Privacy: the fallback ladder deliberately stops before the phone number.
``one_location_agent_service._identity_notification_label`` already establishes
the rule for this repo -- a notification label carries "no phone-derived data",
because a banner renders on a *locked* screen where anyone holding the device
can read it. An email local part is the furthest we go, which is also what
``resolveConsentRequesterLabel`` accepts as a counterpart label on the web.
"""

from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)

_UUID_LIKE_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

# A Firebase uid is 28 characters with no spaces and no "@". Anything that long
# and that opaque is an identifier somebody stored in a name column, not a name.
# Mirrors the >=20 rule in lib/consent/consent-display.ts so the two surfaces
# reject the same strings.
_OPAQUE_TOKEN_MIN_LENGTH = 20


def looks_technical_label(value: object | None, *, user_id: str | None = None) -> bool:
    """True when ``value`` is an identifier rather than something to show a person."""
    normalized = str(value or "").strip()
    if not normalized:
        return True
    if user_id and normalized == str(user_id).strip():
        return True
    if normalized.lower().startswith("ria:"):
        return True
    if _UUID_LIKE_PATTERN.match(normalized):
        return True
    if (
        "@" not in normalized
        and " " not in normalized
        and len(normalized) >= _OPAQUE_TOKEN_MIN_LENGTH
    ):
        return True
    return False


def _email_handle(email: object | None) -> str:
    """The local part of an email, when it reads like a handle.

    Returns "" for anything that is not a plausible address, and for local parts
    that are themselves opaque (a Firebase-uid-shaped mailbox is no better than
    the uid).
    """
    normalized = str(email or "").strip()
    if "@" not in normalized:
        return ""
    local = normalized.split("@", 1)[0].strip()
    if not local or looks_technical_label(local):
        return ""
    return local


def label_from_identity_row(
    row: object | None,
    *,
    allow_email_handle: bool = True,
    fallback: str = "",
) -> str:
    """The name to show for a person whose identity row is already in hand.

    The same ladder as ``resolve_requester_label`` -- display name, rejecting
    values that are identifiers rather than names, then the email handle -- run
    against a row the caller has already read instead of re-querying for it.
    Callers that hold rows for a whole list need this: the querying resolver
    would turn one page of people into one round-trip each.

    ``allow_email_handle`` is a privacy boundary. An email's local part is a
    name to someone who already knows you and an identifier to someone who does
    not, so it is offered only on surfaces already scoped to a relationship.
    A broad discovery directory passes False.

    ``fallback`` is the last resort, for an account that genuinely resolves to
    nothing. Callers that want their own word for that ("Circle member") pass
    it here rather than substituting afterwards, so the ladder is what decides.
    """

    if not row:
        return fallback
    get = getattr(row, "get", None)
    if get is None:
        return fallback
    user_id = str(get("user_id") or "")
    display_name = str(get("display_name") or "").strip()
    if display_name and not looks_technical_label(display_name, user_id=user_id):
        return display_name
    if allow_email_handle:
        handle = _email_handle(get("email"))
        if handle:
            return handle
    return fallback


def resolve_requester_label(
    user_id: str,
    *,
    display_name: object | None = None,
    execute_one=None,
) -> str:
    """Best-effort lock-screen-safe label for ``user_id``. "" when unresolved.

    Never raises and never falls back to a technical identifier: the caller is
    expected to substitute the generic line when this returns "".

    ``display_name`` lets a caller that already read the identity row pass it in
    and skip the query entirely -- ``ConnectionsService`` holds one at every
    notify site. ``execute_one`` is the DB seam, defaulted lazily so importing
    this module never pulls in the database client.
    """
    uid = str(user_id or "").strip()
    if display_name is not None and not looks_technical_label(display_name, user_id=uid):
        return str(display_name).strip()
    if not uid:
        return ""

    if execute_one is None:

        def execute_one(sql: str, params: dict[str, object]) -> dict[str, object] | None:
            from db.db_client import get_db

            rows = get_db().execute_raw(sql, params).data or []
            return rows[0] if rows else None

    try:
        # One read for the whole ladder. Note there is deliberately no Firebase
        # gate here: this is a Postgres row that also feeds the in-app copy, so
        # gating it on push credentials would blank the name in any environment
        # without Firebase Admin configured while the database held it all along.
        row = execute_one(
            """
            SELECT display_name, email
            FROM actor_identity_cache
            WHERE user_id = :user_id
            LIMIT 1
            """,
            {"user_id": uid},
        )
    except Exception as exc:  # noqa: BLE001 - a name is cosmetic; never break the send
        logger.warning("requester_identity.lookup_failed error=%s", exc)
        return ""

    if not row:
        return ""

    resolved = str(row.get("display_name") or "").strip()
    if resolved and not looks_technical_label(resolved, user_id=uid):
        return resolved
    return _email_handle(row.get("email"))
