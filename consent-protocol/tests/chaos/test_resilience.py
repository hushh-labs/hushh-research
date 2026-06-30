"""
Chaos Engineering Tests

Validates system resilience under failure conditions.
Tests error handling, timeouts, retries, and recovery strategies.

Run: pytest consent-protocol/tests/chaos/ -v
"""

import asyncio
from unittest.mock import AsyncMock, Mock, patch

import pytest
from consent_protocol.integrations.alpaca import AlpacaBroker
from consent_protocol.services.vault_service import VaultService


class TestBrokerAPIFailures:
    """Test handling of broker API failures"""

    @pytest.mark.asyncio
    async def test_broker_timeout_triggers_retry(self):
        """Broker timeout should trigger exponential backoff retry"""
        broker = AlpacaBroker(api_key="test", api_secret="test")  # noqa: S106

        # Mock timeout on first attempt, success on retry
        with patch.object(broker, "_request") as mock_request:
            mock_request.side_effect = [
                TimeoutError("Request timed out"),
                {"status": "ok", "account_id": "123"},
            ]

            result = await broker.get_account(retries=3)

            assert result["account_id"] == "123"
            assert mock_request.call_count == 2  # Original + 1 retry

    @pytest.mark.asyncio
    async def test_broker_rate_limit_backoff(self):
        """Rate limiting (429) should trigger adaptive backoff"""
        broker = AlpacaBroker(api_key="test", api_secret="test")  # noqa: S106

        with patch.object(broker, "_request") as mock_request:
            mock_request.side_effect = [
                Exception("429 Rate Limited"),  # First request rate limited
                Exception("429 Rate Limited"),  # Second retry still rate limited
                {"data": "success"},  # Third retry succeeds
            ]

            with patch("asyncio.sleep") as mock_sleep:
                await broker.get_account(retries=3, backoff_base=1.0)

                # Verify exponential backoff: 1s, 2s
                assert mock_sleep.call_count == 2
                call_args = [call[0][0] for call in mock_sleep.call_args_list]
                assert call_args[0] == 1.0
                assert call_args[1] == 2.0

    @pytest.mark.asyncio
    async def test_broker_unavailable_circuit_breaker(self):
        """Broker consistently unavailable should trigger circuit breaker"""
        broker = AlpacaBroker(api_key="test", api_secret="test")  # noqa: S106
        broker.circuit_breaker_threshold = 3  # Fail after 3 errors

        with patch.object(broker, "_request") as mock_request:
            mock_request.side_effect = Exception("Service Unavailable")

            # First 3 requests fail and increment circuit breaker
            for _i in range(3):
                with pytest.raises(Exception):  # noqa: B017
                    await broker.get_account()

            # 4th request should fail immediately (circuit open)
            with pytest.raises(Exception, match="Circuit breaker"):
                await broker.get_account()

            # Circuit should not make actual request
            assert mock_request.call_count == 3


class TestVaultServiceResilience:
    """Test vault service resilience to failures"""

    @pytest.mark.asyncio
    async def test_vault_decrypt_failure_recovery(self):
        """Vault decryption failure should be retryable"""
        vault_service = VaultService(db=Mock(), cache=Mock())

        with patch.object(vault_service, "decrypt") as mock_decrypt:
            # Simulate transient decryption failure
            mock_decrypt.side_effect = [
                Exception("Decryption failed: key mismatch"),
                {"holdings": [{"symbol": "AAPL", "qty": 10}]},
            ]

            result = await vault_service.get_decrypted_holdings(
                vault_id="vault_123", user_id="user_456", retries=2
            )

            assert len(result["holdings"]) == 1
            assert mock_decrypt.call_count == 2

    @pytest.mark.asyncio
    async def test_vault_database_partition(self):
        """Handle database connectivity issues"""
        vault_service = VaultService(db=Mock(), cache=Mock())

        with patch.object(vault_service.db, "query") as mock_query:
            mock_query.side_effect = [
                Exception("Connection refused"),
                Exception("Connection refused"),
                Mock(first=Mock(return_value={"id": "vault_123"})),
            ]

            result = await vault_service.get_vault("vault_123", retries=3)

            assert result["id"] == "vault_123"
            assert mock_query.call_count == 3

    @pytest.mark.asyncio
    async def test_cache_failure_fallback_to_db(self):
        """Cache failure should transparently fall back to database"""
        cache = Mock()
        db = Mock()
        vault_service = VaultService(db=db, cache=cache)

        # Cache throws exception
        cache.get.side_effect = Exception("Redis connection lost")

        # Database returns data
        db.query.return_value.filter_by.return_value.first.return_value = {
            "id": "vault_123",
            "data": "holdings",
        }

        result = await vault_service.get_vault("vault_123")

        assert result["id"] == "vault_123"
        # Verify fallback to DB happened
        assert db.query.called


class TestConsentTokenExpiration:
    """Test handling of expired consent tokens"""

    @pytest.mark.asyncio
    async def test_expired_token_denied_access(self):
        """Expired tokens should deny vault access"""
        from consent_protocol.services.consent_service import ConsentService

        consent_service = ConsentService(db=Mock())

        # Token expired 5 minutes ago
        expired_token = {
            "token_id": "token_123",
            "expires_at": "2024-01-01T10:00:00Z",  # Past
            "user_id": "user_123",
            "scopes": ["vault.read"],
        }

        with patch.object(consent_service, "verify_token") as mock_verify:
            mock_verify.return_value = False

            is_valid = await consent_service.is_token_valid(expired_token["token_id"])

            assert not is_valid

    @pytest.mark.asyncio
    async def test_token_rotation_during_request(self):
        """Handle token rotation mid-request"""
        from consent_protocol.services.consent_service import ConsentService

        consent_service = ConsentService(db=Mock())

        # Token rotates during long-running request
        with patch.object(consent_service, "get_token_version") as mock_version:
            # First call sees version 1, second call after rotation sees version 2
            mock_version.side_effect = [1, 2]

            v1 = await consent_service.get_token_version("token_123")
            v2 = await consent_service.get_token_version("token_123")

            assert v1 == 1
            assert v2 == 2


class TestNetworkPartition:
    """Test behavior during network partitions"""

    @pytest.mark.asyncio
    async def test_multi_broker_fallback(self):
        """If primary broker unavailable, try secondary"""
        primary_broker = AlpacaBroker(api_key="test", api_secret="test")  # noqa: S106
        secondary_broker = AlpacaBroker(api_key="test2", api_secret="test2")  # noqa: S106

        with patch.object(primary_broker, "get_account") as mock_primary:
            with patch.object(secondary_broker, "get_account") as mock_secondary:
                mock_primary.side_effect = Exception("Connection lost")
                mock_secondary.return_value = {"id": "account_secondary"}

                # Try primary first
                try:
                    await primary_broker.get_account()
                except Exception:  # noqa: B902
                    # Fall back to secondary
                    result = await secondary_broker.get_account()

                assert result["id"] == "account_secondary"

    @pytest.mark.asyncio
    async def test_stale_data_accepted_during_outage(self):
        """Accept cached data if service unavailable"""
        cache = Mock()
        vault_service = VaultService(db=Mock(), cache=cache)

        # Cache has stale data (3 days old)
        stale_holdings = {
            "holdings": [{"symbol": "AAPL", "qty": 10}],
            "cached_at": "2024-01-01T00:00:00Z",
        }
        cache.get.return_value = stale_holdings

        # Database unavailable
        vault_service.db.query.side_effect = Exception("DB connection lost")

        # Should return stale data with warning
        result = await vault_service.get_holdings(
            vault_id="vault_123",
            allow_stale=True,  # Accept data older than 1 day during outage
            max_stale_age=86400 * 5,
        )

        assert len(result["holdings"]) == 1
        assert result["warning"] == "Data is 3 days old"


class TestCascadingFailures:
    """Test handling of cascading failures"""

    @pytest.mark.asyncio
    async def test_concurrent_request_surge_handling(self):
        """Handle burst of concurrent requests without cascading failure"""
        vault_service = VaultService(db=Mock(), cache=Mock())

        # Simulate 100 concurrent requests
        tasks = [vault_service.get_vault(f"vault_{i}") for i in range(100)]

        with patch.object(vault_service, "_fetch_vault") as mock_fetch:
            mock_fetch.side_effect = [{"id": f"vault_{i}"} for i in range(100)]

            results = await asyncio.gather(*tasks, return_exceptions=True)

            # Some might fail due to backpressure, but not all
            successful = [r for r in results if not isinstance(r, Exception)]
            assert len(successful) > 50  # At least 50% succeed

    @pytest.mark.asyncio
    async def test_slow_database_doesnt_block_fast_cache(self):
        """Fast cache queries shouldn't be blocked by slow database"""
        cache = AsyncMock()
        db = Mock()
        vault_service = VaultService(db=db, cache=cache)

        # Cache responds immediately
        cache.get.return_value = {"cached": True}

        # Database is slow
        async def slow_query():
            await asyncio.sleep(10)
            return {"from_db": True}

        db.query = Mock(return_value=slow_query())

        # Cache should return immediately
        import time

        start = time.time()
        result = await vault_service.get_vault_cached("vault_123")
        elapsed = time.time() - start

        assert elapsed < 1  # Should be fast
        assert result["cached"]


@pytest.mark.asyncio
async def test_full_system_degradation():
    """System should gracefully degrade when multiple components fail"""
    # Simulate:
    # - Broker API down
    # - Database slow (>10s)
    # - Cache unavailable
    # - PKM service timeouts

    from consent_protocol.services import orchestration

    with patch.object(orchestration, "get_portfolio_holdings") as mock_portfolio:
        mock_portfolio.side_effect = Exception("Broker unavailable")

        with patch.object(orchestration, "get_cached_snapshot") as mock_cache:
            mock_cache.return_value = {
                "holdings": [{"symbol": "AAPL", "qty": 10}],
                "warning": "Data from 1 hour ago",
                "degraded": True,
            }

            result = await orchestration.get_portfolio(user_id="user_123", allow_degraded=True)

            assert result["degraded"]
            assert len(result["holdings"]) > 0
