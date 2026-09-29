"""The "Shared with you" secure card One shows in chat (CONTRACT-2 C6).

Founder decision 2026-09-28: when a person asks about information that is
already shared with them, One replies in one short line and the chat renders
this card at once, decrypted on their device. The card payload carries no
values. It names what was shared in human words, says whether each item is
sensitive (C7), outlines its fields by name with each field's own sensitivity
(an identifier field inside a standard item is sensitive), and carries the refs the device
opens it by: ``bundleId`` and ``grantRef`` (the request id the existing
``GET /api/one/information-requests/{bundleId}/exports`` response is keyed by).

The same payload is what the model reads for the tool result, so the model's
view is the outline and never a value. ``project_shared_with_me_card``
re-validates a stored payload for history, where a card must be restored from
the sealed tool result without trusting it.

Pure: no database, no network, no model.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any

SHARED_WITH_ME_CARD_KIND = "one.shared_with_me_card.v1"
# The client path that opens one item: fetch the bundle, then its exports, and
# match the export by ``grantRef`` (== ``requestId``).
DECRYPT_VIA = "information_request_exports"
MAX_CARD_ITEMS = 50
MAX_OUTLINE_NAMES = 12

_PERSON_REF = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_REQUEST_ID = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
_BUNDLE_ID = re.compile(r"^[0-9a-fA-F-]{8,64}$")
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T[0-9:.+\-Z]{8,40}$")


def _text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = " ".join(value.split()).strip()
    return normalized[:limit] or None


def _matching(value: Any, pattern: re.Pattern[str], limit: int = 128) -> str | None:
    text = _text(value, limit)
    return text if text and pattern.fullmatch(text) else None


def _fields(raw: Any) -> list[dict[str, str]]:
    fields: list[dict[str, str]] = []
    for entry in (raw if isinstance(raw, list) else [])[:MAX_OUTLINE_NAMES]:
        if not isinstance(entry, Mapping) or not (name := _text(entry.get("name"), 80)):
            continue
        sensitivity = "standard" if entry.get("sensitivity") == "standard" else "sensitive"
        fields.append({"name": name, "sensitivity": sensitivity})
    return fields


def _item(raw: Mapping[str, Any]) -> dict[str, Any] | None:
    grant_ref = _matching(raw.get("grantRef") or raw.get("requestId"), _REQUEST_ID)
    label = _text(raw.get("label"), 120)
    if not grant_ref or not label:
        return None
    bundle_id = _matching(raw.get("bundleId"), _BUNDLE_ID, 64)
    outline = raw.get("fieldOutline")
    return {
        "grantRef": grant_ref,
        "requestId": grant_ref,
        "bundleId": bundle_id,
        "label": label,
        # Deny by default: only an explicit "standard" is standard.
        "sensitivity": "standard" if raw.get("sensitivity") == "standard" else "sensitive",
        "fieldOutline": [
            name
            for value in (outline if isinstance(outline, list) else [])[:MAX_OUTLINE_NAMES]
            if (name := _text(value, 80))
        ],
        # C7 per field: in a standard item an identifier field (an EIN under
        # "Legal entity") is still sensitive; deny by default when unknown.
        "fields": _fields(raw.get("fields")),
        "sharedAt": _matching(raw.get("sharedAt"), _ISO, 64),
        "accessEndsAt": _matching(raw.get("accessEndsAt"), _ISO, 64),
        "purpose": _text(raw.get("purpose"), 500),
        "decryptable": bool(bundle_id) and raw.get("decryptable") is not False,
    }


def _person(person_ref: Any, display_name: Any) -> dict[str, str] | None:
    ref = _matching(person_ref, _PERSON_REF)
    if not ref:
        return None
    return {
        "personRef": ref,
        "displayName": _text(display_name, 120) or "Hussh member",
        "profilePath": f"/people/{ref}",
    }


def build_shared_with_me_cards(shares: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """One C6 card per person, in the order the shares arrive. Never a value."""
    cards: dict[str, dict[str, Any]] = {}
    for share in shares:
        if not isinstance(share, Mapping):
            continue
        person = _person(share.get("personRef"), share.get("person"))
        item = _item(share)
        if person is None or item is None:
            continue
        card = cards.setdefault(
            person["personRef"],
            {
                "kind": SHARED_WITH_ME_CARD_KIND,
                "person": person,
                "items": [],
                "decryptVia": DECRYPT_VIA,
            },
        )
        if len(card["items"]) < MAX_CARD_ITEMS and all(
            existing["grantRef"] != item["grantRef"] for existing in card["items"]
        ):
            card["items"].append(item)
    return list(cards.values())


def project_shared_with_me_card(raw: Any) -> dict[str, Any] | None:
    """Re-validate one stored card for history: allowlisted fields only."""
    if not isinstance(raw, Mapping) or raw.get("kind") != SHARED_WITH_ME_CARD_KIND:
        return None
    person_raw = raw.get("person")
    if not isinstance(person_raw, Mapping):
        return None
    person = _person(person_raw.get("personRef"), person_raw.get("displayName"))
    items_raw = raw.get("items")
    if person is None or not isinstance(items_raw, list):
        return None
    items = [
        item
        for entry in items_raw[:MAX_CARD_ITEMS]
        if isinstance(entry, Mapping) and (item := _item(entry)) is not None
    ]
    if not items:
        return None
    return {
        "kind": SHARED_WITH_ME_CARD_KIND,
        "person": person,
        "items": items,
        "decryptVia": DECRYPT_VIA,
    }


__all__ = [
    "DECRYPT_VIA",
    "SHARED_WITH_ME_CARD_KIND",
    "build_shared_with_me_cards",
    "project_shared_with_me_card",
]
