"""Recipients for One's typed-chat Gmail draft (send readiness: email_draft_readiness).

One decides that the person wants to email someone and passes the addresses
and names it heard. This module only validates addresses with the Gmail
delivery path's own normalizer and matches names against the owner's active
connections (backend-semantic-boundary.md: the host resolves and validates the
connected person, and never guesses). It never reads the directory or pending
requests, never invents an address and never sends.

A name addresses the draft only when exactly one connection matches it under
the shared spoken-name rule (connections sharing one mailbox count once) and
the name as said is that connection's whole name or whole words of it; a
display name holding an address has no such words. Anything else is a question
for One, never a pick: a partial or misspelled match asks whether they mean the
closest name, and several names ask which one. Where repeating a name could not
single the connection out (several share one name under the spoken-name rule,
one has no name to show, or the name as said is one's whole name and part of
another's), One asks for the email address instead. Refusals name the person as
said and never carry an email address. A To question between several
connections also carries opaque choice refs, so "both" or "all" can address the
ones the owner picked; a ref is checked by recomputing it over the owner's
current connections, never stored, and refs never single out one of several
connections that share a name.
"""

from __future__ import annotations

import asyncio
import logging
import unicodedata
from dataclasses import dataclass
from typing import Any

from hushh_mcp.one_adk.email_draft_choices import CHOICES_TAIL, choice_ref, parse_choice_refs
from hushh_mcp.services.connections_service import ConnectionsService
from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError, normalize_draft
from hushh_mcp.services.spoken_name_resolver import (
    normalize_spoken_name,
    resolve_spoken_names,
    split_spoken_names,
)

logger = logging.getLogger(__name__)

# The delivery path's own limit (normalize_draft refuses more than 50), so a
# draft One addresses can always be prepared.
MAX_DRAFT_RECIPIENTS = 50
# The bound open_gmail_email_draft and the draft card apply to each of To, Cc
# and Bcc. The card counts UTF-16 units and drops a longer envelope for the
# model's own arguments, so no joined field may pass it.
MAX_RECIPIENT_FIELD_LENGTH = 2048
_MAX_CANDIDATES = 4
_UNNAMED_CONNECTION = "Hussh member"
# "*", bullet and ellipsis mask addresses for display (pii_sanitizer,
# ria_claim_service). A masked value is never a real destination.
_MASK_CHARACTERS = frozenset("*•…")
_ROLE_LABELS = {"to": "To", "cc": "Cc", "bcc": "Bcc"}


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


def _holds_address(text: str) -> bool:
    """An at-sign of any width (a full-width "＠" too) marks an address, never a name."""
    return "@" in unicodedata.normalize("NFKC", text)


def _shown_name(row: dict[str, Any]) -> str:
    """The name to show; a display name holding an address is never shown."""
    name = _display_name(row)
    return name if name and not _holds_address(name) else _UNNAMED_CONNECTION


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
            # The card refuses control characters in a field, so one here would leave
            # the draft showing the model's own recipients instead of this envelope.
            if address is None or any(ord(char) < 0x20 or ord(char) == 0x7F for char in token):
                return _refusal(
                    "invalid_recipient",
                    f"An address in {_ROLE_LABELS[role]} isn't valid. "
                    "Ask for the correct email address.",
                    reason="invalid_address",
                )
            entries.append(_Entry(role, token, address))
    return entries


def _has_whole_word(row: dict[str, Any], name: str) -> bool:
    display_name = _display_name(row)
    # A display name holding an address is no name: a word of it ("gmail", an
    # employer) must not fill the draft without asking.
    if _holds_address(display_name):
        return False
    return f" {normalize_spoken_name(name)} " in f" {normalize_spoken_name(display_name)} "


def _broad_matches(rows: list[dict[str, Any]], name: str) -> list[dict[str, Any]]:
    """Every connection the shared spoken-name rule matches, substring or fuzzy."""
    resolution = resolve_spoken_names(rows, name, _display_name)
    return [*resolution.resolved, *(row for miss in resolution.unresolved for row in miss.matches)]


def _one_per_mailbox(rows: list[dict[str, Any]], name: str) -> list[dict[str, Any]]:
    """Connections that share one usable email are one recipient; whole-word matches first.

    A whole-word match stands for its mailbox, so a name that is one of those
    connections' whole names is not mistaken for a partial match.
    """
    kept: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in sorted(rows, key=lambda match: not _has_whole_word(match, name)):
        address = _usable_address(row.get("email"))
        if address in seen:
            continue
        if address is not None:
            seen.add(address)
        kept.append(row)
    return kept


def _distinct_names(candidates: list[dict[str, Any]]) -> list[str]:
    """Names to show, once each under the spoken-name rule, in the first spelling."""
    names: dict[str, str] = {}
    for row in candidates:
        shown = _shown_name(row)
        names.setdefault(normalize_spoken_name(shown), shown)
    return list(names.values())


def _choice_message(candidates: list[dict[str, Any]], names: list[str], name: str) -> str:
    """What One asks. A connection no name can single out is asked for by address."""
    if names == [_UNNAMED_CONNECTION]:
        return f"No connection is named {name} exactly. Ask for their email address."
    if len(names) == 1:
        shown, count = names[0], len(candidates)
        if _has_whole_word(candidates[0], name):
            return (
                f"{count} connections are named {shown}. "
                "Ask for the email address of the one they mean."
            )
        if count == 1:
            return (
                f"No connection is named {name} exactly; the closest is {shown}. "
                f"Ask whether they mean {shown}."
            )
        # Without the "closest" framing One would take the misspelling as meant.
        return (
            f"No connection is named {name} exactly; the closest are {count} connections "
            f"named {shown}. Ask whether they mean {shown} and, if so, for the email "
            "address of the one they mean."
        )
    said = normalize_spoken_name(name)
    # Saying a whole name that also matches others ("Raj" beside "Raj Kumar")
    # again would only bring back this question, and a connection without a
    # name can't be named back at all.
    by_address = [shown for shown in names if normalize_spoken_name(shown) == said]
    if _UNNAMED_CONNECTION in names:
        by_address.append("one without a name")
    if len(by_address) == len(names):
        # Every option ends in an email question, so ask for it now.
        return (
            f"More than one connection matches {name}, and none can be told apart by "
            "name. Ask for the email address of the one they mean."
        )
    if any(_has_whole_word(row, name) for row in candidates):
        question = f"More than one connection matches {name}. Ask which one they mean"
    else:
        # As above: without the "closest" framing One would take a misspelling as meant.
        labels = [n if n != _UNNAMED_CONNECTION else "a connection without a name" for n in names]
        listing = ", ".join(labels[:-1]) + " and " + labels[-1]
        question = (
            f"No connection is named {name} exactly; the closest are {listing}. "
            "Ask which one they mean"
        )
    if by_address:
        return f"{question}; if it's {' or '.join(by_address)}, ask for the email address."
    return f"{question}."


def _addressed(row: dict[str, Any], name: str) -> _Match | dict[str, Any]:
    address = _usable_address(row.get("email"))
    if address is not None:
        return _Match(address, _shown_name(row))
    display_name = _shown_name(row)
    return _refusal(
        "recipient_email_unavailable",
        f"{display_name} has no usable email address. Ask for their email address.",
        reason="no_email",
        name=name,
        display_name=display_name,
    )


def _match_ref(
    owner: str, rows: list[dict[str, Any]], ref: str, refs: list[str]
) -> _Match | dict[str, Any]:
    row = next((row for row in rows if choice_ref(owner, row) == ref), None)
    if row is None:
        return _refusal(
            "recipient_choice_expired",
            "That person is no longer one of their connections. Ask again who they mean.",
            reason="choice_expired",
        )
    shown, address = _shown_name(row), _usable_address(row.get("email"))
    # Picking one of several connections that share a name is a guess: refs
    # address all of them ("both", "all"), and one of them needs its address.
    same = [
        peer
        for peer in rows
        if normalize_spoken_name(_shown_name(peer)) == normalize_spoken_name(shown)
    ]
    peers = [
        peer
        for peer in _one_per_mailbox(same, shown)
        if _usable_address(peer.get("email")) != address
    ]
    if any(choice_ref(owner, peer) not in refs for peer in peers):
        return _refusal(
            "recipient_choice_needed",
            f"{len(peers) + 1} connections are named {shown}. "
            "Ask for the email address of the one they mean.",
            reason="choice_needed",
            name=shown,
            candidates=[shown],
        )
    return _addressed(row, shown)


def _match_one(
    owner: str, name: str, candidates: list[dict[str, Any]], offer_choices: bool
) -> _Match | dict[str, Any]:
    if not candidates:
        return _refusal(
            "recipient_not_found",
            f"{name} isn't one of your connections. Ask for their email address.",
            reason="not_found",
            name=name,
        )
    if len(candidates) > 1 or not _has_whole_word(candidates[0], name):
        # The host never picks: a partial or misspelled match, or several, is a question.
        # The message speaks only of the names One is shown.
        names = _distinct_names(candidates)[:_MAX_CANDIDATES]
        message, extra = _choice_message(candidates, names, name), {}
        if offer_choices and 1 < len(candidates) <= _MAX_CANDIDATES:
            # Every candidate, in the order asked about, so "both" or "all" can be
            # said. Refs address To only, so a Cc or Bcc name never gets them.
            extra["choices"] = [
                {"ref": choice_ref(owner, row), "name": _shown_name(row)} for row in candidates
            ]
            message += CHOICES_TAIL
        return _refusal(
            "recipient_choice_needed",
            message,
            reason="choice_needed",
            name=name,
            candidates=names,
            **extra,
        )
    return _addressed(candidates[0], name)


def _match_names(
    owner: str, names: list[str], refs: list[str], choosable: set[str]
) -> list[_Match | None] | dict[str, Any]:
    """Read the owner's active connections once; the first problem wins.

    A To name whose question the chosen refs answer maps to None: its people
    come from the refs, so it is never asked again.
    """
    rows = ConnectionsService().list_connections(owner)
    outcomes: list[_Match | None | dict[str, Any]] = []
    for name in names:
        candidates = _one_per_mailbox(_broad_matches(rows, name), name)
        offer = name in choosable
        answered = offer and any(choice_ref(owner, row) in refs for row in candidates)
        outcomes.append(None if answered else _match_one(owner, name, candidates, offer))
    outcomes += [_match_ref(owner, rows, ref, refs) for ref in refs]
    for outcome in outcomes:
        if isinstance(outcome, dict):
            return outcome
    return [outcome for outcome in outcomes if not isinstance(outcome, dict)]


async def _resolve_names(
    user_id: str, names: list[str], refs: list[str], choosable: set[str]
) -> list[_Match | None] | dict[str, Any]:
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
        return await asyncio.to_thread(_match_names, owner, names, refs, choosable)
    except Exception as exc:  # noqa: BLE001 - a failed lookup is a refusal, never a guess
        logger.warning(
            "one.email_draft.recipients outcome=lookup_failed error=%s", type(exc).__name__
        )
        return unavailable


def _envelope(entries: list[_Entry], by_name: dict[str, _Match | None]) -> dict[str, Any]:
    """Join each role in order. A mailbox stays only in the first role it reaches."""
    fields: dict[str, list[str]] = {"to": [], "cc": [], "bcc": []}
    landed: dict[str, str] = {}
    named: set[str] = set()
    recipients: list[dict[str, str]] = []
    for entry in entries:
        if entry.address is not None:
            address, text, display_name = entry.address, entry.text, ""
        elif (match := by_name[entry.text]) is None:
            continue  # A name its chosen refs answered.
        else:
            address, text, display_name = match.address, match.address, match.display_name
        if address not in landed:
            landed[address] = entry.role
            fields[entry.role].append(text)
        if display_name and address not in named:
            named.add(address)
            recipients.append({"name": display_name, "role": landed[address]})
    joined = {role: ", ".join(texts) for role, texts in fields.items()}
    for role, value in joined.items():
        if len(value.encode("utf-16-le", errors="surrogatepass")) // 2 > MAX_RECIPIENT_FIELD_LENGTH:
            return _refusal(
                "too_many_recipients",
                f"The {_ROLE_LABELS[role]} field can't fit that many addresses. "
                "Ask which ones to keep.",
                reason="field_too_long",
            )
    return {"status": "ok", **joined, "recipients": recipients}


async def resolve_draft_recipients(
    user_id: str,
    *,
    to: str = "",
    cc: str = "",
    bcc: str = "",
    recipient_names: str = "",
    cc_names: str = "",
    recipient_choices: str = "",
) -> dict[str, Any]:
    """Validate supplied addresses and match names to the owner's active connections.

    ``to``/``cc``/``bcc`` split on commas and semicolons. A token with "@" is
    an address, validated by the delivery normalizer and kept as supplied; any
    other token is a name for that role. ``recipient_names`` adds names for To
    and ``cc_names`` for Cc; ``recipient_choices`` adds comma-separated choice
    refs for To. Connections are read once, and only when there are names or
    refs. A name resolves only to the one connection it matches whole (see the
    module docstring). Every outcome carries ``status``; every refusal a
    ``message``:

    - ``ok``: ``to``, ``cc``, ``bcc`` (", "-joined, each mailbox once in its
      first role) and ``recipients``, one ``{name, role}`` per connection
      matched from a name. Supplied addresses carry no name.
    - ``invalid_recipient`` or ``too_many_recipients``, before any lookup;
      ``too_many_recipients`` also when a joined field would pass
      ``MAX_RECIPIENT_FIELD_LENGTH``.
    - ``recipient_choice_needed`` (``name``, ``candidates``: up to four
      display names, distinct under the spoken-name rule, whole-word matches
      first; ``choices``: a ``{ref, name}`` per connection when two to four
      match),
      ``recipient_not_found`` (``name``), ``recipient_email_unavailable``
      (``name``, ``display_name``), first problem in To, Cc, Bcc order, then
      refs; ``recipient_choice_expired`` for a ref that is not one of their
      current connections.
    - ``recipient_lookup_unavailable`` when connections can't be read.
    """
    fields = (("to", to), ("to", recipient_names), ("cc", cc), ("cc", cc_names), ("bcc", bcc))
    if any(not isinstance(raw, str) for _, raw in (*fields, ("to", recipient_choices))):
        return _refusal(
            "invalid_recipient", "Recipients must be plain text.", reason="invalid_type"
        )
    refs = parse_choice_refs(recipient_choices)
    if refs is None:
        return _refusal(
            "invalid_recipient",
            "A choice isn't valid. Ask again who they mean.",
            reason="bad_choice",
        )
    parsed = _parse(fields)
    if isinstance(parsed, dict):
        return parsed
    choosable = {entry.text for entry in parsed if entry.address is None and entry.role == "to"}
    parsed = [*parsed, *(_Entry("to", ref) for ref in refs)]
    distinct = {entry.address or normalize_spoken_name(entry.text) for entry in parsed}
    if len(distinct) > MAX_DRAFT_RECIPIENTS:
        return _refusal(
            "too_many_recipients",
            f"An email can have at most {MAX_DRAFT_RECIPIENTS} recipients. Ask which ones to keep.",
            reason="too_many",
        )
    names = list(
        dict.fromkeys(
            entry.text for entry in parsed if entry.address is None and entry.text not in refs
        )
    )
    if not names and not refs:
        return _envelope(parsed, {})
    outcome = await _resolve_names(user_id, names, refs, choosable)
    if isinstance(outcome, dict):
        return outcome
    envelope = _envelope(parsed, dict(zip([*names, *refs], outcome, strict=True)))
    if envelope["status"] == "ok":
        named = sum(match is not None for match in outcome)
        logger.info("one.email_draft.recipients outcome=ok named=%d", named)
    return envelope
