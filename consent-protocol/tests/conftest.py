# tests/conftest.py
"""
BYOK-Compliant Test Fixtures
============================

This module provides shared fixtures for testing that comply with the
BYOK (Bring Your Own Key) security model.

CRITICAL PRINCIPLES:
1. NEVER use production encryption keys in tests
2. All test keys should be dynamically generated
3. Tests should not depend on environment variables for keys
4. Each test should have isolated key material

Usage:
    def test_encryption(test_vault_key):
        encrypted = encrypt_data(data, test_vault_key)
        assert decrypt_data(encrypted, test_vault_key) == data
"""

import os

import pytest

# ============================================================================
# BYOK Key Fixtures
# ============================================================================


@pytest.fixture
def test_vault_key() -> str:
    """
    Generate a random vault key for testing (BYOK-compliant).

    Returns a 64-character hex string (32 bytes = 256 bits).
    This key is generated fresh for each test and is NOT persisted.

    Usage:
        def test_encryption(test_vault_key):
            encrypted = encrypt_data(plaintext, test_vault_key)
    """
    return os.urandom(32).hex()


@pytest.fixture
def test_vault_key_bytes() -> bytes:
    """
    Generate a random vault key as bytes for testing.

    Returns 32 bytes (256 bits) for use with cryptography libraries.
    """
    return os.urandom(32)


@pytest.fixture
def test_passphrase() -> str:
    """
    Generate a random passphrase for key derivation tests.
    """
    return f"test_passphrase_{os.urandom(8).hex()}"


@pytest.fixture
def test_salt() -> bytes:
    """
    Generate a random salt for key derivation tests.
    """
    return os.urandom(16)


# ============================================================================
# Consent Token Fixtures
# ============================================================================


@pytest.fixture
def mock_consent_token(test_vault_key: str) -> str:
    """
    Generate a valid mock consent token for testing.

    Uses the test SECRET_KEY environment variable to issue a real token
    that will pass validation in the test environment.
    """
    from hushh_mcp.consent.token import issue_token
    from hushh_mcp.constants import ConsentScope

    return issue_token(
        user_id="test_user_123",
        agent_id="test_agent",
        scope=ConsentScope.VAULT_OWNER,
    ).token


@pytest.fixture
def mock_vault_owner_token() -> str:
    """
    Generate a VAULT_OWNER consent token for testing.
    """
    from hushh_mcp.consent.token import issue_token
    from hushh_mcp.constants import ConsentScope

    return issue_token(
        user_id="test_user_123",
        agent_id="test_agent",
        scope=ConsentScope.VAULT_OWNER,
    ).token


@pytest.fixture
def vault_owner_token_for_user():
    """
    Factory fixture for issuing deterministic VAULT_OWNER bearer tokens in tests.
    """
    from hushh_mcp.consent.token import issue_token
    from hushh_mcp.constants import ConsentScope

    def _issue(user_id: str = "test_user_123", agent_id: str = "test_agent") -> str:
        return issue_token(
            user_id=user_id,
            agent_id=agent_id,
            scope=ConsentScope.VAULT_OWNER,
        ).token

    return _issue


@pytest.fixture
def vault_owner_auth_headers(vault_owner_token_for_user):
    """
    Factory fixture for Authorization headers using VAULT_OWNER tokens.
    """

    def _headers(user_id: str = "test_user_123", agent_id: str = "test_agent") -> dict[str, str]:
        token = vault_owner_token_for_user(user_id=user_id, agent_id=agent_id)
        return {"Authorization": f"Bearer {token}"}

    return _headers


@pytest.fixture
def mock_read_food_token() -> str:
    """
    Generate an attr.food.* consent token for testing.
    """
    from hushh_mcp.consent.scope_helpers import resolve_scope_to_enum
    from hushh_mcp.consent.token import issue_token

    return issue_token(
        user_id="test_user_123", agent_id="food_agent", scope=resolve_scope_to_enum("attr.food.*")
    )


# ============================================================================
# Test User Fixtures
# ============================================================================


@pytest.fixture
def test_user_id() -> str:
    """
    Generate a unique test user ID.
    """
    return f"test_user_{os.urandom(4).hex()}"


@pytest.fixture
def test_agent_id() -> str:
    """
    Generate a unique test agent ID.
    """
    return f"test_agent_{os.urandom(4).hex()}"


# ============================================================================
# Environment Isolation Fixtures
# ============================================================================


@pytest.fixture(autouse=True)
def isolate_test_environment(monkeypatch):
    """
    Ensure tests don't accidentally use production secrets.

    This fixture runs automatically for ALL tests in this directory.
    It sets test-specific environment variables and clears production ones.
    """
    # Set test-specific SECRET_KEY for token generation
    monkeypatch.setenv("SECRET_KEY", "test_secret_key_for_testing_only_do_not_use_in_production")

    # Clear any production VAULT_ENCRYPTION_KEY to force tests to use fixtures
    # This prevents accidental use of production keys
    monkeypatch.delenv("VAULT_ENCRYPTION_KEY", raising=False)

    # Set testing mode flag
    monkeypatch.setenv("TESTING", "true")


@pytest.fixture
def mock_db_pool():
    """
    Mock database pool for testing without real database connections.
    """
    from unittest.mock import AsyncMock, MagicMock

    mock_pool = MagicMock()
    mock_pool.fetch = AsyncMock(return_value=[])
    mock_pool.fetchrow = AsyncMock(return_value=None)
    mock_pool.execute = AsyncMock(return_value="INSERT 1")
    mock_pool.fetchval = AsyncMock(return_value=None)

    return mock_pool


# ============================================================================
# Encrypted Data Fixtures
# ============================================================================


@pytest.fixture
def sample_encrypted_payload(test_vault_key: str) -> dict:
    """
    Generate a sample encrypted payload for testing.
    """
    from hushh_mcp.vault.encrypt import encrypt_data

    test_data = '{"dietary_restrictions": "vegetarian", "allergies": ["nuts"]}'
    return encrypt_data(test_data, test_vault_key)


@pytest.fixture
def sample_plaintext_data() -> dict:
    """
    Sample plaintext data for encryption tests.
    """
    return {"email": "test@hushh.ai", "preferences": {"category": "food", "frequency": "weekly"}}


# ============================================================================
# TrustLink Fixtures
# ============================================================================


@pytest.fixture
def mock_trust_link(test_user_id: str) -> dict:
    """
    Generate a mock TrustLink for A2A testing.

    Uses ConsentScope.PKM_READ as the trust scope. TrustLinks operate at the
    enum level (coarse-grained permission); fine-grained domain isolation
    (attr.food.*, attr.financial.*) is enforced separately at the consent
    token layer, not at the trust link layer.
    """
    from hushh_mcp.constants import ConsentScope
    from hushh_mcp.trust.link import create_trust_link

    return create_trust_link(
        from_agent="orchestrator",
        to_agent="food_agent",
        scope=ConsentScope.PKM_READ,
        signed_by_user=test_user_id,
    )


# ============================================================================
# Async Test Support
# ============================================================================


@pytest.fixture
def event_loop():
    """
    Create an event loop for async tests.
    """
    import asyncio

    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


# ============================================================================
# Test Data Cleanup
# ============================================================================


@pytest.fixture(autouse=True)
def cleanup_revoked_tokens():
    """
    Clear revoked tokens between tests to ensure isolation.
    """
    yield
    # Cleanup after test
    try:
        from hushh_mcp.consent.token import _revoked_tokens

        _revoked_tokens.clear()
    except ImportError:
        pass  # Module not available in all test contexts
