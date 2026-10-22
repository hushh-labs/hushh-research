from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.one.wallet_card_access import router
from hushh_mcp.services.wallet_card_validation import NETWORK_ORDER

ROOT = "/api/one/wallet/card-access"
ID = "11111111-1111-4111-8111-111111111111"


def client(owner="owner"):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_firebase_auth] = lambda: "owner"
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": owner}
    return TestClient(app)


@pytest.mark.parametrize(
    "path",
    [
        "/cards/card_one",
        "/connections",
        "/profile",
        "/history",
        "/history/" + ID,
        "/requests/" + ID,
    ],
)
def test_card_owner_mismatch_is_private_and_does_not_call_service(path):
    with patch("api.routes.one.wallet_card_access.service") as service:
        response = client("other").get(ROOT + path)
        assert response.status_code == 403
        assert response.headers["cache-control"] == "private, no-store"
        service.assert_not_called()


def test_rejects_credentials_invalid_duration_and_unbounded_body():
    with patch("api.routes.one.wallet_card_access.service") as service:
        for extra in [{"pan": "4242424242424242"}, {"durationMinutes": 180}]:
            response = client().post(
                ROOT + "/cards/card_one/grants",
                json={"requestId": ID, "recipientPersonRefs": [ID], "durationMinutes": 10, **extra},
            )
            assert response.status_code == 422
            assert "4242424242424242" not in response.text
            assert response.headers["cache-control"] == "private, no-store"
        response = client().post(ROOT + "/registrations", content="x" * 16385)
        assert response.status_code == 413
        service.assert_not_called()


def test_share_uses_authenticated_owner_and_explicit_recipients():
    service = MagicMock()
    service.create_grants.return_value = {"grants": []}
    with patch("api.routes.one.wallet_card_access.service", return_value=service):
        response = client().post(
            ROOT + "/cards/card_one/grants",
            json={"requestId": ID, "recipientPersonRefs": [ID], "durationMinutes": 10},
        )
        assert response.status_code == 200
        service.create_grants.assert_called_once_with("owner", "card_one", ID, [ID], 10)


def test_card_requests_and_responses_keep_owner_auth_and_reject_secret_fields():
    service = MagicMock()
    service.create.return_value = {"id": ID}
    with patch("api.routes.one.wallet_card_access.card_request_service", return_value=service):
        response = client("other").post(ROOT + "/requests", json={"requestId": ID, "personRef": ID})
        assert response.status_code == 403
        service.create.assert_not_called()
        response = client().post(
            ROOT + "/requests", json={"requestId": ID, "personRef": ID, "pan": "4242424242424242"}
        )
        assert response.status_code == 422 and "4242424242424242" not in response.text
        response = client().post(ROOT + "/requests", json={"requestId": ID, "personRef": ID})
        assert response.status_code == 200
        service.create.assert_called_once_with("owner", ID, ID)
    service = MagicMock()
    service.create_grants.return_value = {"grants": []}
    with patch("api.routes.one.wallet_card_access.service", return_value=service):
        response = client().post(
            ROOT + "/cards/card_one/grants",
            json={
                "requestId": ID,
                "recipientPersonRefs": [ID],
                "durationMinutes": 15,
                "cardRequestId": ID,
            },
        )
        assert response.status_code == 200
        service.create_grants.assert_called_once_with(
            "owner", "card_one", ID, [ID], 15, card_request_id=ID
        )


@pytest.mark.parametrize("minutes", [15, 60, 120])
def test_recipient_envelopes_are_forwarded_with_owner_authority(minutes):
    service = MagicMock()
    service.create_grants.return_value = {"grants": []}
    with patch("api.routes.one.wallet_card_access.service", return_value=service):
        response = client().post(
            ROOT + "/cards/card_one/grants",
            json={
                "requestId": ID,
                "recipientPersonRefs": [ID],
                "durationMinutes": minutes,
                "encryptedCards": {ID: "opaque-recipient-envelope"},
            },
        )
        assert response.status_code == 200
        service.create_grants.assert_called_once_with(
            "owner",
            "card_one",
            ID,
            [ID],
            minutes,
            encrypted_cards={ID: "opaque-recipient-envelope"},
        )


def test_recipient_view_needs_no_owner_vault_token_and_errors_are_private():
    service = MagicMock()
    service.view_grant.side_effect = RuntimeError("internal secret")
    with patch("api.routes.one.wallet_card_access.service", return_value=service):
        response = client("unrelated").get(ROOT + "/grants/" + ID)
        service.view_grant.assert_called_once_with("owner", ID)
        assert response.status_code == 503
        assert "internal secret" not in response.text
        assert response.headers["cache-control"] == "private, no-store"


@pytest.mark.parametrize("suffix", ["/networks", "/networks/resolve"])
def test_network_requests_require_matching_owner_identity(suffix):
    with patch("api.routes.one.wallet_card_access.service") as service:
        response = (
            client("other").get(ROOT + suffix)
            if suffix == "/networks"
            else client("other").post(ROOT + suffix, json={"iinPrefix": "411111", "panLength": 16})
        )
        assert response.status_code == 403
        assert response.headers["cache-control"] == "private, no-store"
        service.assert_not_called()


@pytest.mark.parametrize("selected_network", [None, *NETWORK_ORDER])
def test_network_contract_is_available_without_sharing_keys(selected_network):
    body = {"iinPrefix": "411111", "panLength": 16}
    if selected_network:
        body["selectedNetwork"] = selected_network
    response = client().post(ROOT + "/networks/resolve", json=body)
    assert response.status_code == 200
    assert response.json()["network"] == (selected_network or "visa")
    assert response.json()["source"] == ("owner_selected" if selected_network else "prefix")
    assert response.json()["candidates"] == []
    assert response.headers["cache-control"] == "private, no-store"
    assert client().get(ROOT + "/networks").json()["networks"] == list(NETWORK_ORDER)


def test_twelve_digit_other_metadata_is_accepted_without_full_pan():
    response = client().post(
        ROOT + "/networks/resolve",
        json={"iinPrefix": "911111", "panLength": 12, "selectedNetwork": "other"},
    )
    assert response.status_code == 200
    assert response.json()["network"] == "other"
    assert response.json()["source"] == "owner_selected"
    assert response.headers["cache-control"] == "private, no-store"


@pytest.mark.parametrize(
    "body",
    [
        {"iinPrefix": "4111111111111111", "panLength": 16},
        {"iinPrefix": "411111", "panLength": "16"},
        {"iinPrefix": "411111", "panLength": True},
        {"iinPrefix": "911111", "panLength": 11},
        {"iinPrefix": "411111", "panLength": 16, "pan": "4111111111111111"},
        {"iinPrefix": "411111", "panLength": 16, "cvv": "123"},
    ],
)
def test_network_endpoint_never_echoes_bad_input(body):
    response = client().post(ROOT + "/networks/resolve", json=body)
    assert response.status_code == 422
    assert response.json() == {"detail": {"code": "WALLET_CARD_REQUEST_INVALID"}}
    assert response.headers["cache-control"] == "private, no-store"


def test_history_cursor_is_forwarded_with_owner_authority():
    service = MagicMock()
    service.card_access.return_value = {
        "eligible": True,
        "grants": [],
        "nextCursor": None,
        "hasMore": False,
    }
    with patch("api.routes.one.wallet_card_access.service", return_value=service):
        response = client().get(ROOT + "/cards/card_one", params={"cursor": ID})
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
        service.card_access.assert_called_once_with("owner", "card_one", ID)


def test_malformed_history_cursor_is_private_and_not_forwarded():
    with patch("api.routes.one.wallet_card_access.service") as service:
        response = client().get(ROOT + "/cards/card_one?cursor=not-a-uuid")
        assert response.status_code == 422
        assert response.headers["cache-control"] == "private, no-store"
        service.assert_not_called()


def test_unified_history_filters_and_bounds_use_owner_authority():
    service = MagicMock()
    service.history.return_value = {
        "items": [],
        "hasMore": False,
        "nextCursor": None,
        "serverNow": "2026-10-12T10:00:00Z",
    }
    with patch("api.routes.one.wallet_card_access.service", return_value=service):
        response = client().get(
            ROOT + "/history",
            params={
                "direction": "received",
                "cardType": "profile",
                "limit": 5,
                "cursor": "profile:" + ID,
            },
        )
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
        service.history.assert_called_once_with(
            "owner", direction="received", card_type="profile", cursor="profile:" + ID, limit=5
        )
        service.reset_mock()
        for params in (
            {"limit": 101},
            {"limit": 0},
            {"direction": "other"},
            {"cardType": "system"},
            {"cursor": "x" * 61},
        ):
            assert client().get(ROOT + "/history", params=params).status_code == 422
        service.history.assert_not_called()


def test_history_failure_does_not_disclose_internal_information():
    service = MagicMock()
    service.history.side_effect = RuntimeError("internal credential")
    with patch("api.routes.one.wallet_card_access.service", return_value=service):
        response = client().get(ROOT + "/history")
        assert response.status_code == 503
        assert "internal credential" not in response.text
        assert response.headers["cache-control"] == "private, no-store"
