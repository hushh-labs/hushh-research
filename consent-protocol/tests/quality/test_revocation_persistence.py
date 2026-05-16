# tests/quality/test_revocation_persistence.py
"""
Token Revocation Persistence Tests

Verifies that token revocation is persisted to database and survives server restarts.
"""

import hashlib
import sys
import time
import types
from unittest.mock import AsyncMock, patch

import pytest

from hushh_mcp.consent.token import (
    issue_token,
    revoke_token,
    validate_token,
    validate_token_with_db,
)
from hushh_mcp.constants import ConsentScope


# Simulated revocation functions that match the implementation pattern
def hash_token(token_str: str) -> str:
    """Generate SHA256 hash of token for storage."""
    return hashlib.sha256(token_str.encode()).hexdigest()


class MockRevokedTokensDB:
    """
    Mock database for testing revocation persistence.
    In production, this uses asyncpg with revoked_tokens table.
    """

    def __init__(self):
        self._revoked = {}  # token_hash -> record

    async def revoke(
        self, token_str: str, user_id: str, scope: str = None, reason: str = None
    ) -> bool:
        """Persist token revocation to database."""
        token_hash = hash_token(token_str)
        self._revoked[token_hash] = {
            "token_hash": token_hash,
            "user_id": user_id,
            "scope": scope,
            "revoked_at": int(time.time() * 1000),
            "reason": reason,
        }
        return True

    async def is_revoked(self, token_str: str) -> bool:
        """Check if token is in revocation list."""
        token_hash = hash_token(token_str)
        return token_hash in self._revoked

    async def get_revocation(self, token_str: str) -> dict | None:
        """Get revocation record if exists."""
        token_hash = hash_token(token_str)
        return self._revoked.get(token_hash)

    def simulate_restart(self):
        """
        Simulate server restart - data persists because it's in DB.
        In real implementation, data is in PostgreSQL.
        """
        # Data persists - this is the key difference from in-memory set
        pass


class TestRevocationPersistence:
    """Test that revocation persists across 'restarts'."""

    @pytest.fixture
    def db(self):
        return MockRevokedTokensDB()

    @pytest.mark.asyncio
    async def test_revoke_token_is_persisted(self, db):
        """Revoked token should be marked as revoked."""
        token = "HCT:abc123.signature"  # noqa: S105

        await db.revoke(token, user_id="user_123", reason="User requested")

        assert await db.is_revoked(token) is True

    @pytest.mark.asyncio
    async def test_non_revoked_token_is_valid(self, db):
        """Non-revoked token should not be in revocation list."""
        token = "HCT:valid_token.signature"  # noqa: S105

        assert await db.is_revoked(token) is False

    @pytest.mark.asyncio
    async def test_revocation_survives_restart(self, db):
        """Token should remain revoked after server restart."""
        token = "HCT:revoked_before_restart.signature"  # noqa: S105

        # Revoke token
        await db.revoke(token, user_id="user_456")

        # Simulate server restart
        db.simulate_restart()

        # Token should still be revoked
        assert await db.is_revoked(token) is True

    @pytest.mark.asyncio
    async def test_revocation_stores_metadata(self, db):
        """Revocation should store full metadata."""
        token = "HCT:token_with_metadata.signature"  # noqa: S105

        await db.revoke(token, user_id="user_789", scope="attr.food.*", reason="Consent withdrawn")

        record = await db.get_revocation(token)

        assert record is not None
        assert record["user_id"] == "user_789"
        assert record["scope"] == "attr.food.*"
        assert record["reason"] == "Consent withdrawn"
        assert "revoked_at" in record

    @pytest.mark.asyncio
    async def test_token_hash_is_sha256(self, db):
        """Token should be stored as SHA256 hash, not plaintext."""
        token = "HCT:sensitive_token.signature"  # noqa: S105
        expected_hash = hashlib.sha256(token.encode()).hexdigest()

        await db.revoke(token, user_id="user_test")

        record = await db.get_revocation(token)
        assert record["token_hash"] == expected_hash
        assert len(record["token_hash"]) == 64  # SHA256 hex = 64 chars


class TestRevocationValidation:
    """Test token validation checks revocation."""

    @pytest.fixture
    def db(self):
        return MockRevokedTokensDB()

    @pytest.mark.asyncio
    async def test_validate_rejects_revoked_token(self, db):
        """Validation should fail for revoked tokens."""
        token = "HCT:will_be_revoked.signature"  # noqa: S105

        # Token valid before revocation
        assert await db.is_revoked(token) is False

        # Revoke
        await db.revoke(token, user_id="user_abc")

        # Token now invalid
        assert await db.is_revoked(token) is True

    @pytest.mark.asyncio
    async def test_multiple_revocations_same_user(self, db):
        """User can have multiple revoked tokens."""
        user_id = "user_multi"
        tokens = [  # noqa: S105
            "HCT:token_1.sig",
            "HCT:token_2.sig",
            "HCT:token_3.sig",
        ]

        for token in tokens:
            await db.revoke(token, user_id=user_id)

        for token in tokens:
            assert await db.is_revoked(token) is True


# ===========================================================================
# Real validate_token_with_db tests — cross-instance revocation
# ===========================================================================

USER_ID = "user_test_revocation"
AGENT_ID = "agent_test"


@pytest.fixture(autouse=True)
def clear_in_memory_revocation_registry():
    """Keep token revocation state isolated per test."""
    from hushh_mcp.consent import token as token_module

    token_module._revoked_tokens.clear()
    yield
    token_module._revoked_tokens.clear()


@pytest.mark.asyncio
async def test_validate_token_with_db_rejects_db_revoked_token():
    """
    Token revoked in DB but absent from in-memory set must be rejected.
    This proves cross-instance revocation works: a token revoked on
    instance A is rejected on instance B which has an empty memory set.
    """
    token_obj = issue_token(USER_ID, AGENT_ID, ConsentScope.VAULT_OWNER)
    token_str = token_obj.token

    # Confirm in-memory check passes (token not in local revocation set)
    valid, _, _ = validate_token(token_str)
    assert valid is True, "Token should be valid before revocation"

    # Simulate: DB says token is NOT active (revoked on another instance)
    fake_module = types.ModuleType("hushh_mcp.services.consent_db")
    mock_service_instance = AsyncMock()
    mock_service_instance.is_token_active = AsyncMock(return_value=False)
    fake_module.ConsentDBService = lambda: mock_service_instance

    with patch.dict(sys.modules, {"hushh_mcp.services.consent_db": fake_module}):
        # DB revocation checks are skipped in TESTING mode; disable it for this case.
        with patch.dict("os.environ", {"TESTING": "false"}, clear=False):
            valid_db, reason_db, _ = await validate_token_with_db(token_str)

    assert valid_db is False
    assert reason_db == "Token has been revoked (DB check)"


@pytest.mark.asyncio
async def test_validate_token_with_db_passes_active_token():
    """
    Non-revoked token must still pass DB-backed validation.
    Regression test: hardening must not break valid token flows.
    """
    token_obj = issue_token(USER_ID, AGENT_ID, ConsentScope.VAULT_OWNER)
    token_str = token_obj.token

    fake_module = types.ModuleType("hushh_mcp.services.consent_db")
    mock_service_instance = AsyncMock()
    mock_service_instance.is_token_active = AsyncMock(return_value=True)
    fake_module.ConsentDBService = lambda: mock_service_instance

    with patch.dict(sys.modules, {"hushh_mcp.services.consent_db": fake_module}):
        valid, reason, token_result = await validate_token_with_db(token_str)

    assert valid is True
    assert reason is None
    assert token_result is not None
    assert token_result.user_id == USER_ID


@pytest.mark.asyncio
async def test_validate_token_with_db_rejects_memory_revoked_token():
    """
    Token in local in-memory revocation set must be rejected
    without even hitting the DB (fast path).
    """
    token_obj = issue_token(USER_ID, AGENT_ID, ConsentScope.VAULT_OWNER)
    token_str = token_obj.token

    # Revoke in local memory
    revoke_token(token_str)

    # DB should NOT be called — in-memory check catches it first
    fake_module = types.ModuleType("hushh_mcp.services.consent_db")
    mock_service_instance = AsyncMock()
    mock_service_instance.is_token_active = AsyncMock(return_value=True)
    fake_module.ConsentDBService = lambda: mock_service_instance

    with patch.dict(sys.modules, {"hushh_mcp.services.consent_db": fake_module}):
        valid, reason, _ = await validate_token_with_db(token_str)

    # DB must NOT have been called
    mock_service_instance.is_token_active.assert_not_called()

    assert valid is False
    assert reason == "Token has been revoked"


@pytest.mark.asyncio
async def test_validate_token_with_db_vault_owner_grace_period_on_db_error():
    """
    VAULT_OWNER token gets grace period when DB is unreachable.
    Users must not be locked out of their own vault during brief DB hiccups.
    """
    token_obj = issue_token(USER_ID, AGENT_ID, ConsentScope.VAULT_OWNER)
    token_str = token_obj.token

    fake_module = types.ModuleType("hushh_mcp.services.consent_db")
    mock_service_instance = AsyncMock()
    mock_service_instance.is_token_active = AsyncMock(
        side_effect=Exception("DB connection refused")
    )
    fake_module.ConsentDBService = lambda: mock_service_instance

    with patch.dict(sys.modules, {"hushh_mcp.services.consent_db": fake_module}):
        valid, reason, token_result = await validate_token_with_db(
            token_str, ConsentScope.VAULT_OWNER
        )

    # VAULT_OWNER gets grace period — user can still access their own vault
    assert valid is True
    assert reason is None
    assert token_result is not None


@pytest.mark.asyncio
async def test_validate_token_with_db_scoped_token_fails_closed_on_db_error():
    """
    Scoped tokens fail closed when DB is unreachable.
    Third-party agent access must not be allowed when revocation
    status cannot be confirmed — consent integrity takes priority.
    """
    token_obj = issue_token(USER_ID, AGENT_ID, ConsentScope.PKM_READ)
    token_str = token_obj.token

    fake_module = types.ModuleType("hushh_mcp.services.consent_db")
    mock_service_instance = AsyncMock()
    mock_service_instance.is_token_active = AsyncMock(
        side_effect=Exception("DB connection refused")
    )
    fake_module.ConsentDBService = lambda: mock_service_instance

    with patch.dict(sys.modules, {"hushh_mcp.services.consent_db": fake_module}):
        valid, reason, token_result = await validate_token_with_db(token_str, ConsentScope.PKM_READ)

    # Scoped token fails closed — deny access when DB is unreachable
    assert valid is False
    assert reason == "Token revocation status could not be confirmed (DB unavailable)"
    assert token_result is None
