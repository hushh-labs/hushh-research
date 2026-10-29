"""Recipients and send readiness for One's typed-chat Gmail draft.

One decides that the person wants to email someone and passes the addresses
and names it heard. This module only validates addresses with the Gmail
delivery path's own normalizer and matches names against the owner's active
connections (backend-semantic-boundary.md: the host resolves and validates the
connected person). It never reads the directory or pending requests, never
invents an address and never sends. Refusals name the person as said and never
carry an email address. Send readiness is advisory: prepare stays the
authority when the owner taps Send.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Literal

from hushh_mcp.services.connections_service import ConnectionsService
from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError, normalize_draft
from hushh_mcp.services.gmail_receipts_service import GmailApiError, get_gmail_receipts_service
from hushh_mcp.services.spoken_name_resolver import (
    normalize_spoken_name,
    resolve_spoken_names,
    split_spoken_names,
)

logger = logging.getLogger(__name__)

GmailSendReadiness = Literal[
    "ready", "connect_required", "send_permission_required", "send_disabled", "unknown"
]

# The delivery path's own limit (normalize_draft refuses more than 50), so a
# draft One addresses can always be prepared.
MAX_DRAFT_RECIPIENTS = 50
_MAX_CANDIDATES = 4
_UNNAMED_CONNECTION = "Hussh member"
# "*", bullet and ellipsis mask addresses for display (pii_sanitizer,
# ria_claim_service). A masked value is never a real destination.
_MASK_CHARACTERS = frozenset("*•…")
_ROLE_LABELS = {"to": "To", "cc": "Cc", "bcc": "Bcc"}
_READINESS_BY_CODE: dict[str, GmailSendReadiness] = {
    "GMAIL_NOT_CONNECTED": "connect_required",
    "GMAIL_SEND_PERMISSION_REQUIRED": "send_permission_required",
    "GMAIL_SEND_DISABLED": "send_disabled",
}


@dataclass(frozen=True)
class _Entry:
    """One recipient as supplied: an address token, or a name as said."""

    role: str
    text: str
    address: str | None = None  # the delivery normalizer's form, addresses only


@dataclass(frozen=True)
class _Match:
    address: str
    display_name: str


def _refusal(status: str, message: str, *, reason: str, **fields: Any) -> dict[str, Any]:
    # Log codes stay under 24 characters so the runtime log redactor keeps them.
    logger.info("one.email_draft.recipients outcome=%s", reason)
    return {"status": status, **fields, "message": message}


def _usable_address(value: Any) -> str | None:
    """The delivery path's normalized address, or None when it can't be sent to."""
    if not isinstance(value, str) or not value.strip():
        return None
    if any(char in _MASK_CHARACTERS for char in value):
        return None
    try:
        normalized = normalize_draft({"to": value})
    except GmailDeliveryError:
        return None
    if len(normalized.to) != 1:
        return None
    # The parser can join stray words into the address ("a@b.co x" becomes
    # "a@b.cox"); refuse unless the normalized address is what was written.
    address = normalized.to[0]
    return address if address in value.lower() else None


def _display_name(row: dict[str, Any]) -> str:
    return str(row.get("displayName") or "").strip()


def _shown_name(row: dict[str, Any]) -> str:
    """The name to show; a display name holding an address is never shown."""
    name = _display_name(row)
    return name if name and "@" not in name else _UNNAMED_CONNECTION


def _split_field(value: str) -> list[str]:
    """Split on commas and semicolons outside a quoted display name or <address>."""
    tokens: list[str] = []
    start = 0
    quoted = angled = False
    for index, char in enumerate(value):
        if char == '"' and not angled:
            quoted = not quoted
        elif char in "<>" and not quoted:
            angled = char == "<"
        elif char in ",;" and not (quoted or angled):
            tokens.append(value[start:index])
            start = index + 1
    tokens.append(value[start:])
    return [token.strip() for token in tokens if token.strip()]


def _parse(fields: tuple[tuple[str, str], ...]) -> list[_Entry] | dict[str, Any]:
    """A token with "@" is an address and is validated now; any other is a name."""
    entries: list[_Entry] = []
    for role, raw in fields:
        for token in _split_field(raw):
            if "@" not in token:
                entries.extend(
                    _Entry(role, name)
                    for name in split_spoken_names(token)
                    if normalize_spoken_name(name)
                )
                continue
            address = _usable_address(token)
            if address is None:
                return _refusal(
                    "invalid_recipient",
                    f"An address in {_ROLE_LABELS[role]} isn't valid. "
                    "Ask for the correct email address.",
                    reason="invalid_address",
                )
            entries.append(_Entry(role, token, address))
    return entries


def _has_whole_word(row: dict[str, Any], name: str) -> bool:
    return f" {normalize_spoken_name(name)} " in f" {normalize_spoken_name(_display_name(row))} "


def _one_per_mailbox(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Connections that share one usable email are one recipient."""
    kept: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        address = _usable_address(row.get("email"))
        if address in seen:
            continue
        if address is not None:
            seen.add(address)
        kept.append(row)
    return kept


def _tie_break(rows: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    """One mailbox wins; otherwise only the single match holding the name as whole words."""
    if len(rows) == 1:
        return rows[0]
    hits = [row for row in rows if _has_whole_word(row, name)]
    return hits[0] if len(hits) == 1 else None


def _candidate_names(rows: list[dict[str, Any]], name: str) -> list[str]:
    """Up to four display names, whole-word matches first. Never an email."""
    ordered = sorted(rows, key=lambda row: not _has_whole_word(row, name))
    return [_shown_name(row) for row in ordered[:_MAX_CANDIDATES]]


def _match_one(rows: list[dict[str, Any]], name: str) -> _Match | dict[str, Any]:
    resolution = resolve_spoken_names(rows, name, _display_name)
    if resolution.resolved:
        row = resolution.resolved[0]
    else:
        unresolved = resolution.unresolved[0]
        if unresolved.kind != "ambiguous":
            return _refusal(
                "recipient_not_found",
                f"{name} isn't one of your connections. Ask for their email address.",
                reason="not_found",
                name=name,
            )
        candidates = _one_per_mailbox(list(unresolved.matches))
        picked = _tie_break(candidates, name)
        if picked is None:
            return _refusal(
                "recipient_choice_needed",
                f"More than one connection matches {name}. Ask which one they mean.",
                reason="choice_needed",
                name=name,
                candidates=_candidate_names(candidates, name),
            )
        row = picked
    address = _usable_address(row.get("email"))
    if address is None:
        display_name = _shown_name(row)
        return _refusal(
            "recipient_email_unavailable",
            f"{display_name} has no usable email address. Ask for their email address.",
            reason="no_email",
            name=name,
            display_name=display_name,
        )
    return _Match(address, _shown_name(row))


def _match_names(owner: str, names: list[str]) -> list[_Match] | dict[str, Any]:
    """Read the owner's active connections once; the first problem wins."""
    rows = ConnectionsService().list_connections(owner)
    matches: list[_Match] = []
    for name in names:
        outcome = _match_one(rows, name)
        if isinstance(outcome, dict):
            return outcome
        matches.append(outcome)
    return matches


async def _resolve_names(user_id: str, names: list[str]) -> list[_Match] | dict[str, Any]:
    unavailable = {
        "status": "recipient_lookup_unavailable",
        "message": "Connections couldn't be checked right now. "
        "Ask for the email address or try again.",
    }
    owner = str(user_id or "").strip()
    if not owner:
        return unavailable
    try:
        # Matching is CPU work over every connection, so it shares the thread.
        return await asyncio.to_thread(_match_names, owner, names)
    except Exception as exc:  # noqa: BLE001 - a failed lookup is a refusal, never a guess
        logger.warning(
            "one.email_draft.recipients outcome=lookup_failed error=%s", type(exc).__name__
        )
        return unavailable


def _envelope(entries: list[_Entry], by_name: dict[str, _Match]) -> dict[str, Any]:
    """Join each role in order. A mailbox stays only in the first role it reaches."""
    fields: dict[str, list[str]] = {"to": [], "cc": [], "bcc": []}
    landed: dict[str, str] = {}
    named: set[str] = set()
    recipients: list[dict[str, str]] = []
    for entry in entries:
        if entry.address is not None:
            address, text, display_name = entry.address, entry.text, ""
        else:
            match = by_name[entry.text]
            address, text, display_name = match.address, match.address, match.display_name
        if address not in landed:
            landed[address] = entry.role
            fields[entry.role].append(text)
        if display_name and address not in named:
            named.add(address)
            recipients.append({"name": display_name, "role": landed[address]})
    return {
        "status": "ok",
        "to": ", ".join(fields["to"]),
        "cc": ", ".join(fields["cc"]),
        "bcc": ", ".join(fields["bcc"]),
        "recipients": recipients,
    }


async def resolve_draft_recipients(
    user_id: str,
    *,
    to: str = "",
    cc: str = "",
    bcc: str = "",
    recipient_names: str = "",
    cc_names: str = "",
) -> dict[str, Any]:
    """Validate supplied addresses and match names to the owner's active connections.

    ``to``/``cc``/``bcc`` split on commas and semicolons. A token with "@" is
    an address, validated by the delivery normalizer and kept as supplied; any
    other token is a name for that role. ``recipient_names`` adds names for To
    and ``cc_names`` for Cc. Connections are read once, and only when there
    are names. Every outcome carries ``status``; every refusal a ``message``:

    - ``ok``: ``to``, ``cc``, ``bcc`` (", "-joined, each mailbox once in its
      first role) and ``recipients``, one ``{name, role}`` per connection
      matched from a name. Supplied addresses carry no name.
    - ``invalid_recipient`` or ``too_many_recipients``, before any lookup.
    - ``recipient_choice_needed`` (``name``, ``candidates``: display names),
      ``recipient_not_found`` (``name``), ``recipient_email_unavailable``
      (``name``, ``display_name``), first problem in To, Cc, Bcc order.
    - ``recipient_lookup_unavailable`` when connections can't be read.
    """
    fields = (("to", to), ("to", recipient_names), ("cc", cc), ("cc", cc_names), ("bcc", bcc))
    if any(not isinstance(raw, str) for _, raw in fields):
        return _refusal(
            "invalid_recipient", "Recipients must be plain text.", reason="invalid_type"
        )
    parsed = _parse(fields)
    if isinstance(parsed, dict):
        return parsed
    distinct = {entry.address or normalize_spoken_name(entry.text) for entry in parsed}
    if len(distinct) > MAX_DRAFT_RECIPIENTS:
        return _refusal(
            "too_many_recipients",
            f"An email can have at most {MAX_DRAFT_RECIPIENTS} recipients. Ask which ones to keep.",
            reason="too_many",
        )
    names = list(dict.fromkeys(entry.text for entry in parsed if entry.address is None))
    if not names:
        return _envelope(parsed, {})
    outcome = await _resolve_names(user_id, names)
    if isinstance(outcome, dict):
        return outcome
    logger.info("one.email_draft.recipients outcome=ok named=%d", len(outcome))
    return _envelope(parsed, dict(zip(names, outcome, strict=True)))


async def gmail_send_readiness(user_id: str, *, timeout_seconds: float = 2.5) -> GmailSendReadiness:
    """Advisory Gmail send state from the DB-only admission check.

    Never raises and never refreshes or returns a token. Any failure other
    than a known admission code, including the timeout, is ``unknown``.
    """
    owner = str(user_id or "").strip()
    if not owner:
        return "unknown"
    try:
        await asyncio.wait_for(
            get_gmail_receipts_service().assert_send_ready(user_id=owner),
            timeout=timeout_seconds,
        )
    except GmailApiError as exc:
        return _READINESS_BY_CODE.get(str(exc.code or ""), "unknown")
    except Exception as exc:  # noqa: BLE001 - advisory readiness never blocks a draft
        logger.warning("one.gmail_send_readiness outcome=unknown error=%s", type(exc).__name__)
        return "unknown"
    return "ready"
