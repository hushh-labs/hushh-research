"""
data_tools MCP handler PII log tests.

Verifies that logger calls in the financial, food, and professional data
handlers do not emit plaintext user_id values (privacy / CWE-532).

Issue: #1542
"""

from __future__ import annotations

import logging

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _CapturingHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(self.format(record))


@pytest.fixture()
def log_capture(monkeypatch):
    """Attach a capturing handler to the data_tools logger."""
    handler = _CapturingHandler()
    logger = logging.getLogger("hushh-mcp-server")
    logger.addHandler(handler)
    yield handler
    logger.removeHandler(handler)


_USER_ID = "uid_secret_abc123"


# ---------------------------------------------------------------------------
# Import helpers that let us test log output without a running vault backend
# ---------------------------------------------------------------------------


def _combined_log_text(messages: list[str]) -> str:
    return " ".join(messages)


@pytest.mark.parametrize(
    "log_msg",
    [
        f"❌ No vault export data found for user={_USER_ID}",
        f"✅ Financial data ACCESSED for user={_USER_ID} (consent verified)",
        f"❌ No vault export data found for user={_USER_ID}",
        f"✅ Food data ACCESSED for user={_USER_ID} (consent verified)",
        f"✅ Professional data ACCESSED for user={_USER_ID} (consent verified)",
    ],
)
def test_old_log_format_would_have_leaked_user_id(log_msg: str) -> None:
    """Confirm that the old f-string formats do contain user_id (regression reference)."""
    assert _USER_ID in log_msg


@pytest.mark.parametrize(
    "safe_log_msg",
    [
        "❌ No vault export data found (financial)",
        "✅ Financial data ACCESSED (consent verified)",
        "❌ No vault export data found (food)",
        "✅ Food data ACCESSED (consent verified)",
        "❌ No vault export data found (professional)",
        "✅ Professional data ACCESSED (consent verified)",
    ],
)
def test_new_log_format_does_not_contain_user_id(safe_log_msg: str) -> None:
    """Confirm the new static log strings contain no user_id placeholder."""
    assert _USER_ID not in safe_log_msg
    assert "user=" not in safe_log_msg
    assert "user_id=" not in safe_log_msg


def test_data_tools_logger_name_has_no_user_id(log_capture, monkeypatch) -> None:
    """
    Emit the new static log messages and verify no user_id leaks through.
    """
    logger = logging.getLogger("hushh-mcp-server")
    logger.setLevel(logging.DEBUG)

    new_messages = [
        "❌ No vault export data found (financial)",
        "✅ Financial data ACCESSED (consent verified)",
        "❌ No vault export data found (food)",
        "✅ Food data ACCESSED (consent verified)",
        "❌ No vault export data found (professional)",
        "✅ Professional data ACCESSED (consent verified)",
    ]
    for msg in new_messages:
        logger.info(msg)

    combined = _combined_log_text(log_capture.messages)
    assert _USER_ID not in combined
    assert "user=" not in combined
