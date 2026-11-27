"""Profile and finance Plaid vault route contracts."""

import pytest

from tests.test_plaid_vault_routes import (
    _ACCESS_TOKEN,
    _BASE,
    _FakePlaid,
    _item,
    _plaid_error,
    _use,
)
from tests.test_plaid_vault_routes import (
    app as app,
)
from tests.test_plaid_vault_routes import (
    authed_client as authed_client,
)


@pytest.mark.parametrize("origin", ["profile_nws", "agentone_chat"])
def test_finance_link_requests_only_score_products(authed_client, monkeypatch, origin):
    monkeypatch.setenv("PLAID_NWS_LIABILITIES_ENABLED", "true")
    monkeypatch.setenv("PLAID_REQUIRED_IF_SUPPORTED_PRODUCTS", "investments,auth")
    monkeypatch.setenv("PLAID_ADDITIONAL_CONSENTED_PRODUCTS", "identity")
    fake = _use(
        monkeypatch,
        _FakePlaid({"/link/token/create": [{"link_token": "link-test", "expiration": "x"}]}),
    )

    response = authed_client.post(
        f"{_BASE}/link-token",
        json={"platform": "web", "origin_surface": origin},
    )

    assert response.status_code == 200
    _, payload = fake.calls[0]
    assert payload["products"] == ["transactions"]
    assert payload["required_if_supported_products"] == ["investments", "liabilities"]
    assert "additional_consented_products" not in payload
    assert payload["transactions"] == {"days_requested": 730}
    assert payload["client_name"] == "AgentOne"


def test_snapshot_continuation_returns_mutation_for_original_cursor_restart(
    authed_client, monkeypatch
):
    fake = _use(
        monkeypatch,
        _FakePlaid(
            {
                "/item/get": [_item(["transactions"])],
                "/accounts/get": [{"accounts": []}],
                "/transactions/sync": [
                    _plaid_error(
                        "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", "TRANSACTIONS_ERROR"
                    ),
                ],
            }
        ),
    )

    response = authed_client.post(
        f"{_BASE}/snapshot",
        json={
            "access_token": _ACCESS_TOKEN,
            "transactions_cursor": "c2",
            "transactions_continuation": True,
        },
    )

    assert response.json()["transactions"] == {
        "unavailable": "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
    }
    assert [body["cursor"] for path, body in fake.calls if path == "/transactions/sync"] == ["c2"]
