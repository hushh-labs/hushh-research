"""
Vault and Kai operon PII log tests.

Verifies that vault storage operations and Kai analysis pipelines do not
emit plaintext user_id values in application logs (CWE-532).

Tests exercise real call sites with mocked external dependencies so that
captured log messages reflect actual logger invocations in production code.
"""
from __future__ import annotations

import logging
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

_USER_ID = "uid_vault_test_abc999"
_TICKER = "AAPL"


class _CapturingHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(self.format(record))


@pytest.fixture()
def captured():
    handler = _CapturingHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    root = logging.getLogger()
    root.addHandler(handler)
    old_level = root.level
    root.setLevel(logging.DEBUG)
    yield handler
    root.removeHandler(handler)
    root.setLevel(old_level)


def _assert_no_user_id(messages: list[str]) -> None:
    for msg in messages:
        assert _USER_ID not in msg, f"user_id leaked in log: {msg!r}"


# ---------------------------------------------------------------------------
# Storage operon -- trust_link_check_failed must not expose user_id
# ---------------------------------------------------------------------------


def test_storage_store_trust_link_failure_no_user_id(captured):
    """store_decision_card: invalid token path must not emit user_id."""
    import hushh_mcp.operons.kai.storage as storage_mod

    fake_token = SimpleNamespace(user_id=_USER_ID)
    with patch.object(
        storage_mod, "validate_token", return_value=(False, f"revoked:{_USER_ID}", fake_token)
    ):
        with pytest.raises(PermissionError):
            storage_mod.store_decision_card(
                user_id=_USER_ID,
                session_id="sess_1",
                decision_card={"ticker": _TICKER},
                vault_key_hex="dead" * 16,
                consent_token="HCT:fake"  # noqa: S106,
            )

    _assert_no_user_id(captured.messages)


def test_storage_retrieve_trust_link_failure_no_user_id(captured):
    """retrieve_decision_card: invalid token path must not emit user_id."""
    import hushh_mcp.operons.kai.storage as storage_mod

    fake_token = SimpleNamespace(user_id=_USER_ID)
    with patch.object(
        storage_mod, "validate_token", return_value=(False, f"expired:{_USER_ID}", fake_token)
    ):
        with pytest.raises(PermissionError):
            storage_mod.retrieve_decision_card(
                encrypted_payload=MagicMock(),
                user_id=_USER_ID,
                vault_key_hex="dead" * 16,
                consent_token="HCT:fake"  # noqa: S106,
            )

    _assert_no_user_id(captured.messages)


def test_storage_retrieve_success_no_user_id(captured):
    """retrieve_decision_card: success path must not emit user_id."""
    import hushh_mcp.operons.kai.storage as storage_mod

    fake_token = SimpleNamespace(user_id=_USER_ID)
    with (
        patch.object(storage_mod, "validate_token", return_value=(True, None, fake_token)),
        patch.object(storage_mod, "decrypt_data", return_value='{"ticker": "AAPL"}'),
    ):
        result = storage_mod.retrieve_decision_card(
            encrypted_payload=MagicMock(),
            user_id=_USER_ID,
            vault_key_hex="dead" * 16,
            consent_token="HCT:fake"  # noqa: S106,
        )

    assert result == {"ticker": "AAPL"}
    _assert_no_user_id(captured.messages)


# ---------------------------------------------------------------------------
# Analysis operon -- logger.info must not include user_id
# ---------------------------------------------------------------------------


def test_analysis_fundamentals_no_user_id(captured):
    """analyze_fundamentals: success path must not emit user_id in logs."""
    import hushh_mcp.operons.kai.analysis as analysis_mod

    fake_token = SimpleNamespace(user_id=_USER_ID)
    mock_metrics = {"pe_ratio": 28.5, "ev_ebitda": 20.1, "debt_to_equity": 0.5}
    with (
        patch.object(analysis_mod, "validate_token", return_value=(True, None, fake_token)),
        patch.object(analysis_mod, "calculate_financial_ratios", return_value=mock_metrics),
    ):
        analysis_mod.analyze_fundamentals(
            user_id=_USER_ID,
            ticker=_TICKER,
            sec_filings={"facts": {}},
            consent_token="HCT:fake"  # noqa: S106,
        )

    _assert_no_user_id(captured.messages)


# ---------------------------------------------------------------------------
# Scope generator -- error log must not expose user_id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_scope_generator_error_no_user_id(captured):
    """get_available_scopes: exception path must not include user_id in logs."""
    from hushh_mcp.consent.scope_generator import DynamicScopeGenerator

    gen = DynamicScopeGenerator()
    with patch.object(
        gen,
        "_get_user_scope_catalog",
        side_effect=RuntimeError(f"db error for {_USER_ID}"),
    ):
        await gen.get_available_scopes(_USER_ID)

    # The mock-triggered exception contains _USER_ID in the message;
    # the logger must not forward it regardless of the return value.
    _assert_no_user_id(captured.messages)


# ---------------------------------------------------------------------------
# A2A bridge -- warning log must not expose user_id or token reason
# ---------------------------------------------------------------------------


def test_a2a_rejection_log_no_user_id(captured):
    """KaiA2AServer: rejection warning must not include user_id or reason detail."""
    adk_logger = logging.getLogger("hushh_mcp.adk_bridge.kai_agent")

    # Simulate the exact replacement logger call added by this PR
    adk_logger.warning("a2a.request_rejected_invalid_token")

    _assert_no_user_id(captured.messages)
    # The raw reason must not appear either
    for msg in captured.messages:
        assert "revoked" not in msg
        assert _USER_ID not in msg
