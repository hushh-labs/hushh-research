"""Tests for the consent reverse-auction offer (priced-consent bid) at the MCP layer.

The offer rides inside ``request_consent``: a Demand Agent attaches a bid to pay
the user for scoped access. The MCP handler normalizes the offer, forwards it to
the developer API, and surfaces it back. Settlement is AP2's job on approval —
this layer authorizes the read and carries the bid; it never moves money.
"""

from __future__ import annotations

import json

import pytest

from mcp_modules.tools.consent_tools import _normalize_offer

# ── _normalize_offer: pure validation/normalization ────────────────────────────


def test_normalize_offer_none_passes_through():
    offer, error = _normalize_offer(None)
    assert offer is None
    assert error is None


def test_normalize_offer_minimal_bid():
    offer, error = _normalize_offer({"bid_amount": 10})
    assert error is None
    assert offer == {"bid_amount": 10.0, "currency": "USD"}


def test_normalize_offer_full_and_normalizes_currency_and_rounds():
    offer, error = _normalize_offer(
        {
            "bid_amount": 12.499,
            "currency": "eur",
            "offer_summary": "  Travel match  ",
            "settlement_ref": "ap2_xyz",
        }
    )
    assert error is None
    assert offer == {
        "bid_amount": 12.5,
        "currency": "EUR",
        "offer_summary": "Travel match",
        "settlement_ref": "ap2_xyz",
    }


@pytest.mark.parametrize(
    "raw,expected_fragment",
    [
        ({"bid_amount": 0}, "greater than 0"),
        ({"bid_amount": -5}, "greater than 0"),
        ({"bid_amount": "abc"}, "positive number"),
        ({}, "positive number"),
        ({"bid_amount": True}, "positive number"),
        ({"bid_amount": 2_000_000}, "maximum"),
        ({"bid_amount": 10, "currency": "US"}, "ISO-4217"),
        ({"bid_amount": 10, "currency": "US1"}, "ISO-4217"),
        ("notadict", "must be an object"),
    ],
)
def test_normalize_offer_rejects_bad_input(raw, expected_fragment):
    offer, error = _normalize_offer(raw)
    assert offer is None
    assert error is not None
    assert expected_fragment in error


# ── handle_request_consent: offer forwarded + surfaced end-to-end ──────────────


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict:
        return self._payload


class _CapturingClient:
    """Stand-in httpx.AsyncClient that records the POST body and returns a canned reply."""

    captured: dict = {}

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, params=None, json=None, timeout=None):  # noqa: A002
        _CapturingClient.captured = {"url": url, "json": json}
        # Echo a pending reply that includes the offer the API would surface.
        offer = (json or {}).get("offer")
        surfaced = None
        if offer:
            surfaced = {
                "kind": "consent_reverse_auction_bid",
                "bid_amount": offer["bid_amount"],
                "currency": offer["currency"],
                "offer_summary": offer.get("offer_summary"),
                "settlement_ref": offer.get("settlement_ref"),
                "settlement_status": "pending_user_clearance",
                "settlement_rail": "ap2",
            }
        return _FakeResponse(
            200,
            {
                "status": "pending",
                "request_id": "req_test",
                "scope": (json or {}).get("scope"),
                "message": "pending",
                "offer": surfaced,
            },
        )


@pytest.fixture
def _patched_consent_env(monkeypatch):
    import mcp_modules.tools.consent_tools as ct

    async def _fake_resolve(user_id, **_):
        return user_id, None, None

    monkeypatch.setattr(ct, "resolve_user_identifier_to_uid", _fake_resolve)
    monkeypatch.setattr(ct, "resolve_scope_api", lambda s: "attr.financial.*")
    monkeypatch.setattr(ct, "DEVELOPER_API_ENABLED", True)
    monkeypatch.setattr(ct, "PRODUCTION_MODE", True)
    monkeypatch.setattr(ct, "get_developer_request_query", lambda: {"token": "hdk_demo"})
    monkeypatch.setattr(ct.httpx, "AsyncClient", _CapturingClient)
    _CapturingClient.captured = {}
    return ct


_CONNECTOR = {
    "connector_public_key": "U29tZUNvbm5lY3RvclB1YmxpY0tleURhdGE=",
    "connector_key_id": "connector_demo",
    "connector_wrapping_alg": "X25519-AES256-GCM",
}


@pytest.mark.asyncio
async def test_handle_request_consent_forwards_offer(_patched_consent_env):
    ct = _patched_consent_env
    result = await ct.handle_request_consent(
        {
            "user_id": "user_123",
            "scope": "attr.financial.*",
            "offer": {"bid_amount": 25, "currency": "usd", "offer_summary": "Deal"},
            **_CONNECTOR,
        }
    )
    # The offer was normalized and forwarded in the API POST body.
    sent = _CapturingClient.captured["json"]["offer"]
    assert sent == {"bid_amount": 25.0, "currency": "USD", "offer_summary": "Deal"}

    # The offer is surfaced back in the MCP tool response.
    payload = json.loads(result[0].text)
    assert payload["status"] == "pending"
    assert payload["offer"]["bid_amount"] == 25.0
    assert payload["offer"]["settlement_rail"] == "ap2"
    assert payload["offer"]["settlement_status"] == "pending_user_clearance"


@pytest.mark.asyncio
async def test_handle_request_consent_no_offer_omits_field(_patched_consent_env):
    ct = _patched_consent_env
    result = await ct.handle_request_consent(
        {"user_id": "user_123", "scope": "attr.financial.*", **_CONNECTOR}
    )
    assert "offer" not in _CapturingClient.captured["json"]
    payload = json.loads(result[0].text)
    assert payload["status"] == "pending"
    assert payload["offer"] is None


@pytest.mark.asyncio
async def test_handle_request_consent_rejects_bad_offer_before_network(_patched_consent_env):
    ct = _patched_consent_env
    result = await ct.handle_request_consent(
        {
            "user_id": "user_123",
            "scope": "attr.financial.*",
            "offer": {"bid_amount": -1},
            **_CONNECTOR,
        }
    )
    payload = json.loads(result[0].text)
    assert payload["status"] == "error"
    assert "greater than 0" in payload["error"]
    # No network call happened — bad offer rejected up front.
    assert _CapturingClient.captured == {}
