"""One server-side sensitivity authority (CONTRACT-2 C7).

``scope_sensitivity`` decides, for every surface, whether a scope's values may
ever reach the model. It is deny by default and exposed on the request catalog,
on ``progress.fields[]`` and on the "Shared with you" card items.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.one import information_requests, people
from hushh_mcp.consent.scope_sensitivity import scope_sensitivity
from hushh_mcp.one_adk.action_tools import _proposed_item
from hushh_mcp.services.connections_service import ConnectionsService
from hushh_mcp.services.information_request_service import InformationRequestService
from hushh_mcp.services.person_profile_service import PersonProfileService

PERSON_REF = "11111111-1111-4111-8111-111111111111"
BUNDLE = "0f0e0d0c-0b0a-4908-8706-050403020100"


@pytest.mark.parametrize(
    "scope",
    [
        # Tax
        "attr.tax_record.*",
        "attr.taxes.w2",
        "attr.personal.tax_id",
        # Financial or banking
        "attr.financial.summary.*",
        "attr.banking.accounts.*",
        "attr.professional.salary_history",
        # A pasted context document files pay and status under career and
        # immigration branches, not under the words above (2026-09-29).
        "attr.career.compensation.*",
        "attr.career.compensation.base_pay",
        "attr.career.annual_bonus",
        "attr.career.equity_grant",
        "attr.ria.*",
        "attr.wallet.summary.*",
        # Identity or government id
        "attr.identity.*",
        "attr.personal.passport_number",
        "attr.immigration.*",
        "attr.profile.citizenship",
        "attr.status.green_card",
        "attr.employment.work_permit",
        "attr.personal.socialSecurityNumber",
        "attr.documents.drivers_license",
        # An identifier FIELD is sensitive in any domain (run 4, S3): the EIN
        # was standard as "Fein" under a standard Legal entity domain.
        "attr.legal_entity.entity.fein",
        "attr.professional.employer.routing_number",
        "attr.social.date_of_birth",
        # Health or medical
        "attr.health.*",
        "attr.medical_history.medications",
        "attr.food.allergies",
        # Credentials
        "attr.runtime_secrets.*",
        "attr.profile.api_keys",
        "attr.accounts.passwords",
        # The Secrets area: every item, even by its masked label.
        "attr.secrets.items.sec_00000000000000ab",
    ],
)
def test_the_founders_five_categories_are_sensitive(scope: str) -> None:
    assert scope_sensitivity(scope) == "sensitive"


@pytest.mark.parametrize("scope", [None, "", "attr", "attr.", "pkm.read", "bogus", "vault.owner"])
def test_anything_it_cannot_classify_is_sensitive(scope: str | None) -> None:
    assert scope_sensitivity(scope) == "sensitive"


@pytest.mark.parametrize(
    "scope",
    [
        "attr.food.preferences.*",
        "attr.food.favorite_restaurant",
        "attr.travel.trips.*",
        "attr.entertainment.movies",
        "attr.shopping.wishlist",
        "attr.professional.employment.status",
        "attr.legal_entity.*",
        "attr.legal_entity.entity.trade_name_dba",
    ],
)
def test_everyday_information_is_standard(scope: str) -> None:
    assert scope_sensitivity(scope) == "standard"


@pytest.mark.parametrize("tag", ["restricted", "confidential", "sensitive", "SENSITIVE"])
def test_a_pkm_tag_makes_a_standard_scope_sensitive(tag: str) -> None:
    assert scope_sensitivity("attr.food.preferences.*", [tag]) == "sensitive"


@pytest.mark.parametrize("tag", ["standard", "public", "internal", None, ""])
def test_a_tag_never_downgrades_a_sensitive_scope(tag: str | None) -> None:
    assert scope_sensitivity("attr.tax_record.*", [tag]) == "sensitive"
    assert scope_sensitivity("attr.food.preferences.*", [tag]) == "standard"


def test_the_field_rule_matches_its_shared_truth_table() -> None:
    """The client reads the same contract; both must agree case by case."""
    import json

    from hushh_mcp.consent.field_sensitivity import field_sensitivity
    from hushh_mcp.services.generated_contracts import generated_contract_path

    contract = json.loads(
        generated_contract_path("consent", "field-sensitivity.v1.json").read_text()
    )
    wrong = [
        case
        for case in contract["cases"]
        if (field_sensitivity(case["key"], case["value"], domain=case.get("domain")) == "sensitive")
        != case["sensitive"]
    ]
    assert contract["cases"] and wrong == []


def _catalog(entries: list[dict[str, Any]]) -> dict[str, str]:
    service = ConnectionsService(scope_entries_lookup=lambda _owner: entries)
    return {
        entry["scope"]: entry["sensitivity"]
        for entry in service._safe_information_scope_entries("owner")
    }


def test_catalog_items_carry_the_authority_and_a_wildcard_inherits_its_branches_tags() -> None:
    catalog = _catalog(
        [
            {"scope": "attr.food.*", "domain": "food", "label": "Food", "wildcard": True},
            {"scope": "attr.food.preferences.*", "domain": "food", "wildcard": True},
            {
                "scope": "attr.food.preferences.diet_notes",
                "domain": "food",
                "sensitivity_label": "restricted",
            },
            {"scope": "attr.travel.trips.*", "domain": "travel", "wildcard": True},
            {"scope": "attr.tax_record.*", "domain": "tax_record", "wildcard": True},
        ]
    )
    # A grant on the food wildcard shares the tagged branch too.
    assert catalog["attr.food.*"] == "sensitive"
    assert catalog["attr.food.preferences.*"] == "sensitive"
    assert catalog["attr.food.preferences.diet_notes"] == "sensitive"
    assert catalog["attr.travel.trips.*"] == "standard"
    assert catalog["attr.tax_record.*"] == "sensitive"


def test_a_proposal_item_names_its_sensitivity_and_denies_when_unknown() -> None:
    assert _proposed_item({"scopeRef": "psr_a", "sensitivity": "standard"}, "x")["sensitivity"] == (
        "standard"
    )
    assert _proposed_item({"scopeRef": "psr_b"}, "x")["sensitivity"] == "sensitive"


def test_scope_catalog_route_exposes_sensitivity_per_item(monkeypatch) -> None:
    entries = [
        {"scope": "attr.tax_record.*", "domain": "tax_record", "label": "Tax Record Domain"},
        {"scope": "attr.food.preferences.*", "domain": "food", "label": "Food preferences"},
        # A stored "standard" cannot downgrade a tax scope.
        {
            "scope": "attr.tax_record.refund",
            "domain": "tax_record",
            "label": "Refund",
            "sensitivity": "standard",
        },
    ]
    service = PersonProfileService(
        connections=SimpleNamespace(get_exact_requestable_scope_entries=lambda *_args: entries),
        consent_db=SimpleNamespace(),
    )
    monkeypatch.setattr(
        service,
        "_profile_row",
        lambda _ref: {"user_id": "subject", "public_person_ref": PERSON_REF, "display_name": "M"},
    )
    monkeypatch.setattr(people, "_service", lambda: service)
    app = FastAPI()
    app.include_router(people.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "viewer"
    response = TestClient(app).get(f"/api/one/people/{PERSON_REF}/scope-catalog?limit=20")

    assert response.status_code == 200
    by_label = {item["label"]: item["sensitivity"] for item in response.json()["items"]}
    assert by_label["Tax record"] == "sensitive"
    assert by_label["Food preferences"] == "standard"
    assert by_label["Refund"] == "sensitive"
    assert "Tax Record Domain" not in by_label
    assert "attr." not in response.text


class _BundleService(InformationRequestService):
    """The requester-bound bundle view over fixed rows; no database."""

    def __init__(self) -> None:
        consent = SimpleNamespace(
            get_request_status=self._status,
            list_internal_request_events=self._notifications,
        )
        super().__init__(profiles=SimpleNamespace(), consent_db=consent)

    @staticmethod
    async def _status(_subject: str, request_id: str) -> dict[str, Any]:
        return {"action": "CONSENT_GRANTED", "request_id": request_id, "expires_at": None}

    @staticmethod
    async def _notifications(_request_ids, *, actions=None, user_id=None) -> list[dict[str, Any]]:
        return []

    async def _bundle(self, requester_user_id: str, bundle_id: str):
        assert requester_user_id == "viewer"
        return (
            {
                "bundle_id": bundle_id,
                "subject_user_id": "subject",
                "public_person_ref": PERSON_REF,
                "purpose": "To ensure information sharing works",
                "duration_seconds": 86_400,
                "cancelled_at": None,
                "created_at": None,
            },
            [
                {
                    "request_id": "r-tax",
                    "scope_ref": "psr_tax",
                    "scope": "attr.tax_record.*",
                    "label": "Tax Record Domain",
                    # Stored before C7 as standard; the authority overrides it.
                    "sensitivity": "standard",
                },
                {
                    "request_id": "r-food",
                    "scope_ref": "psr_food",
                    "scope": "attr.food.preferences.*",
                    "label": "Food preferences",
                    "sensitivity": None,
                },
            ],
        )

    async def _rows(self, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        return []


def test_request_progress_route_exposes_sensitivity_on_items_and_fields(monkeypatch) -> None:
    monkeypatch.setattr(information_requests, "_service", _BundleService)
    app = FastAPI()
    app.include_router(information_requests.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "viewer"}
    response = TestClient(app).get(f"/api/one/information-requests/{BUNDLE}")

    assert response.status_code == 200
    body = response.json()
    assert [(item["label"], item["sensitivity"]) for item in body["items"]] == [
        ("Tax record", "sensitive"),
        ("Food preferences", "standard"),
    ]
    assert [(field["label"], field["sensitivity"]) for field in body["progress"]["fields"]] == [
        ("Tax record", "sensitive"),
        ("Food preferences", "standard"),
    ]
