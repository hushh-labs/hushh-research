"""The "Shared with you" secure card in chat (CONTRACT-2 C6).

Baseline, founder screenshot 2026-09-28: asked about Manish's tax record, One
said the values were decrypted on the device "if an in-app reveal card is
available", showed no card, then refused to display it; the label read "Tax
Record Domain". The card payload fixes that: human labels, per-item
sensitivity, a field outline of names only, dates, and the refs the device
opens each item by. No value is ever in it.
"""

from __future__ import annotations

import json
import time
from types import SimpleNamespace
from typing import Any

import pytest

from api.routes.one.agent_chat import _safe_agent_history_metadata
from hushh_mcp.one_adk import agent_tree
from hushh_mcp.one_adk.shared_with_me_card import (
    DECRYPT_VIA,
    SHARED_WITH_ME_CARD_KIND,
    build_shared_with_me_cards,
    project_shared_with_me_card,
)
from hushh_mcp.services.information_request_service import InformationRequestService
from hushh_mcp.services.person_profile_service import field_outline, requester_principal

MANISH = "11111111-1111-4111-8111-111111111111"
VIEWER_REF = "22222222-2222-4222-8222-222222222222"
BUNDLE = "0f0e0d0c-0b0a-4908-8706-050403020100"
WITHDRAWN_BUNDLE = "1f0e0d0c-0b0a-4908-8706-050403020100"
FUTURE_MS = int(time.time() * 1000) + 86_400_000


class _Consent:
    def __init__(self) -> None:
        self.statuses = {
            "one_person_tax": {"action": "CONSENT_GRANTED", "issued_at": 1_790_000_000_000},
            "one_person_food": {"action": "CONSENT_GRANTED", "issued_at": 1_790_000_000_000},
            "one_person_ended": {"action": "REVOKED"},
            "one_person_kept": {"action": "CONSENT_GRANTED", "issued_at": 1_790_000_000_000},
        }
        self.token_reads: list[tuple[str, str | None]] = []

    async def get_request_status(self, _subject: str, request_id: str) -> dict[str, Any] | None:
        status = self.statuses.get(request_id)
        return {**status, "expires_at": FUTURE_MS} if status else None

    async def get_active_tokens(self, subject: str, agent_id: str | None = None) -> list[dict]:
        self.token_reads.append((subject, agent_id))
        return [
            # Already listed through its request row: not duplicated.
            {"request_id": "one_person_tax", "scope": "attr.tax_record.*", "expires_at": None},
            # A grant no request row lists: swept in from the ledger.
            {
                "request_id": "one_person_orphan",
                "scope": "attr.health.conditions",
                "issued_at": 1_790_000_000_000,
                "expires_at": FUTURE_MS,
                "metadata": {"reason": "To plan a trip together", "human_label": "Conditions"},
            },
        ]


class _Profiles:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, list[str]]] = []

    def field_outlines(self, viewer: str, subject: str, scopes: list[str]) -> dict[str, list[str]]:
        self.calls.append((viewer, subject, scopes))
        catalog = [
            {"scope": "attr.tax_record.*", "label": "Tax Record Domain"},
            {"scope": "attr.tax_record.filing_year", "label": "Filing year"},
            {"scope": "attr.tax_record.adjusted_gross_income", "label": "Adjusted gross income"},
            {"scope": "attr.tax_record.refund", "label": "Refund"},
            {"scope": "attr.tax_record.filing_status", "label": "Filing status"},
            {"scope": "attr.food.preferences.*", "label": "Food preferences"},
        ]
        return {scope: field_outline(scope, catalog) for scope in scopes}


class _Service(InformationRequestService):
    def __init__(self) -> None:
        self.consent = _Consent()
        self.profiles = _Profiles()
        super().__init__(profiles=self.profiles, consent_db=self.consent)
        self.sql: list[str] = []

    async def _viewer(self, _user_id: str) -> dict[str, Any]:
        return {"public_person_ref": VIEWER_REF, "display_name": "Kushal"}

    async def _rows(self, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        self.sql.append(sql)
        if "JOIN one_information_request_items item ON item.bundle_id" in sql:
            base = {
                "subject_user_id": "manish-uid",
                "public_person_ref": MANISH,
                "display_name": "Manish Sainani",
                "created_at": None,
            }
            return [
                {
                    **base,
                    "bundle_id": BUNDLE,
                    "purpose": "To ensure information sharing works",
                    "request_id": "one_person_tax",
                    "scope_ref": "psr_tax",
                    "scope": "attr.tax_record.*",
                    "label": "Tax Record Domain",
                    "sensitivity": None,
                },
                {
                    **base,
                    "bundle_id": BUNDLE,
                    "purpose": "To ensure information sharing works",
                    "request_id": "one_person_ended",
                    "scope_ref": "psr_x",
                    "scope": "attr.food.preferences.*",
                    "label": "Food preferences",
                    "sensitivity": None,
                },
                # Withdrawn after this item was approved: still shared.
                {
                    **base,
                    "bundle_id": WITHDRAWN_BUNDLE,
                    "purpose": "To pick a restaurant",
                    "request_id": "one_person_kept",
                    "scope_ref": "psr_food",
                    "scope": "attr.food.preferences.*",
                    "label": "Food preferences",
                    "sensitivity": "standard",
                },
            ]
        return []


@pytest.mark.asyncio
async def test_shares_carry_the_card_fields_and_never_a_raw_scope_or_value() -> None:
    service = _Service()
    shares = await service.list_granted_shares(requester_user_id="kushal-uid", person_ref=MANISH)

    by_request = {share["requestId"]: share for share in shares}
    assert set(by_request) == {"one_person_tax", "one_person_kept", "one_person_orphan"}
    # The request withdrawn after approval no longer hides its live share.
    assert "cancelled_at IS NULL" not in service.sql[0]

    tax = by_request["one_person_tax"]
    assert tax["label"] == "Tax record"
    assert tax["sensitivity"] == "sensitive"
    assert tax["fieldOutline"] == [
        "Filing year",
        "Adjusted gross income",
        "Refund",
        "Filing status",
    ]
    assert tax["bundleId"] == BUNDLE and tax["grantRef"] == "one_person_tax"
    assert tax["decryptable"] is True
    assert tax["purpose"] == "To ensure information sharing works"
    assert tax["sharedAt"].startswith("2026-") and tax["accessEndsAt"]

    assert by_request["one_person_kept"]["sensitivity"] == "standard"
    assert by_request["one_person_kept"]["fieldOutline"] == ["Food preferences"]

    # A grant no request names is included, honestly marked as not openable.
    orphan = by_request["one_person_orphan"]
    assert orphan["bundleId"] is None and orphan["decryptable"] is False
    assert orphan["sensitivity"] == "sensitive"
    assert orphan["purpose"] == "To plan a trip together"
    assert service.consent.token_reads == [("manish-uid", requester_principal(VIEWER_REF))]

    text = json.dumps(shares)
    assert "attr." not in text and "_scope" not in text and "_subject" not in text
    assert "Tax Record Domain" not in text
    # One stable order on every surface: person, then label, then when shared.
    labels = [share["label"] for share in shares]
    assert labels == sorted(labels, key=str.casefold)
    # C7 per field: every field of a sensitive item is sensitive.
    assert {field["sensitivity"] for field in tax["fields"]} == {"sensitive"}


def test_a_grant_a_broader_live_grant_covers_is_listed_once() -> None:
    """The run 4 ledger shapes: a wildcard asked for beside its own branches."""
    from hushh_mcp.consent.share_collapse import collapse_covered_shares

    def share(scope: str, subject: str, openable: bool = True) -> dict[str, Any]:
        return {"_scope": scope, "_subject": subject, "decryptable": openable}

    shares = [
        share("attr.legal_entity.entity.*", "manish"),
        share("attr.legal_entity.*", "manish"),
        share("attr.professional.work_preferences.entities._entities.summary", "kushal"),
        share("attr.professional.*", "kushal"),
        share("attr.food.preferences.*", "kushal"),
        share("attr.food.preferences.*", "kushal"),
        # A grant the device cannot open never absorbs one it can.
        share("attr.tax_record.*", "manish", openable=False),
        share("attr.tax_record.refund", "manish"),
        # Another person's broader grant never absorbs this person's.
        share("attr.food.*", "manish"),
    ]

    def collapse(items: list[dict[str, Any]]) -> list[tuple[str, str]]:
        return [
            (item["_scope"], item["_subject"])
            for item in collapse_covered_shares(
                items,
                scope_of=lambda item: item["_scope"],
                person_of=lambda item: item["_subject"],
                openable_of=lambda item: item["decryptable"],
            )
        ]

    assert collapse(shares) == [
        ("attr.legal_entity.*", "manish"),
        ("attr.professional.*", "kushal"),
        ("attr.food.preferences.*", "kushal"),
        ("attr.tax_record.*", "manish"),
        ("attr.tax_record.refund", "manish"),
        ("attr.food.*", "manish"),
    ]


def test_one_card_per_person_with_human_labels_and_no_values() -> None:
    shares = [
        {
            "personRef": MANISH,
            "person": "Manish Sainani",
            "bundleId": BUNDLE,
            "requestId": "one_person_tax",
            "grantRef": "one_person_tax",
            "label": "Tax record information",
            "sensitivity": "sensitive",
            "fieldOutline": ["Filing year", "Refund"],
            "sharedAt": "2026-09-21T12:00:00+00:00",
            "accessEndsAt": "2026-10-21T12:00:00+00:00",
            "purpose": "To ensure information sharing works",
            "decryptable": True,
            # Nothing outside the allowlist survives, whatever a caller adds.
            "value": {"agi": "182,400"},
            "scope": "attr.tax_record.*",
        },
        {
            "personRef": MANISH,
            "person": "Manish Sainani",
            "bundleId": BUNDLE,
            "requestId": "one_person_food",
            "label": "Food preferences",
            # Missing sensitivity is sensitive.
        },
    ]
    cards = build_shared_with_me_cards(shares)

    assert len(cards) == 1
    card = cards[0]
    assert card["kind"] == SHARED_WITH_ME_CARD_KIND == "one.shared_with_me_card.v1"
    assert card["decryptVia"] == DECRYPT_VIA
    assert card["person"] == {
        "personRef": MANISH,
        "displayName": "Manish Sainani",
        "profilePath": f"/people/{MANISH}",
    }
    tax, food = card["items"]
    assert tax == {
        "grantRef": "one_person_tax",
        "requestId": "one_person_tax",
        "bundleId": BUNDLE,
        "label": "Tax record information",
        "sensitivity": "sensitive",
        "fieldOutline": ["Filing year", "Refund"],
        "fields": [],
        "sharedAt": "2026-09-21T12:00:00+00:00",
        "accessEndsAt": "2026-10-21T12:00:00+00:00",
        "purpose": "To ensure information sharing works",
        "decryptable": True,
    }
    assert food["sensitivity"] == "sensitive"
    assert "182,400" not in json.dumps(cards) and "attr." not in json.dumps(cards)


def test_history_restores_the_card_and_drops_anything_else() -> None:
    card = build_shared_with_me_cards(
        [
            {
                "personRef": MANISH,
                "person": "Manish Sainani",
                "bundleId": BUNDLE,
                "requestId": "one_person_tax",
                "label": "Tax record information",
                "sensitivity": "sensitive",
            }
        ]
    )[0]
    stored = {**card, "items": [{**card["items"][0], "value": "182,400"}]}
    part = SimpleNamespace(
        function_response=SimpleNamespace(
            id="call-1",
            name="list_information_shared_with_me",
            response={"status": "ok", "cards": [stored]},
        )
    )
    metadata = _safe_agent_history_metadata(
        SimpleNamespace(id="event-1", content=SimpleNamespace(parts=[part]))
    )

    assert metadata["structuredExperience"] == {
        "activityType": "one.shared_with_me_card.v1",
        "content": {"cards": [card]},
    }
    assert "182,400" not in json.dumps(metadata)
    assert project_shared_with_me_card({**card, "kind": "something.else"}) is None


def test_the_instruction_asks_for_one_line_and_names_no_dead_end() -> None:
    text = agent_tree.ONE_IDENTITY_INSTRUCTION
    assert '"X approved; can I see it now?": call list_information_shared_with_me' in text
    assert '"Do we have access to X\'s Y?"' in text
    assert "Here's what Manish shared with you:" in text
    # The baseline's dead ends are gone from One's own guidance.
    assert "reveal control" not in text
    assert "If the bound Chat request card is available" not in text
    assert "can reveal them in the person's unlocked app when available" not in text


def test_the_tool_stays_on_the_one_roster() -> None:
    names = {
        getattr(tool, "__name__", "")
        for tool in agent_tree._one_roster_tools(
            specialist_model="test-model", allow_workspace_tools=True
        )
    }
    assert {"list_information_shared_with_me", "propose_information_request"} <= names
