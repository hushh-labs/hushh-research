from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.one.wallet_card_access import router

ROOT = "/api/one/wallet/card-access"
ID = "11111111-1111-4111-8111-111111111111"


def client(owner="owner"):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_firebase_auth] = lambda: "owner"
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": owner}
    return TestClient(app)


def test_card_owner_mismatch_is_private_and_does_not_call_service():
    with patch("api.routes.one.wallet_card_access.service") as service:
        response = client("other").get(ROOT + "/cards/card_one")
        assert response.status_code == 403
        assert response.headers["cache-control"] == "private, no-store"
        service.assert_not_called()


def test_rejects_credentials_invalid_duration_and_unbounded_body():
    with patch("api.routes.one.wallet_card_access.service") as service:
        for extra in [{"pan": "4242424242424242"}, {"durationMinutes": 60}]:
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


def test_recipient_view_needs_no_owner_vault_token_and_errors_are_private():
    service = MagicMock()
    service.view_grant.side_effect = RuntimeError("internal secret")
    with patch("api.routes.one.wallet_card_access.service", return_value=service):
        response = client("unrelated").get(ROOT + "/grants/" + ID)
        service.view_grant.assert_called_once_with("owner", ID)
        assert response.status_code == 503
        assert "internal secret" not in response.text
        assert response.headers["cache-control"] == "private, no-store"
