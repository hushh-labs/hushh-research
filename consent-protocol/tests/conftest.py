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

from hushh_mcp.runtime_settings import clear_runtime_settings_caches

os.environ.setdefault("TESTING", "true")
os.environ.setdefault("APP_SIGNING_KEY", "test_secret_key_for_pytest_only_32chars_min")
os.environ.setdefault(
    "VAULT_DATA_KEY",
    "0000000000000000000000000000000000000000000000000000000000000000",
)


#: The value before any test module is imported. See the fixture below.
_POD_MODE_AT_IMPORT = os.environ.get("HUSSH_POD_MODE")


@pytest.fixture(autouse=True)
def restore_pod_process_state_after_every_test():
    """Pod-shaped process state must not survive the test that set it.

    `pod_server.py` asserts pod mode at IMPORT time, before importing app code
    that reads it, which is correct for a pod and wrong inside one pytest
    process: the first test that imports the pod application, directly or
    through any transitive import, flips a global runtime switch for every
    test that runs after it. `pod_mode()` reads the environment on each call
    and never caches, so the effect is immediate and total.

    Measured: running `tests/test_pod_lifecycle_log.py` before
    `tests/test_one_adk_agent_tree.py` left `HUSSH_POD_MODE='1'` set, which
    sent `validate_a2a_consent_token_with_db` down its pod branch, so every
    specialist dispatch answered `scope_required` and thirteen tests failed.
    Each file passed alone. The pair reproduced it in eight seconds.

    Production behaviour is untouched: the image sets the variable itself
    (`Dockerfile.pod`), and the import-time assertion stays for a pod started
    outside the image.
    """
    import os

    # Restore to the value this conftest saw when it was imported, NOT to the
    # value at the start of each test. Collection imports every test module
    # before any test runs, so a module that pulls in the pod application has
    # already set the variable by the time the first test starts. Snapshotting
    # per test would therefore adopt the leak as the baseline and preserve it
    # for the whole session, which is exactly what a first attempt at this
    # fixture did.
    try:
        yield
    finally:
        if _POD_MODE_AT_IMPORT is None:
            os.environ.pop("HUSSH_POD_MODE", None)
        else:
            os.environ["HUSSH_POD_MODE"] = _POD_MODE_AT_IMPORT
        # The sealed pod configuration is cached in a process-wide slot with a
        # setter and no reset, so a test that installs one hands it to every
        # test that follows. Measured: a config left behind by
        # tests/test_pod_live_authority.py made the ingress wall answer 404 for
        # the app surface in tests/test_pod_server.py, which passed alone.
        # Clearing returns the documented default rather than a remembered one.
        from hushh_mcp.services.pod_config import set_active_pod_config

        set_active_pod_config(None)


@pytest.fixture(autouse=True)
def isolate_runtime_env(monkeypatch: pytest.MonkeyPatch):
    # Local import: hushh_mcp.config resolves APP_SIGNING_KEY at import time,
    # so importing this at module level (before the setdefault calls above
    # run) breaks collection in any environment without a real .env -- e.g. a
    # clean checkout with no dev secrets on disk.
    from hushh_mcp.services.google_maps_service import clear_places_cache

    clear_runtime_settings_caches()
    clear_places_cache()
    monkeypatch.setenv("TESTING", "true")
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_pytest_only_32chars_min")
    monkeypatch.setenv(
        "VAULT_DATA_KEY",
        "0000000000000000000000000000000000000000000000000000000000000000",
    )
    for key in (
        "FIREBASE_ADMIN_CREDENTIALS_JSON",
        "APP_FRONTEND_ORIGIN",
        "VOICE_RUNTIME_CONFIG_JSON",
        "BACKEND_RUNTIME_CONFIG_JSON",
    ):
        monkeypatch.delenv(key, raising=False)
    yield
    clear_runtime_settings_caches()
    clear_places_cache()


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

    Uses the test APP_SIGNING_KEY environment variable to issue a real token
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
    # Keep the canonical runtime keys available for tests that resolve the
    # typed settings layer directly.
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_pytest_only_32chars_min")
    monkeypatch.setenv(
        "VAULT_DATA_KEY",
        "0000000000000000000000000000000000000000000000000000000000000000",
    )
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
    """
    from hushh_mcp.trust.link import create_trust_link

    return create_trust_link(
        from_agent="orchestrator",
        to_agent="food_agent",
        scope="attr.food.*",
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
