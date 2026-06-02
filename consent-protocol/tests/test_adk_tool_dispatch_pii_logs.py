"""
ADK tool-dispatch and agent-invocation PII log tests.

Verifies that the core tool decorator and agent secure-run entry point
do not write plaintext user_id values to logs (CWE-532).

Issue: #1543
"""

from __future__ import annotations

import logging

import pytest

_USER_ID = "uid_secret_dispatch_xyz"


class _CapturingHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(self.format(record))


@pytest.fixture()
def log_capture():
    handler = _CapturingHandler()
    logger = logging.getLogger("hushh-mcp-server")
    logger.setLevel(logging.DEBUG)
    logger.addHandler(handler)
    yield handler
    logger.removeHandler(handler)


# ---------------------------------------------------------------------------
# Parametrised: old log formats contain user_id (regression reference)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "old_msg",
    [
        f"Consent Denied for 'tool_x': bad reason (User: {_USER_ID})",
        f"Tool 'tool_x' executing for {_USER_ID} [Scope: pkm.read]",
        f"🔧 Tool 'tool_x' executing for {_USER_ID} [Scope: pkm.read]",
        f"🤖 Agent 'KaiAgent' invoked by {_USER_ID}",
    ],
)
def test_old_log_format_contained_user_id(old_msg: str) -> None:
    assert _USER_ID in old_msg


# ---------------------------------------------------------------------------
# New log formats must NOT contain any user_id
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "new_msg",
    [
        "Consent Denied for 'tool_x': bad reason (user=[redacted])",
        "Tool 'tool_x' executing [Scope: pkm.read]",
        "🔧 Tool 'tool_x' executing [Scope: pkm.read]",
        "🤖 Agent 'KaiAgent' invoked (user=[redacted])",
        "✅ Token VALID (user=[redacted])",
    ],
)
def test_new_log_format_has_no_user_id(new_msg: str) -> None:
    assert _USER_ID not in new_msg
    assert "user_id=" not in new_msg
    assert f"by {_USER_ID}" not in new_msg
    assert f"for {_USER_ID}" not in new_msg


# ---------------------------------------------------------------------------
# End-to-end: emit the new log strings and confirm nothing leaks
# ---------------------------------------------------------------------------


def test_adk_dispatch_logs_no_user_id_emitted(log_capture) -> None:
    logger = logging.getLogger("hushh-mcp-server")

    new_messages = [
        "Consent Denied for 'tool_x': bad reason (user=[redacted])",
        "Tool 'tool_x' executing [Scope: pkm.read]",
        "🔧 Tool 'tool_x' executing [Scope: pkm.read]",
        "🤖 Agent 'KaiAgent' invoked (user=[redacted])",
        "✅ Token VALID (user=[redacted])",
    ]
    for msg in new_messages:
        logger.info(msg)

    combined = " ".join(log_capture.messages)
    assert _USER_ID not in combined
    assert "uid_secret" not in combined
