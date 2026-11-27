"""Bounded, prefix-cache-safe dynamic context for live incoming consent cards.

When an incoming consent request card is already popped inline in the owner's
Main Chat, the frontend passes a non-secret summary (requester label, human
scope labels, purpose, duration, pending/resolved state, and optional coin
price summary) inside ``screen_state.visible_incoming_consent_cards``.

This module renders a concise instruction block injected strictly into One's
**dynamic tail** (never the static instruction prefix) so Gemini implicit
prefix caching stays invariant while One can immediately discuss an on-screen
request without issuing a redundant ``list_pending_information_requests`` call.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

_STATE_VOICE_CONTEXT = "hussh:voice_context"

_MAX_VISIBLE_CARDS = 5
_MAX_LABELS_PER_CARD = 6
_MAX_TEXT_CHARS = 180


def _clean_line(value: Any, *, max_chars: int = _MAX_TEXT_CHARS) -> str:
    text = " ".join(str(value or "").split()).strip()
    if len(text) > max_chars:
        return text[: max_chars - 1].rstrip() + "…"
    return text


def _format_coins(coins: int) -> str:
    dollars = f"${coins / 100:.2f}"
    unit = "Hussh coin" if coins == 1 else "Hussh coins"
    return f"{coins} {unit} ({dollars})"


def extract_visible_incoming_consent_cards(
    state_getter: Callable[[str], Any] | None,
) -> list[dict[str, Any]]:
    """Extract sanitized, bounded incoming consent card metadata from turn state."""
    if not callable(state_getter):
        return []
    voice_context = state_getter(_STATE_VOICE_CONTEXT)
    if not isinstance(voice_context, dict):
        return []
    raw_cards = voice_context.get("visible_incoming_consent_cards")
    if not isinstance(raw_cards, list):
        screen_state = voice_context.get("screen_state")
        raw_cards = (
            screen_state.get("visible_incoming_consent_cards")
            if isinstance(screen_state, dict)
            else None
        )
    if not isinstance(raw_cards, list):
        return []

    cards: list[dict[str, Any]] = []
    for raw in raw_cards[:_MAX_VISIBLE_CARDS]:
        if not isinstance(raw, dict):
            continue
        requester = _clean_line(
            raw.get("requester_label") or raw.get("requesterLabel"), max_chars=80
        )
        if not requester:
            continue
        raw_labels = raw.get("labels")
        labels = [
            cleaned
            for item in (raw_labels if isinstance(raw_labels, list) else [])[:_MAX_LABELS_PER_CARD]
            if (cleaned := _clean_line(item, max_chars=80))
        ]
        if not labels:
            continue
        status = _clean_line(raw.get("status") or "pending", max_chars=24).lower()
        if status not in {"pending", "approved", "denied", "expired"}:
            status = "pending"
        reason = _clean_line(raw.get("reason"), max_chars=_MAX_TEXT_CHARS)
        duration = _clean_line(raw.get("duration_label") or raw.get("durationLabel"), max_chars=40)
        raw_price = raw.get("price_coins", raw.get("priceCoins"))
        price_coins = (
            int(raw_price)
            if isinstance(raw_price, int) and not isinstance(raw_price, bool) and raw_price > 0
            else 0
        )
        commerce_status = _clean_line(
            raw.get("commerce_status") or raw.get("commerceStatus"), max_chars=32
        ).lower()
        cards.append(
            {
                "requester": requester,
                "labels": labels,
                "status": status,
                "reason": reason,
                "duration": duration,
                "price_coins": price_coins,
                "commerce_status": commerce_status,
            }
        )
    return cards


def visible_incoming_consent_cards_instruction(
    state_getter: Callable[[str], Any] | None,
) -> str:
    """Render dynamic-tail instructions for consent cards already popped above in chat."""
    cards = extract_visible_incoming_consent_cards(state_getter)
    if not cards:
        return ""

    lines = [
        "\n\nVISIBLE INCOMING CONSENT CARDS ALREADY IN THIS CHAT:",
        "The owner already has these interactive consent request cards visible above in this conversation:",
    ]
    for card in cards:
        labels_text = ", ".join(card["labels"])
        parts = [f"- {card['requester']} requested {labels_text} [status: {card['status']}]"]
        if card["duration"]:
            parts.append(f"for {card['duration']}")
        if card["reason"]:
            parts.append(f'reason: "{card["reason"]}"')
        if card["price_coins"] > 0:
            paid_note = f"paid: {_format_coins(card['price_coins'])}"
            if card["commerce_status"]:
                paid_note += f" ({card['commerce_status'].replace('_', ' ')})"
            parts.append(paid_note)
        lines.append(" | ".join(parts))

    lines.append(
        "Rules for these visible cards: "
        "(1) If the owner asks what is being requested on screen or whether to approve/allow it, "
        "answer directly from these visible cards without calling list_pending_information_requests. "
        "(2) Refer to the interactive card as 'the card above' (never 'below'), since it is already "
        "rendered earlier in this chat. "
        "(3) If a card is paid, mention the coin/dollar amount and payment status clearly so the owner "
        "understands the commercial terms before tapping Allow or Don't allow. "
        "(4) Never approve or deny on the owner's behalf; their tap on Allow or Don't allow is the sole authorization."
    )
    return "\n".join(lines)
