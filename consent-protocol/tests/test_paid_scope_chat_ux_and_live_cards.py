"""Tests for live incoming consent card context, paid scope catalog pricing, and paid doorbells."""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from api.consent_listener import _REQUESTER_DOORBELL_ACTIONS, _information_requester_doorbell
from api.routes.one.agent_context import sanitize_visible_incoming_consent_cards
from hushh_mcp.one_adk.agent_tree import STATE_VOICE_CONTEXT, _compose_one_instruction_parts
from hushh_mcp.one_adk.live_consent_cards import (
    extract_visible_incoming_consent_cards,
    visible_incoming_consent_cards_instruction,
)
from hushh_mcp.services.information_request_service import build_request_progress
from hushh_mcp.services.person_profile_service import PersonProfileService
from hushh_mcp.services.pod_information_discovery import RequestableItem


def test_visible_incoming_consent_cards_stay_in_dynamic_tail_preserving_static_prefix() -> None:
    base_state = {
        STATE_VOICE_CONTEXT: {
            "screen_state": {
                "route": "/",
            }
        }
    }
    card_state = {
        STATE_VOICE_CONTEXT: {
            "screen_state": {
                "route": "/",
            },
            "visible_incoming_consent_cards": sanitize_visible_incoming_consent_cards(
                [
                    {
                        "requester_label": "Kushal Trivedi",
                        "labels": ["Professional agent memory"],
                        "reason": "To review his background for a project",
                        "duration_label": "7 days",
                        "status": "pending",
                        "price_coins": 1,
                        "commerce_status": "awaiting_owner",
                    },
                    {
                        "requester_label": "leak@example.com",
                        "labels": ["Should be filtered"],
                    },
                ]
            ),
        }
    }

    assert len(card_state[STATE_VOICE_CONTEXT]["visible_incoming_consent_cards"]) == 1
    static_base, _, dynamic_base = _compose_one_instruction_parts(SimpleNamespace(state=base_state))
    static_cards, _, dynamic_cards = _compose_one_instruction_parts(
        SimpleNamespace(state=card_state)
    )

    assert static_base == static_cards, "Visible consent cards must never mutate static_prefix"
    assert "VISIBLE INCOMING CONSENT CARDS ALREADY IN THIS CHAT:" not in dynamic_base
    assert "VISIBLE INCOMING CONSENT CARDS ALREADY IN THIS CHAT:" in dynamic_cards
    assert "Kushal Trivedi requested Professional agent memory" in dynamic_cards
    assert "1 Hussh coin ($0.01)" in dynamic_cards
    assert "the card above" in dynamic_cards
    assert "leak@example.com" not in dynamic_cards


def test_visible_incoming_consent_cards_extract_sanitizes_and_bounds() -> None:
    raw = [
        {
            "requester_label": "  Alice   Smith  ",
            "labels": ["Communication preferences", "   ", "Risk profile"],
            "reason": "Dinner\n\tplans",
            "duration_label": "3 days",
            "status": "INVALID_STATUS",
            "price_coins": 250,
            "commerce_status": "reserved",
        },
        {"requester_label": "", "labels": ["Ignored"]},
    ]
    state = {STATE_VOICE_CONTEXT: {"screen_state": {"visible_incoming_consent_cards": raw}}}
    cards = extract_visible_incoming_consent_cards(state.get)
    assert len(cards) == 1
    assert cards[0]["requester"] == "Alice Smith"
    assert cards[0]["labels"] == ["Communication preferences", "Risk profile"]
    assert cards[0]["status"] == "pending"
    assert cards[0]["price_coins"] == 250
    block = visible_incoming_consent_cards_instruction(state.get)
    assert "250 Hussh coins ($2.50)" in block


def test_requestable_item_accepts_optional_paid_tariff_fields() -> None:
    item = RequestableItem(
        scopeRef="psr_abc123",
        label="Agent memory",
        description="Notes",
        domain="professional",
        domainLabel="Professional",
        iconName="briefcase",
        sensitivity="standard",
        wildcard=False,
        pathSegments=["agent_memory"],
        priceCents=1,
        baseDurationHours=168,
    )
    assert item.priceCents == 1
    assert item.baseDurationHours == 168


def test_person_profile_scope_projection_includes_server_tariff_pricing() -> None:
    projection = PersonProfileService._scope_projection(
        "person-ref-1",
        {
            "scope": "attr.professional.agent_memory",
            "label": "Agent memory",
            "domain": "professional",
            "sensitivity": "standard",
            "wildcard": False,
        },
        {"attr.professional.agent_memory": (100, 168)},
    )
    assert projection is not None
    assert projection["priceCents"] == 100
    assert projection["baseDurationHours"] == 168

    free_projection = PersonProfileService._scope_projection(
        "person-ref-1",
        {
            "scope": "attr.identity.communication_preferences",
            "label": "Communication preferences",
            "domain": "identity",
            "sensitivity": "sensitive",
            "wildcard": False,
        },
        {"attr.professional.agent_memory": (100, 168)},
    )
    assert free_projection is not None
    assert "priceCents" not in free_projection


def test_build_request_progress_summarizes_paid_coin_lifecycle() -> None:
    now_ms = int(datetime(2026, 11, 22, 18, 0, tzinfo=timezone.utc).timestamp() * 1000)
    bundle = {
        "created_at": datetime(2026, 11, 22, 17, 50, tzinfo=timezone.utc),
        "cancelled_at": None,
    }
    items = [
        {
            "request_id": "req-paid-1",
            "scope": "attr.professional.agent_memory",
            "label": "Agent memory",
            "sensitivity": "standard",
        }
    ]
    pending_progress = build_request_progress(
        bundle=bundle,
        items=items,
        ledger_rows=[
            {
                "request_id": "req-paid-1",
                "action": "REQUESTED",
                "issued_at": now_ms - 60_000,
                "expires_at": now_ms + 3_600_000,
                "poll_timeout_at": now_ms + 3_600_000,
                "metadata": {
                    "commercial_required": True,
                    "bundle_price_coins": 1,
                    "commerce_status": "awaiting_owner",
                },
            }
        ],
        notification_rows=[],
        now_ms=now_ms,
    )
    assert pending_progress["commerce"] == {"total_coins": 1, "status": "reserved"}

    denied_progress = build_request_progress(
        bundle=bundle,
        items=items,
        ledger_rows=[
            {
                "request_id": "req-paid-1",
                "action": "REQUESTED",
                "issued_at": now_ms - 60_000,
                "metadata": {"commercial_required": True, "bundle_price_coins": 1},
            },
            {
                "request_id": "req-paid-1",
                "action": "CONSENT_DENIED",
                "issued_at": now_ms - 10_000,
                "metadata": {},
            },
        ],
        notification_rows=[],
        now_ms=now_ms,
    )
    assert denied_progress["commerce"] == {"total_coins": 1, "status": "refunded"}

    granted_progress = build_request_progress(
        bundle=bundle,
        items=items,
        ledger_rows=[
            {
                "request_id": "req-paid-1",
                "action": "REQUESTED",
                "issued_at": now_ms - 60_000,
                "metadata": {"commercial_required": True, "bundle_price_coins": 1},
            },
            {
                "request_id": "req-paid-1",
                "action": "CONSENT_GRANTED",
                "issued_at": now_ms - 10_000,
                "expires_at": now_ms + 3_600_000,
                "metadata": {"commercial_required": True, "commerce_status": "active"},
            },
        ],
        notification_rows=[],
        now_ms=now_ms,
    )
    assert granted_progress["commerce"] == {"total_coins": 1, "status": "active"}


@pytest.mark.asyncio
async def test_consent_listener_emits_requester_doorbell_for_paid_approved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert "CONSENT_PAID_APPROVED" in _REQUESTER_DOORBELL_ACTIONS
    fake_db = MagicMock()
    fake_db.execute_raw.return_value = MagicMock(data=[{"requester_user_id": "buyer-1"}])
    monkeypatch.setattr("db.db_client.get_db", lambda: fake_db)
    doorbell = await _information_requester_doorbell(
        {
            "action": "CONSENT_PAID_APPROVED",
            "bundle_id": "468f164a-7997-57cb-8167-1a33bc11908e",
            "request_id": "one_person_abc",
            "user_id": "owner-1",
            "issued_at": 1700000000000,
            "metadata": {"commerce_status": "awaiting_payment"},
        }
    )
    assert doorbell is not None
    requester_id, payload = doorbell
    assert requester_id == "buyer-1"
    assert payload["type"] == "information_request_updated"
    assert payload["action"] == "CONSENT_PAID_APPROVED"
    assert payload["commerce_status"] == "awaiting_payment"


@pytest.mark.asyncio
async def test_consent_listener_enriches_paid_bundle_price_even_when_core_fields_present(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from api.consent_listener import _enrich_notify_payload

    fake_db = MagicMock()
    fake_db.execute_raw.return_value = MagicMock(
        data=[
            {
                "scope_description": "Agent memory",
                "metadata": {
                    "bundle_id": "468f164a-7997-57cb-8167-1a33bc11908e",
                    "bundle_price_coins": 500,
                    "request_price_coins": 500,
                    "requester_label": "Kushal Trivedi",
                },
                "poll_timeout_at": 1700003600000,
                "expires_at": 1700003600000,
                "agent_id": "user:buyer-1",
            }
        ]
    )
    monkeypatch.setattr("db.db_client.get_db", lambda: fake_db)
    enriched = await _enrich_notify_payload(
        {
            "action": "REQUESTED",
            "user_id": "owner-1",
            "request_id": "one_person_paid_500",
            "scope": "attr.professional.agent_memory.*",
            "scope_description": "Agent memory",
            "request_url": "https://app.hussh.ai/one/consent?requestId=one_person_paid_500",
            "requester_label": "Kushal Trivedi",
            "approval_timeout_at": 1700003600000,
        }
    )
    assert enriched["bundle_price_coins"] == "500"
    assert enriched["request_price_coins"] == "500"
