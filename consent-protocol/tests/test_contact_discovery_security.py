"""Both contact-discovery routes share abuse controls and redact failures."""

from __future__ import annotations

import hashlib
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.exc import StatementError

from api.middleware import require_firebase_auth
from api.routes import marketplace
from api.routes.one import connections
from hushh_mcp.services.connections_service import ConnectionsError

PHONE = "+14155550198"
DIGEST = hashlib.sha256(PHONE.encode("utf-8")).hexdigest()
LOOKUP = {"lookup_id": "private_lookup_1", "hash": DIGEST, "last4": "0198"}


@pytest.fixture
def contact_routes(monkeypatch):
    identity = SimpleNamespace(sync_from_firebase=AsyncMock())
    matcher = SimpleNamespace(
        match_marketplace_contacts=AsyncMock(return_value=[{"user_id": "target"}]),
        match_one_network_contact_lookups_exact=AsyncMock(return_value=[]),
    )
    graph = SimpleNamespace(
        reserve_contact_sync_lookup_budget=Mock(),
        sync_contact_matches=Mock(return_value={"items": [], "matchedCount": 0}),
    )
    monkeypatch.setattr(marketplace, "ActorIdentityService", lambda: identity)
    monkeypatch.setattr(marketplace, "ConnectionsService", lambda: graph)
    monkeypatch.setattr(marketplace, "RIAIAMService", lambda: matcher)
    monkeypatch.setattr(connections, "ActorIdentityService", lambda: identity)
    monkeypatch.setattr(connections, "RIAIAMService", lambda: matcher)
    monkeypatch.setattr(connections, "_service", lambda: graph)
    # Exercise the real handlers and shared-budget seam independently of the
    # outer per-process request limiter.
    monkeypatch.setattr(marketplace.limiter, "enabled", False)

    app = FastAPI()
    app.dependency_overrides[require_firebase_auth] = lambda: "requester"
    app.include_router(marketplace.router)
    app.include_router(connections.router)
    with TestClient(app) as client:
        yield SimpleNamespace(client=client, identity=identity, matcher=matcher, graph=graph)


def _legacy_payload(scope="one_network"):
    return {
        "scope": scope,
        "phone_lookups": [{"hash": DIGEST, "last4": "0198"}],
        "limit": 20,
    }


def test_one_network_read_charges_verified_requester_budget_before_matching(contact_routes):
    calls = []

    async def hydrate(*_args, **_kwargs):
        calls.append("hydrate")

    def reserve(*_args):
        calls.append("reserve")

    async def match(*_args, **_kwargs):
        calls.append("match")
        return [{"user_id": "target"}]

    contact_routes.identity.sync_from_firebase.side_effect = hydrate
    contact_routes.graph.reserve_contact_sync_lookup_budget.side_effect = reserve
    contact_routes.matcher.match_marketplace_contacts.side_effect = match

    response = contact_routes.client.post("/api/marketplace/contacts/match", json=_legacy_payload())

    assert response.status_code == 200
    assert response.json() == {"items": [{"user_id": "target"}]}
    assert calls == ["hydrate", "reserve", "match"]
    contact_routes.identity.sync_from_firebase.assert_awaited_once_with("requester", force=False)
    contact_routes.graph.reserve_contact_sync_lookup_budget.assert_called_once_with("requester", 1)


@pytest.mark.parametrize(
    ("code", "status"),
    [
        ("CONTACT_SYNC_REQUESTER_PHONE_VERIFICATION_REQUIRED", 403),
        ("CONTACT_SYNC_LOOKUP_BUDGET_EXCEEDED", 429),
    ],
)
def test_one_network_refuses_matching_when_canonical_requester_gate_fails(
    contact_routes, code, status
):
    contact_routes.graph.reserve_contact_sync_lookup_budget.side_effect = ConnectionsError(
        code, "Contact discovery is unavailable.", status_code=status
    )

    response = contact_routes.client.post("/api/marketplace/contacts/match", json=_legacy_payload())

    assert response.status_code == status
    assert response.json()["detail"]["code"] == code
    contact_routes.matcher.match_marketplace_contacts.assert_not_awaited()


def test_switching_contact_routes_cannot_reset_the_shared_allowance(contact_routes):
    remaining = 2

    def reserve(_user_id, count):
        nonlocal remaining
        if count > remaining:
            raise ConnectionsError(
                "CONTACT_SYNC_LOOKUP_BUDGET_EXCEEDED", "Try again later.", status_code=429
            )
        remaining -= count

    contact_routes.graph.reserve_contact_sync_lookup_budget.side_effect = reserve
    canonical = "/api/one/connections/contact-sync"
    legacy = "/api/marketplace/contacts/match"

    assert contact_routes.client.post(canonical, json={"lookups": [LOOKUP]}).status_code == 200
    assert contact_routes.client.post(legacy, json=_legacy_payload()).status_code == 200
    response = contact_routes.client.post(legacy, json=_legacy_payload())

    assert response.status_code == 429
    assert response.json()["detail"]["code"] == "CONTACT_SYNC_LOOKUP_BUDGET_EXCEEDED"
    contact_routes.matcher.match_marketplace_contacts.assert_awaited_once()


def test_marketplace_only_matching_retains_its_existing_requester_contract(contact_routes):
    response = contact_routes.client.post(
        "/api/marketplace/contacts/match", json=_legacy_payload("marketplace")
    )

    assert response.status_code == 200
    assert response.json() == {"items": [{"user_id": "target"}]}
    contact_routes.identity.sync_from_firebase.assert_not_awaited()
    contact_routes.graph.reserve_contact_sync_lookup_budget.assert_not_called()
    assert (
        contact_routes.matcher.match_marketplace_contacts.await_args.kwargs["scope"]
        == "marketplace"
    )


def test_empty_one_network_read_does_not_charge_a_zero_sized_budget(contact_routes):
    response = contact_routes.client.post(
        "/api/marketplace/contacts/match", json={"scope": "one_network", "phone_lookups": []}
    )

    assert response.status_code == 200
    contact_routes.identity.sync_from_firebase.assert_not_awaited()
    contact_routes.graph.reserve_contact_sync_lookup_budget.assert_not_called()


@pytest.mark.parametrize("stage", ["legacy_match", "canonical_match", "canonical_mutation"])
def test_contact_sql_failures_never_log_proof_parameters(contact_routes, caplog, stage):
    failure = StatementError(
        "Contact query failed",
        "SELECT private_phone_proof",
        {**LOOKUP, "phone_number": PHONE},
        RuntimeError("synthetic database failure"),
    )
    if stage == "legacy_match":
        contact_routes.matcher.match_marketplace_contacts.side_effect = failure
        route, payload = "/api/marketplace/contacts/match", _legacy_payload()
    else:
        if stage == "canonical_match":
            contact_routes.matcher.match_one_network_contact_lookups_exact.side_effect = failure
        else:
            contact_routes.graph.sync_contact_matches.side_effect = failure
        route, payload = "/api/one/connections/contact-sync", {"lookups": [LOOKUP]}

    with caplog.at_level(logging.ERROR):
        response = contact_routes.client.post(route, json=payload)

    assert response.status_code == 500
    assert "StatementError" in caplog.text
    for private_value in (PHONE, DIGEST, LOOKUP["lookup_id"], LOOKUP["last4"]):
        assert private_value not in caplog.text
        assert private_value not in response.text
    assert all(record.exc_info is None for record in caplog.records)
