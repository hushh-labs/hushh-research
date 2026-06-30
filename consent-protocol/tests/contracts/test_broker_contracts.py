"""
API Contract Tests for Broker Integrations

Uses Pact for consumer-driven contract testing.
Ensures broker APIs (Alpaca, Plaid, etc.) maintain compatibility.

Run: pytest tests/contracts/ -v
"""

import pytest
import requests
from pact import Consumer, Provider

# Setup Pact
pact = Consumer("hushh-research").has_pact_with(
    Provider("alpaca-broker"),
    port=8081,
    pact_dir="tests/contracts/pacts",
)


class TestAlpacaBrokerContract:
    """Contract tests for Alpaca broker integration"""

    def test_get_account(self) -> None:
        """Pact: GET /v2/account - Alpaca returns account details"""

        (
            pact.upon_receiving("a request to get account details")
            .with_request("GET", "/v2/account", headers={"Authorization": "Bearer token"})
            .will_respond_with(
                200,
                body={
                    "id": "account_id_123",
                    "account_number": "ABC123",
                    "status": "ACTIVE",
                    "equity": "100000.00",
                    "cash": "50000.00",
                    "buying_power": "200000.00",
                    "created_at": "2023-01-01T00:00:00Z",
                },
            )
        )

        with pact:
            response = requests.get(
                "http://localhost:8081/v2/account",
                headers={"Authorization": "Bearer token"},
                timeout=10,
            )

            assert response.status_code == 200
            assert response.json()["status"] == "ACTIVE"
            assert float(response.json()["equity"]) > 0

    def test_get_positions(self) -> None:
        """Pact: GET /v2/positions - Alpaca returns open positions"""

        (
            pact.upon_receiving("a request to get positions")
            .with_request("GET", "/v2/positions", headers={"Authorization": "Bearer token"})
            .will_respond_with(
                200,
                body=[
                    {
                        "symbol": "AAPL",
                        "qty": "10",
                        "avg_fill_price": "150.00",
                        "market_value": "1600.00",
                        "unrealized_gain": "100.00",
                    },
                    {
                        "symbol": "MSFT",
                        "qty": "5",
                        "avg_fill_price": "300.00",
                        "market_value": "1625.00",
                        "unrealized_gain": "25.00",
                    },
                ],
            )
        )

        with pact:
            response = requests.get(
                "http://localhost:8081/v2/positions",
                headers={"Authorization": "Bearer token"},
                timeout=10,
            )

            assert response.status_code == 200
            assert len(response.json()) == 2
            assert response.json()[0]["symbol"] == "AAPL"

    def test_post_order(self) -> None:
        """Pact: POST /v2/orders - Alpaca creates new order"""

        (
            pact.upon_receiving("a request to create an order")
            .with_request(
                "POST",
                "/v2/orders",
                body={
                    "symbol": "AAPL",
                    "qty": "10",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                },
                headers={"Authorization": "Bearer token"},
            )
            .will_respond_with(
                201,
                body={
                    "id": "order_123",
                    "symbol": "AAPL",
                    "qty": "10",
                    "side": "buy",
                    "type": "market",
                    "status": "pending_new",
                    "created_at": "2023-12-01T10:00:00Z",
                },
            )
        )

        with pact:
            response = requests.post(
                "http://localhost:8081/v2/orders",
                json={
                    "symbol": "AAPL",
                    "qty": "10",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                },
                headers={"Authorization": "Bearer token"},
                timeout=10,
            )

            assert response.status_code == 201
            assert response.json()["status"] == "pending_new"

    def test_error_handling_invalid_symbol(self) -> None:
        """Pact: GET /v2/positions - Error handling for invalid requests"""

        (
            pact.upon_receiving("a request with invalid symbol")
            .with_request("GET", "/v2/positions?symbol=INVALID")
            .will_respond_with(
                400,
                body={
                    "code": 40010000,
                    "message": "Invalid symbol: INVALID",
                },
            )
        )

        with pact:
            response = requests.get("http://localhost:8081/v2/positions?symbol=INVALID", timeout=10)

            assert response.status_code == 400
            assert "Invalid symbol" in response.json()["message"]


class TestPlaidBrokerContract:
    """Contract tests for Plaid integration"""

    def test_link_token_creation(self) -> None:
        """Pact: POST /link/token/create - Plaid creates link token"""

        (
            pact.upon_receiving("a request to create link token")
            .with_request(
                "POST",
                "/link/token/create",
                body={
                    "client_id": "client_123",
                    "secret": "secret_123",
                    "user": {"client_user_id": "user_123"},
                    "client_name": "Kai",
                    "language": "en",
                    "products": ["auth", "transactions"],
                    "country_codes": ["US"],
                },
            )
            .will_respond_with(
                200,
                body={
                    "link_token": "link_123abc",
                    "expiration": "2024-01-01T00:00:00Z",
                },
            )
        )

        with pact:
            response = requests.post(
                "http://localhost:8081/link/token/create",
                json={
                    "client_id": "client_123",
                    "secret": "secret_123",
                    "user": {"client_user_id": "user_123"},
                    "client_name": "Kai",
                    "language": "en",
                    "products": ["auth", "transactions"],
                    "country_codes": ["US"],
                },
                timeout=10,
            )

            assert response.status_code == 200
            assert "link_token" in response.json()

    def test_exchange_public_token(self) -> None:
        """Pact: POST /item/public_token/exchange - Exchange public token"""

        (
            pact.upon_receiving("a request to exchange public token")
            .with_request(
                "POST",
                "/item/public_token/exchange",
                body={
                    "client_id": "client_123",
                    "secret": "secret_123",
                    "public_token": "public_token_xyz",
                },
            )
            .will_respond_with(
                200,
                body={
                    "access_token": "access_token_abc",
                    "item_id": "item_123",
                },
            )
        )

        with pact:
            response = requests.post(
                "http://localhost:8081/item/public_token/exchange",
                json={
                    "client_id": "client_123",
                    "secret": "secret_123",
                    "public_token": "public_token_xyz",
                },
                timeout=10,
            )

            assert response.status_code == 200
            assert "access_token" in response.json()


class TestBrokerIntegrationErrors:
    """Tests for error scenarios and edge cases"""

    def test_authentication_failure(self) -> None:
        """Test handling of authentication errors"""
        (
            pact.upon_receiving("a request with invalid credentials")
            .with_request("GET", "/v2/account", headers={"Authorization": "Bearer invalid"})
            .will_respond_with(
                401,
                body={
                    "code": 40110000,
                    "message": "Unauthorized",
                },
            )
        )

        with pact:
            response = requests.get(
                "http://localhost:8081/v2/account",
                headers={"Authorization": "Bearer invalid"},
                timeout=10,
            )
            assert response.status_code == 401

    def test_rate_limiting(self) -> None:
        """Test handling of rate limit errors"""
        (
            pact.upon_receiving("multiple rapid requests exceeding rate limit")
            .with_request("GET", "/v2/orders")
            .will_respond_with(
                429,
                body={"message": "Rate limit exceeded. Please retry after 60 seconds."},
                headers={"Retry-After": "60"},
            )
        )

        with pact:
            response = requests.get("http://localhost:8081/v2/orders", timeout=10)
            assert response.status_code == 429
            assert "Retry-After" in response.headers

    def test_server_error(self) -> None:
        """Test handling of server errors"""
        (
            pact.upon_receiving("a request when broker API is down")
            .with_request("GET", "/v2/account")
            .will_respond_with(
                503,
                body={"message": "Service temporarily unavailable"},
            )
        )

        with pact:
            response = requests.get("http://localhost:8081/v2/account", timeout=10)
            assert response.status_code == 503


class TestHushhAPIConsumer:
    """Tests from Hushh API perspective consuming broker APIs"""

    def test_sync_account_holdings(self) -> None:
        """Integration test: Sync account holdings from Alpaca"""
        from consent_protocol.integrations.alpaca import AlpacaBroker  # type: ignore[import]

        broker = AlpacaBroker(api_key="test_key", api_secret="test_secret")  # noqa: S106

        with pact:
            holdings = broker.get_holdings()

            assert len(holdings) > 0
            assert all("symbol" in h for h in holdings)
            assert all("qty" in h for h in holdings)

    def test_execute_trade_with_retry(self) -> None:
        """Test trade execution with retry logic"""
        from consent_protocol.integrations.alpaca import AlpacaBroker  # type: ignore[import]

        broker = AlpacaBroker(api_key="test_key", api_secret="test_secret")  # noqa: S106

        with pact:
            order = broker.create_order(
                symbol="AAPL",
                qty=10,
                side="buy",
                retry_count=3,
            )

            assert order["id"]
            assert order["status"] in ["pending_new", "accepted"]


# Pact verification
@pytest.fixture(scope="session")
def pact_verification() -> None:
    """Verify pacts after all tests"""
    pact.verify()
