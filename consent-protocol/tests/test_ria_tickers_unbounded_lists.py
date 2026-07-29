# tests/test_ria_tickers_unbounded_lists.py
"""
PR attach points (bounds reconciled with already-merged CWE-400 work so no
field is ever weaker than what was already shipped):
  POST /api/tickers/sync-holdings/{user_id}  SyncHoldingsRequest.holdings      max_length=1000
  POST /api/ria/request-bundles              RIAConsentBundleCreate.selected_scopes  max_length=50
  POST /api/ria/request-bundles              RIAConsentBundleCreate.selected_account_ids max_length=100
  POST /api/ria/picks/parse                  RIAPicksParseRequest.avoid_rows     max_length=1000
  POST /api/ria/picks/parse                  RIAPicksParseRequest.screening_sections max_length=100
  POST /api/ria/picks                        RIAPicksSyncRequest.top_picks       max_length=5000
  POST /api/ria/picks                        RIAPicksSyncRequest.avoid_rows      max_length=1000
  POST /api/ria/picks                        RIAPicksSyncRequest.screening_sections max_length=100
  POST /api/ria/invites                      RIAInviteCreateRequest.targets      max_length=200

Verifies that unbounded list request-body fields are rejected with 422
before reaching the service layer, preventing authenticated DoS via
resource exhaustion (large loops, DB inserts).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes import ria as ria_module
from api.routes import tickers as tickers_module

_UID = "test-uid-ria-list"

_HOLDINGS_MAX = 1000
_SCOPES_MAX = 50
_ACCOUNTS_MAX = 100
_AVOID_ROWS_MAX = 1000
_SCREENING_MAX = 100
_TOP_PICKS_MAX = 5000
_TARGETS_MAX = 200


@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(ria_module.router)
    app.include_router(tickers_module.router)

    app.dependency_overrides[require_firebase_auth] = lambda: _UID
    app.dependency_overrides[ria_module._require_ria_verified] = lambda: _UID
    app.dependency_overrides[tickers_module.require_vault_owner_token] = lambda: {
        "user_id": _UID,
        "token": "fake",
        "scope": "vault.owner",
    }
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# SyncHoldingsRequest.holdings -- max_length=1000
# ---------------------------------------------------------------------------


def test_sync_holdings_too_many_holdings_rejected(client: TestClient) -> None:
    """More than 1000 holdings must be rejected with 422."""
    holdings = [{"symbol": f"SYM{i}"} for i in range(_HOLDINGS_MAX + 1)]
    resp = client.post(
        f"/api/tickers/sync-holdings/{_UID}",
        json={"holdings": holdings},
    )
    assert resp.status_code == 422, resp.text


def test_sync_holdings_at_cap_accepted(client: TestClient) -> None:
    """Exactly 1000 holdings must be accepted (boundary)."""
    holdings = [{"symbol": f"SYM{i}"} for i in range(_HOLDINGS_MAX)]

    mock_service = MagicMock()
    mock_service.sync_holdings_symbols = AsyncMock(return_value={"synced": _HOLDINGS_MAX})

    with patch("api.routes.tickers.TickerDBService", return_value=mock_service):
        resp = client.post(
            f"/api/tickers/sync-holdings/{_UID}",
            json={"holdings": holdings},
        )

    assert resp.status_code != 422, f"Cap boundary rejected: {resp.status_code}"


# ---------------------------------------------------------------------------
# RIAConsentBundleCreate -- selected_scopes / selected_account_ids
# ---------------------------------------------------------------------------


def test_request_bundle_too_many_scopes_rejected(client: TestClient) -> None:
    """More than 50 selected_scopes must be rejected with 422."""
    scopes = [f"scope_{i}" for i in range(_SCOPES_MAX + 1)]
    resp = client.post(
        "/api/ria/request-bundles",
        json={
            "subject_user_id": _UID,
            "scope_template_id": "template-1",
            "selected_scopes": scopes,
        },
    )
    assert resp.status_code == 422, resp.text


def test_request_bundle_too_many_accounts_rejected(client: TestClient) -> None:
    """More than 100 selected_account_ids must be rejected with 422."""
    accounts = [f"acct_{i}" for i in range(_ACCOUNTS_MAX + 1)]
    resp = client.post(
        "/api/ria/request-bundles",
        json={
            "subject_user_id": _UID,
            "scope_template_id": "template-1",
            "selected_account_ids": accounts,
        },
    )
    assert resp.status_code == 422, resp.text


# ---------------------------------------------------------------------------
# RIAPicksParseRequest -- avoid_rows / screening_sections
# ---------------------------------------------------------------------------


def test_picks_parse_too_many_avoid_rows_rejected(client: TestClient) -> None:
    """More than 1000 avoid_rows must be rejected with 422."""
    rows = [{"ticker": f"T{i}"} for i in range(_AVOID_ROWS_MAX + 1)]
    resp = client.post(
        "/api/ria/picks/parse",
        json={"csv_content": "ticker,action\nAAPL,buy", "avoid_rows": rows},
    )
    assert resp.status_code == 422, resp.text


def test_picks_parse_too_many_screening_sections_rejected(client: TestClient) -> None:
    """More than 100 screening_sections must be rejected with 422."""
    sections = [{"name": f"s{i}"} for i in range(_SCREENING_MAX + 1)]
    resp = client.post(
        "/api/ria/picks/parse",
        json={"csv_content": "ticker,action\nAAPL,buy", "screening_sections": sections},
    )
    assert resp.status_code == 422, resp.text


# ---------------------------------------------------------------------------
# RIAPicksSyncRequest -- top_picks / avoid_rows / screening_sections
# ---------------------------------------------------------------------------


def test_picks_sync_too_many_top_picks_rejected(client: TestClient) -> None:
    """More than 5000 top_picks must be rejected with 422."""
    picks = [{"ticker": f"T{i}"} for i in range(_TOP_PICKS_MAX + 1)]
    resp = client.post(
        "/api/ria/picks",
        json={"top_picks": picks},
    )
    assert resp.status_code == 422, resp.text


# ---------------------------------------------------------------------------
# RIAInviteCreateRequest -- targets
# ---------------------------------------------------------------------------


def test_invite_too_many_targets_rejected(client: TestClient) -> None:
    """More than 200 invite targets must be rejected with 422."""
    targets = [{"email": f"user{i}@example.com"} for i in range(_TARGETS_MAX + 1)]
    resp = client.post(
        "/api/ria/invites",
        json={"scope_template_id": "template-1", "targets": targets},
    )
    assert resp.status_code == 422, resp.text


def test_invite_at_targets_cap_accepted(client: TestClient) -> None:
    """Exactly 200 targets must be accepted at the boundary."""
    targets = [{"email": f"user{i}@example.com"} for i in range(_TARGETS_MAX)]

    mock_service = MagicMock()
    mock_service.create_ria_invites = AsyncMock(return_value={"created": _TARGETS_MAX})

    with patch("api.routes.ria.RIAIAMService", return_value=mock_service):
        resp = client.post(
            "/api/ria/invites",
            json={"scope_template_id": "template-1", "targets": targets},
        )

    assert resp.status_code != 422, f"Boundary targets={_TARGETS_MAX} rejected: {resp.status_code}"
