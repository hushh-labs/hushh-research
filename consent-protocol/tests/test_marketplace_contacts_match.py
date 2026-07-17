"""Route-level tests for POST /api/marketplace/contacts/match.

The handler serializes each MarketplaceContactLookup before handing it to
RIAIAMService.match_marketplace_contacts, which reads item["hash"] and
item["last4"] from plain dicts. These tests drive the live marketplace
router through TestClient and assert:

1. The handler forwards the lookups to the service as a list of dicts with
   the expected keys, so the service contract keeps working.
2. The serialized items are produced via the Pydantic v2 model_dump API
   (no deprecated v1 dict call is emitted on this path).
3. The authenticated firebase uid and limit are forwarded unchanged.

Canonical attach:
  api/routes/marketplace.py  -- match_marketplace_contacts handler
"""

from __future__ import annotations

import warnings

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import marketplace

USER_ID = "user_abc"
VALID_HASH = "a" * 64
VALID_LAST4 = "1234"


class _CapturingRIAIAMService:
    """Stand-in service that records what the route forwards."""

    last_call: dict = {}

    def __init__(self, *args, **kwargs):
        pass

    async def match_marketplace_contacts(self, user_id, *, phone_lookups, limit):
        _CapturingRIAIAMService.last_call = {
            "user_id": user_id,
            "phone_lookups": phone_lookups,
            "limit": limit,
        }
        return [{"user_id": "match_1", "phone_number": "+15551234567"}]


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(marketplace, "RIAIAMService", _CapturingRIAIAMService)

    app = FastAPI()
    app.include_router(marketplace.router)
    app.dependency_overrides[marketplace.require_firebase_auth] = lambda: USER_ID
    return TestClient(app)


def test_contacts_match_forwards_lookups_as_dicts(client):
    response = client.post(
        "/api/marketplace/contacts/match",
        json={
            "phone_lookups": [{"hash": VALID_HASH, "last4": VALID_LAST4}],
            "limit": 25,
        },
    )

    assert response.status_code == 200
    assert response.json() == {"items": [{"user_id": "match_1", "phone_number": "+15551234567"}]}

    call = _CapturingRIAIAMService.last_call
    assert call["user_id"] == USER_ID
    assert call["limit"] == 25
    assert call["phone_lookups"] == [{"hash": VALID_HASH, "last4": VALID_LAST4}]
    # Each forwarded lookup must be a plain dict the service can index into.
    assert all(isinstance(item, dict) for item in call["phone_lookups"])
    assert call["phone_lookups"][0]["hash"] == VALID_HASH
    assert call["phone_lookups"][0]["last4"] == VALID_LAST4


def test_contacts_match_emits_no_pydantic_deprecation(client):
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        response = client.post(
            "/api/marketplace/contacts/match",
            json={
                "phone_lookups": [{"hash": VALID_HASH, "last4": VALID_LAST4}],
                "limit": 10,
            },
        )

    assert response.status_code == 200


def test_contacts_match_rejects_malformed_hash(client):
    response = client.post(
        "/api/marketplace/contacts/match",
        json={
            "phone_lookups": [{"hash": "tooshort", "last4": VALID_LAST4}],
            "limit": 10,
        },
    )

    assert response.status_code == 422
